/**
 * Companion to scripts/demo-node-red-apis.sh.
 * Exercises the same core HTTP operations through structured A2A SendMessage.
 *
 * Runs against a bridge + already-running AaaS backend:
 *   A2A_URL=http://127.0.0.1:3105 A2A_AUTH_TOKEN=... node scripts/poc-a2a/demo.mjs
 *   A2A_DEMO_AGENT=1   # also exercises real agent turn; requires provider/model access
 */
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { OPERATIONS } from './bridge.mjs';

const base = process.env.A2A_URL ?? 'http://127.0.0.1:3105';
const token = process.env.A2A_AUTH_TOKEN;
const useAgent = process.env.A2A_DEMO_AGENT === '1';
const timeoutMs = Number(process.env.RUN_TIMEOUT ?? 180) * 1000;
if (!token) { console.error('A2A_AUTH_TOKEN required'); process.exit(2); }
const calls = new Set();
let expectedOperations;
const created = { projects: [], workflows: [], conversations: [], runs: [] };

async function http(path, { method = 'GET', body } = {}) {
  const result = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/a2a+json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  let data;
  try { data = await result.json(); } catch { throw new Error(`Non-JSON A2A result (${result.status} ${path})`); }
  return { status: result.status, data };
}

async function command(operation, args = {}, expected = 200, context = {}) {
  assert(Object.hasOwn(OPERATIONS, operation), `Not in catalog: ${operation}`);
  const payload = {
    message: {
      messageId: randomUUID(), role: 'ROLE_USER',
      parts: [{ data: { operation, ...args } }],
      ...(context.taskId ? { taskId: context.taskId } : {}),
      ...(context.contextId ? { contextId: context.contextId } : {}),
    },
    configuration: { returnImmediately: true },
  };
  const res = await http('/message:send', { method: 'POST', body: payload });
  if (expected >= 400) {
    assert.equal(res.status, expected, `${operation}: expected A2A HTTP ${expected}, got ${res.status}\n${JSON.stringify(res.data)}`);
    assert.equal(res.data.error?.data?.upstreamStatus, expected, `${operation}: expected upstream error preserved`);
    calls.add(operation);
    console.log(`  ${operation}: backend ${expected} → A2A error (expected)`);
    return res.data.error;
  }
  assert.equal(res.status, 200, `${operation}: ${JSON.stringify(res.data)}`);
  assert(res.data.message || res.data.task, `${operation}: A2A response is not a message or task`);
  calls.add(operation);
  if (res.data.task) {
    console.log(`  ${operation}: A2A task ${res.data.task.id} (${res.data.task.status.state})`);
    return res.data.task;
  }
  const part = res.data.message.parts?.[0]?.data;
  assert.equal(part?.operation, operation);
  assert(part.upstreamStatus < 400, `${operation}: unexpected upstream ${part?.upstreamStatus}`);
  console.log(`  ${operation}: HTTP ${part.upstreamStatus} → A2A direct message`);
  return part.result;
}

