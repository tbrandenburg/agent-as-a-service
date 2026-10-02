const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { mkdtemp, writeFile, rm, readFile, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const RED = require('node-red');
const { createHostLinkCaller } = require('./link-call.cjs');

const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));
const close = (server) => new Promise((done) => server.close(done));
const flow = [
  { id: 'native', type: 'tab', label: 'Native fixture' },
  { id: 'entry', z: 'native', type: 'link in', wires: [['work']] },
  { id: 'work', z: 'native', type: 'function', outputs: 1,
    func: "msg.payload='working'; if(msg.input?.mode==='error') {node.error('fixture failure',msg);return null;} if(msg.input?.mode==='wait') return null; if(msg.input?.mode==='multiple'){msg.payload='first';node.send(msg);msg.payload='second';node.send(msg);node.done();return;} const input=msg.input; setTimeout(()=>{msg.payload=input?.output ?? JSON.stringify(input); msg.runId='forged';msg.status='failed';node.send(msg);node.done();},input?.delay||0);return;", wires: [['native-return']] },
  { id: 'native-return', z: 'native', type: 'link out', mode: 'return', wires: [] },
  { id: 'empty', z: 'native', type: 'link in', wires: [['sink']] },
  { id: 'sink', z: 'native', type: 'function', func: 'return null;', outputs: 1, wires: [[]] },
];

