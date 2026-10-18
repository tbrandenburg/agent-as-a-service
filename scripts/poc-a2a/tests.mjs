import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createBridge, OPERATIONS } from './bridge.mjs';

function start(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
function stop(server) { return new Promise(resolve => server.close(resolve)); }
const endpoints = {
  listConversations: ['GET', '/conversations'], createConversation: ['POST', '/conversations'],
  getConversation: ['GET', '/conversations/{conversationId}'], updateConversation: ['PATCH', '/conversations/{conversationId}'],
  deleteConversation: ['DELETE', '/conversations/{conversationId}'], streamConversationEvents: ['GET', '/conversations/{conversationId}/events/stream'],
  listMessages: ['GET', '/conversations/{conversationId}/messages'], sendMessage: ['POST', '/conversations/{conversationId}/messages'],
  getHealth: ['GET', '/health'], listPendingInteractions: ['GET', '/interactions'],
  submitInteractionDecision: ['POST', '/interactions/{interactionId}/decisions'], getOpenApiDocument: ['GET', '/openapi.json'],
  listProjects: ['GET', '/projects'], createProject: ['POST', '/projects'], getProject: ['GET', '/projects/{projectId}'],
  updateProject: ['PATCH', '/projects/{projectId}'], deleteProject: ['DELETE', '/projects/{projectId}'],
  listRuns: ['GET', '/runs'], startRun: ['POST', '/runs'], getRun: ['GET', '/runs/{runId}'],
  deleteRun: ['DELETE', '/runs/{runId}'], listArtifacts: ['GET', '/runs/{runId}/artifacts'],
  getArtifact: ['GET', '/runs/{runId}/artifacts/{artifactId}'], cancelRun: ['POST', '/runs/{runId}/cancel'],
  listEvents: ['GET', '/runs/{runId}/events'], streamRunEvents: ['GET', '/runs/{runId}/events/stream'],
  resumeRun: ['POST', '/runs/{runId}/resume'], getStatus: ['GET', '/status'],
  listWorkflows: ['GET', '/workflows'], createWorkflow: ['POST', '/workflows'], getWorkflow: ['GET', '/workflows/{workflowId}'],
  updateWorkflow: ['PUT', '/workflows/{workflowId}'], deleteWorkflow: ['DELETE', '/workflows/{workflowId}'],
  validateWorkflow: ['POST', '/workflows/validate'],
};

test('catalog, structured dispatch, A2A Task, approval, cancellation and safety', async () => {
  assert.equal(Object.keys(OPERATIONS).length, 34);
  assert.deepEqual(Object.fromEntries(Object.entries(OPERATIONS).map(([k, v]) => [k, [v.method, v.path]])), endpoints);
  const history = [];
  let runStatus = 'paused';
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    history.push({ method: req.method, url: req.url, auth: req.headers.authorization, idempotency: req.headers['idempotency-key'], body });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer fake-token') { res.statusCode = 401; return res.end(JSON.stringify({ error: { code: 'unauthorized' } })); }
    if (req.method === 'GET' && req.url === '/api/v1/workflows') return res.end(JSON.stringify({ items: [{ id: 'w1' }] }));
    if (req.method === 'POST' && req.url === '/api/v1/runs') { res.statusCode = 202; return res.end(JSON.stringify({ run: { id: 'run-1', status: runStatus } })); }
    if (req.method === 'GET' && req.url === '/api/v1/runs/run-1') return res.end(JSON.stringify({ run: { id: 'run-1', status: runStatus, ...(runStatus === 'completed' ? { output: 42 } : {}) } }));
    if (req.method === 'POST' && req.url === '/api/v1/interactions/i1/decisions') { runStatus = 'completed'; return res.end(JSON.stringify({ run: { id: 'run-1', status: runStatus } })); }
    if (req.method === 'POST' && req.url === '/api/v1/runs/run-1/cancel') { runStatus = 'cancelled'; return res.end(JSON.stringify({ run: { id: 'run-1', status: runStatus } })); }
    if (req.method === 'GET' && req.url === '/api/v1/runs') return res.end(JSON.stringify({ items: [{ id: 'run-1', status: runStatus }] }));
    if (req.method === 'GET' && req.url === '/api/v1/runs/run-1/artifacts') { res.statusCode = 501; return res.end(JSON.stringify({ error: { code: 'not_implemented', message: 'Artifact listing unsupported' } })); }
    res.statusCode = 404; return res.end(JSON.stringify({ error: { code: 'not_found', message: 'Not available in mock' } }));
  });
  const upstreamBase = await start(upstream);
  const bridge = createBridge({ upstream: `${upstreamBase}/api/v1` });
  const api = await start(bridge);
  async function call(path, method = 'GET', body, token = 'fake-token') {
    const resp = await fetch(`${api}${path}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/a2a+json' },
      body: body ? JSON.stringify(body) : undefined });
    return { code: resp.status, result: await resp.json() };
  }
  function msg(data, extra = {}) {
    return { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data }], ...extra }, configuration: { returnImmediately: true } };
  }
  try {
    const card = await call('/.well-known/agent-card.json');
    assert.equal(card.code, 200);
    assert.equal(card.result.supportedInterfaces[0].protocolBinding, 'HTTP+JSON');
    const workflows = await call('/message:send', 'POST', msg({ operation: 'listWorkflows' }));
    assert.equal(workflows.code, 200);
    assert.equal(workflows.result.message.parts[0].data.result.items[0].id, 'w1');
    const started = await call('/message:send', 'POST', msg({ operation: 'startRun', body: { target: { kind: 'workflow', id: 'w1' } }, idempotencyKey: 'a-key' }));
    assert.equal(started.code, 200);
    assert.equal(started.result.task.id, 'run-1');
    assert.equal(started.result.task.status.state, 'TASK_STATE_INPUT_REQUIRED');
    assert.equal(history.at(-1).idempotency, 'a-key');
    const pending = await call('/tasks/run-1');
    assert.equal(pending.result.status.state, 'TASK_STATE_INPUT_REQUIRED');
    const mismatched = await call('/message:send', 'POST', msg({ operation: 'submitInteractionDecision', parameters: { interactionId: 'i1' }, body: { decision: 'approve' } }, { taskId: 'run-1', contextId: 'not-the-task-context' }));
    assert.equal(mismatched.code, 400);
    const granted = await call('/message:send', 'POST', msg({ operation: 'submitInteractionDecision', parameters: { interactionId: 'i1' }, body: { decision: 'approve' } }, { taskId: 'run-1', contextId: started.result.task.contextId }));
    assert.equal(granted.result.task.id, 'run-1');
    const completed = await call('/tasks/run-1');
    assert.equal(completed.result.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(completed.result.artifacts[0].parts[0].data, 42);
    const forbidden = await call('/message:send', 'POST', msg({ operation: 'getProject', parameters: { projectId: '../other' } }));
    assert.equal(forbidden.code, 404); // path segment encoded and reaches only known operation
    assert(history.at(-1).url.includes('%2F'), 'path parameter must not escape its segment');
    const unknown = await call('/message:send', 'POST', msg({ operation: 'GET http://evil.example/' }));
    assert.equal(unknown.code, 400);
    const missing = await call('/message:send', 'POST', msg({ operation: 'getProject' }));
    assert.equal(missing.code, 400);
    const artifacts = await call('/message:send', 'POST', msg({ operation: 'listArtifacts', parameters: { runId: 'run-1' } }));
    assert.equal(artifacts.code, 501);
    assert.equal(artifacts.result.error.data.upstreamStatus, 501);
    const cancel = await call('/tasks/run-1:cancel', 'POST', {});
    assert.equal(cancel.code, 200);
    assert.equal(cancel.result.status.state, 'TASK_STATE_CANCELED');
    const noToken = await call('/tasks/run-1', 'GET', undefined, 'wrong');
    assert.equal(noToken.code, 401);
    const list = await call('/tasks');
    assert.equal(list.result.tasks.length, 1);
  } finally {
    await stop(bridge);
    await stop(upstream);
  }
});