async function waitTask(id, expected) {
  const deadline = Date.now() + timeoutMs;
  const terminal = new Set(['TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']);
  while (Date.now() < deadline) {
    const res = await http(`/tasks/${encodeURIComponent(id)}`);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const state = res.data.status?.state;
    if (state === expected) return res.data;
    if (terminal.has(state) || (state === 'TASK_STATE_COMPLETED' && expected !== state)) {
      throw new Error(`Task ${id} reached unexpected ${state}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${id} to reach ${expected}`);
}

async function safeCleanup() {
  // All cleanup STILL goes via structured SendMessage; avoid masking primary failure.
  for (const id of [...created.conversations].reverse()) {
    try { await command('deleteConversation', { parameters: { conversationId: id } }); } catch (e) { console.error(`cleanup conversation ${id}: ${e.message}`); }
  }
  for (const id of [...created.runs].reverse()) {
    try { await command('deleteRun', { parameters: { runId: id } }); } catch (e) { console.error(`cleanup run ${id}: ${e.message}`); }
  }
  for (const id of [...created.workflows].reverse()) {
    try { await command('deleteWorkflow', { parameters: { workflowId: id } }); } catch (e) { console.error(`cleanup workflow ${id}: ${e.message}`); }
  }
  for (const id of [...created.projects].reverse()) {
    try { await command('deleteProject', { parameters: { projectId: id } }); } catch (e) { console.error(`cleanup project ${id}: ${e.message}`); }
  }
}

async function walkthrough() {
  const card = await http('/.well-known/agent-card.json', { method: 'GET' });
  // Agent Card is public in A2A: endpoint above requires no auth, but sending it doesn't hurt.
  assert.equal(card.status, 200);
  assert.equal(card.data.supportedInterfaces?.[0]?.protocolBinding, 'HTTP+JSON');
  console.log(`Agent: ${card.data.name} (experimental)`);

  await command('getHealth');
  await command('getStatus');
  const openapi = await command('getOpenApiDocument');
  const expected = new Set(Object.values(openapi.paths ?? {}).flatMap(path => Object.values(path ?? {}).map(method => method?.operationId).filter(Boolean)));
  assert.deepEqual([...expected].sort(), Object.keys(OPERATIONS).sort(), 'Dispatcher catalog drift from live OpenAPI');
  expectedOperations = expected;

  const project = await command('createProject', { body: { name: 'A2A dispatcher PoC' } });
  created.projects.push(project.id);
  await command('listProjects');
  await command('getProject', { parameters: { projectId: project.id } });
  await command('updateProject', { parameters: { projectId: project.id }, body: { name: 'A2A dispatcher renamed' } });

  const definition = {
    name: 'Multiply', engine: 'node-red',
    specification: { entry: 'entry', flows: [
      { id: 'tab', type: 'tab', label: 'Multiply' },
      { id: 'entry', z: 'tab', type: 'link in', x: 100, y: 100, wires: [['multiply']] },
      { id: 'multiply', z: 'tab', type: 'function', x: 250, y: 100, outputs: 1,
        func: 'msg.payload=msg.input.a*msg.input.b;return msg;', wires: [['native-return']] },
      { id: 'native-return', z: 'tab', type: 'link out', x: 400, y: 100, mode: 'return', links: [], wires: [] },
    ] },
  };
  const checked = await command('validateWorkflow', { body: { engine: definition.engine, specification: definition.specification } });
  assert.equal(checked.valid, true);
  const workflow = await command('createWorkflow', { body: definition });
  created.workflows.push(workflow.id);
  await command('listWorkflows');
  await command('getWorkflow', { parameters: { workflowId: workflow.id } });
  await command('updateWorkflow', { parameters: { workflowId: workflow.id }, body: { ...definition, name: 'Multiply v2' } });

  const native = await command('startRun', { body: {
    target: { kind: 'workflow', id: workflow.id }, projectId: project.id, input: { a: 13.75, b: -8 },
  } });
  created.runs.push(native.id);
  await waitTask(native.id, 'TASK_STATE_COMPLETED');
  const nativeDetail = await command('getRun', { parameters: { runId: native.id } });
  assert.equal(nativeDetail.run.output, -110);
  assert.equal(nativeDetail.run.workflowVersion, 2);
  const nativeTask = await http(`/tasks/${encodeURIComponent(native.id)}`);
  assert.equal(nativeTask.data.artifacts?.[0]?.parts?.[0]?.data, -110);
  await command('listRuns', { query: { projectId: project.id } });
  await command('listEvents', { parameters: { runId: native.id }, query: { after: 0 } });
  await command('resumeRun', { parameters: { runId: native.id }, body: {} }, 409);
  await command('streamRunEvents', { parameters: { runId: native.id } }, 501);
  await command('listArtifacts', { parameters: { runId: native.id } }, 501);
  await command('getArtifact', { parameters: { runId: native.id, artifactId: 'demo-artifact' } }, 501);

  const human = structuredClone(definition);
  human.name = 'Approval';
  human.specification.flows[1].wires = [['human']];
  human.specification.flows[2].func = 'msg.payload={decision:msg.interaction.decision,text:msg.interaction.text,input:msg.input};return msg;';
  human.specification.flows.push({ id: 'human', z: 'tab', type: 'interaction', x: 175, y: 100,
    name: 'Approve', prompt: 'Continue A2A demo?', promptType: 'str',
    decisions: [{ id: 'approve', label: 'Approve' }], wires: [['multiply']],
  });
  const humanWf = await command('createWorkflow', { body: human });
  created.workflows.push(humanWf.id);
  const humanStart = { target: { kind: 'workflow', id: humanWf.id }, projectId: project.id, input: { proof: 'input survives' } };
  const pending = await command('startRun', { body: humanStart });
  created.runs.push(pending.id);
  const awaiting = await waitTask(pending.id, 'TASK_STATE_INPUT_REQUIRED');
  assert.equal(awaiting.status.state, 'TASK_STATE_INPUT_REQUIRED');
  const inbox = await command('listPendingInteractions', { query: { projectId: project.id } });
  const interaction = inbox.items.find(x => x.runId === pending.id);
  assert(interaction, 'Approval did not show up in AaaS interaction inbox');
  const answered = await command('submitInteractionDecision', {
    parameters: { interactionId: interaction.id }, body: { decision: 'approve', comment: 'Continue checkpoint' },
  }, 200, { taskId: pending.id, contextId: pending.contextId });
  assert.equal(answered.id, pending.id, 'Continuation must not create another Task');
  await waitTask(pending.id, 'TASK_STATE_COMPLETED');
  const completed = await command('getRun', { parameters: { runId: pending.id } });
  assert.equal(completed.run.output.decision, 'approve');
  assert.equal(completed.run.output.input.proof, 'input survives');

  const toCancel = await command('startRun', { body: humanStart });
  created.runs.push(toCancel.id);
  await waitTask(toCancel.id, 'TASK_STATE_INPUT_REQUIRED');
  const cancelled = await command('cancelRun', { parameters: { runId: toCancel.id }, body: { reason: 'PoC structured command' } });
  assert.equal(cancelled.run.status, 'cancelled');
  const cancelledTask = await http(`/tasks/${encodeURIComponent(toCancel.id)}`);
  assert.equal(cancelledTask.data.status.state, 'TASK_STATE_CANCELED');
  // Native A2A CancelTask is tested separately by tests.mjs.

  const convo = await command('createConversation', { body: { title: 'A2A PoC conversation', projectId: project.id } });
  created.conversations.push(convo.id);
  await command('listConversations', { query: { projectId: project.id } });
  await command('getConversation', { parameters: { conversationId: convo.id } });
  await command('updateConversation', { parameters: { conversationId: convo.id }, body: { title: 'Renamed A2A PoC conversation' } });
  if (useAgent) {
    const chat = await command('sendMessage', { parameters: { conversationId: convo.id }, body: {
      content: 'Reply with a short greeting. Do not use tools.',
    } });
    created.runs.push(chat.id);
    await waitTask(chat.id, 'TASK_STATE_COMPLETED');
    const history = await command('listMessages', { parameters: { conversationId: convo.id } });
    assert.equal(history.items.filter(m => m.role === 'user').length, 1);
    assert.equal(history.items.filter(m => m.role === 'assistant').length, 1);
  } else {
    await command('listMessages', { parameters: { conversationId: convo.id } });
    console.log('  sendMessage: SKIPPED (set A2A_DEMO_AGENT=1 for model-dependent step)');
  }
  await command('streamConversationEvents', { parameters: { conversationId: convo.id } }, 501);
}

try {
  await walkthrough();
} catch (e) {
  console.error(`A2A PoC failed: ${e.stack ?? e}`);
  process.exitCode = 1;
} finally {
  await safeCleanup();
  if (expectedOperations) {
    const missing = [...expectedOperations].filter(x => !calls.has(x));
    console.log(`\nObserved: ${calls.size}/${expectedOperations.size} catalog operations via structured A2A SendMessage.`);
    if (missing.length) console.log(`Not exercised: ${missing.join(', ')}`);
    if (useAgent && missing.length) {
      console.error('Full provider-backed run failed to exercise the complete catalog');
      process.exitCode = 1;
    }
  }
}