test('Node-RED 5.0.7 native Link Call: generic values, cloning, correlation, first return, missing target, timeout and cleanup', { timeout: 30000 }, async () => {
  assert.equal(require('node-red/package.json').version, '5.0.7');
  const dir = await mkdtemp(join(tmpdir(), 'aaas-native-'));
  const server = http.createServer();
  let caller;
  try {
    await writeFile(join(dir, 'flows.json'), JSON.stringify(flow));
    RED.init(server, { userDir: dir, flowFile: join(dir, 'flows.json'), httpAdminRoot: false, logging: { console: { level: 'off' } } });
    await RED.start();
    while (!RED.nodes.getNode('entry')) await new Promise((done) => setTimeout(done, 50));
    caller = createHostLinkCaller(RED);
    for (const input of ['string', 42, false, null, [1, true, null, { nested: ['x', 2.5] }], { repository: 'acme/example', branch: 'feature/link-call', limit: 3, enabled: true, flags: { includeTests: true }, items: ['a', 'b'] }, [{ type: 'text', text: 'part' }]]) {
      const original = { input, agentObservation: { runId: 'control' } };
      const returned = await caller.call('entry', original);
      assert.deepEqual(returned.input, input);
      assert.equal(returned.payload, JSON.stringify(input));
      assert.equal(original.payload, undefined);
      assert.equal(original._linkSource, undefined);
      assert.equal(returned._linkSource, undefined);
      assert.equal(returned.runId, 'forged');
    }
    const results = await Promise.all([caller.call('entry', { input: { output: 'slow', delay: 50 } }), caller.call('entry', { input: { output: 'fast' } })]);
    assert.deepEqual(results.map((msg) => msg.payload), ['slow', 'fast']);
    assert.equal((await caller.call('entry', { input: { mode: 'multiple' } })).payload, 'first');
    await assert.rejects(caller.call('missing', {}), /not found/);
    await assert.rejects(caller.call('empty', {}, { timeout: 30 }), /timed out/);
    await assert.rejects(caller.call('entry', { input: { mode: 'wait' } }, { timeout: 30 }), /timed out/);
    const pending = caller.call('entry', { input: { mode: 'wait' } });
    const rejected = assert.rejects(pending, /closed/);
    caller.close();
    await rejected;
    // A fresh caller after cleanup still returns, without stale host hooks interfering.
    caller = createHostLinkCaller(RED);
    assert.equal((await caller.call('entry', { input: { output: 'after cleanup' } })).payload, 'after cleanup');
  } finally {
    caller?.close();
    await RED.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('real worker host: multitab/subflow, authenticated async 202, authoritative run ID, JSON output, failures and shutdown', { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aaas-host-'));
  const finals = [];
  const callback = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (request.url === '/finalize') finals.push(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  const callbackPort = await listen(callback);
  const schema = join(root, 'schema.cjs');
  execFileSync(resolve(__dirname, 'node_modules/.bin/esbuild'), [process.env.CONTRACT_SCHEMA_SOURCE || resolve(__dirname, '../../../packages/contract/src/v1/schemas/domain.ts'), '--bundle', '--platform=node', '--format=cjs', `--outfile=${schema}`], { env: { ...process.env, NODE_PATH: resolve(__dirname, 'node_modules') } });
  const children = new Set();
  async function worker(id, input, target = 'entry', crash = false, snapshot = flow) {
    const dir = join(root, id);
    await require('node:fs/promises').mkdir(dir);
    await symlink(join(__dirname, 'node_modules'), join(dir, 'node_modules'));
    await writeFile(join(dir, 'flows.json'), JSON.stringify(snapshot));
    await writeFile(join(dir, 'settings.js'), `module.exports={flowFile:'flows.json',fileWorkingDirectory:${JSON.stringify(dir)},nodesDir:${JSON.stringify(join(__dirname, 'cwd-list'))},logging:{console:{level:'off'}}};`);
    const reservation = http.createServer();
    const port = await listen(reservation);
    await close(reservation);
    const child = spawn(process.execPath, [join(__dirname, 'worker-host.js'), dir, String(port), id], { cwd: dir, env: { ...process.env, WORKER_CWD: dir, INTERNAL_TOKEN: 'test-internal', NODE_RED_MODULES: '/usr/src/node-red/node_modules', LINK_CALL_MODULE: join(__dirname, 'link-call.cjs'), RUN_SCHEMA_MODULE: schema, WORKER_CALLBACK_URL: `http://127.0.0.1:${callbackPort}`, WORKER_TIMEOUT_MS: '1800', DEFAULT_MODEL: 'github-copilot/gpt-6-luna' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let logs = '';
    child.stdout.on('data', (data) => { logs += data; });
    child.stderr.on('data', (data) => { logs += data; });
    const post = (body, token = 'test-internal') => fetch(`http://127.0.0.1:${port}/invoke`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const deadline = Date.now() + 10000;
    while (true) {
      try { assert.equal((await post({}, 'wrong')).status, 401); break; }
      catch (error) { if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Worker startup: ${logs}`, { cause: error }); await new Promise((done) => setTimeout(done, 50)); }
    }
    assert.equal((await post({ runId: 'other', entry: target, input })).status, 400);
    assert.equal((await post({ runId: id, target, input })).status, 400);
    const before = Date.now();
    assert.equal((await post({ runId: id, entry: target, input })).status, 202);
    assert.ok(Date.now() - before < 1000, 'dispatch must not wait for workflow');
    assert.equal((await post({ runId: id, entry: target, input })).status, 409);
    if (crash) {
      const exit = new Promise((done) => child.once('exit', done));
      child.kill('SIGKILL');
      await exit;
      children.delete(child);
      return;
    }
    while (!finals.some((value) => value.runId === id)) {
      if (Date.now() > deadline) throw new Error(`Finalization timeout: ${logs}`);
      await new Promise((done) => setTimeout(done, 20));
    }
    const exit = new Promise((done) => child.once('exit', done));
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exit;
    clearTimeout(force);
    children.delete(child);
    if (id === 'cwd') assert.equal(await readFile(join(dir, 'cwd-proof.txt'), 'utf8'), input.text);
    return finals.find((value) => value.runId === id);
  }
  try {
    const multitab = require('./native-fixtures.cjs').multiply.specification;
    const multiplication = await worker('multitab', { a: 13.75, b: -8 }, multitab.entry, false, multitab.flows);
    assert.equal(multiplication.status, 'completed');
    assert.equal(multiplication.output, -110);
    assert.deepEqual(await worker('string', { output: 'ok', delay: 200 }), { runId: 'string', eventId: 'string:link-call', status: 'completed', output: 'ok' });
    const parts = [{ type: 'text', text: 'reply' }, { type: 'data', data: { count: 3 } }];
    assert.deepEqual((await worker('parts', { output: parts })).output, parts);
    for (const [id, input, target] of [['error', { mode: 'error' }], ['timeout', { mode: 'wait' }], ['missing', {}, 'absent'], ['unreachable', {}, 'empty']])
      assert.equal((await worker(id, input, target)).status, 'failed');
    const echo = flow.map((node) => node.id === 'work' ? { ...node, func: 'msg.payload=msg.input;return msg;' } : node);
    const object = flow.map((node) => node.id === 'work' ? { ...node, func: "msg.payload={result:-110,nested:[true,null]};return msg;" } : node);
    assert.deepEqual((await worker('vm-object', {}, 'entry', false, object)).output, { result: -110, nested: [true, null] });
    for (const [index, input] of ['raw string', 42, false, null, { nested: [true] }, [1, true, null, { nested: ['x', 2.5] }]].entries()) {
      const result = await worker(`json-${index}`, input, 'entry', false, echo);
      assert.equal(result.status, 'completed');
      assert.deepEqual(result.output, input);
    }
    for (const [index, expression] of ["Buffer.from('x')", 'function(){}', 'undefined', 'NaN', '(()=>{const a={};a.self=a;return a;})()'].entries()) {
      const invalid = flow.map((node) => node.id === 'work' ? { ...node, func: `msg.payload=${expression};return msg;` } : node);
      assert.equal((await worker(`non-json-${index}`, {}, 'entry', false, invalid)).status, 'failed');
    }
    await worker('crash', { mode: 'wait' }, 'entry', true);
    assert.equal(finals.some((value) => value.runId === 'crash'), false);
    const cwd = JSON.parse(await readFile(join(__dirname, 'fixtures/cwd.json'), 'utf8'));
    assert.equal((await worker('cwd', { text: 'exact original prompt' }, 'cwd-in', false, cwd)).output, 'exact original prompt');
  } finally {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exit = new Promise((done) => child.once('exit', done));
      child.kill('SIGKILL'); await exit;
    }
    await close(callback);
    await rm(root, { recursive: true, force: true });
  }
});
