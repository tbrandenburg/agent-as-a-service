/**
 * EXPERIMENTAL A2A-shaped HTTP+JSON facade for the existing AaaS REST backend.
 * No external dependencies. Not a certified or complete A2A implementation.
 *
 * Usage:
 *   AAAS_UPSTREAM_URL=http://127.0.0.1:3094/api/v1 A2A_PORT=3105 \
 *     node scripts/poc-a2a/bridge.mjs
 *
 * AaaS-aware request:
 *   POST /message:send {message:{messageId,role:'ROLE_USER',parts:[
 *     {data:{operation:'listWorkflows',query:{}}}
 *   ]}}
 *
 * This is a proof that the existing HTTP surface can be dispatched through
 * structured A2A message parts; it does NOT yet prove generic-client conformance.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const op = (method, path) => Object.freeze({ method, path });

// This table deliberately mirrors docs/catalog.md; no arbitrary HTTP forwarding.
export const OPERATIONS = Object.freeze({
  listConversations: op('GET', '/conversations'),
  createConversation: op('POST', '/conversations'),
  getConversation: op('GET', '/conversations/{conversationId}'),
  updateConversation: op('PATCH', '/conversations/{conversationId}'),
  deleteConversation: op('DELETE', '/conversations/{conversationId}'),
  streamConversationEvents: op('GET', '/conversations/{conversationId}/events/stream'),
  listMessages: op('GET', '/conversations/{conversationId}/messages'),
  sendMessage: op('POST', '/conversations/{conversationId}/messages'),
  getHealth: op('GET', '/health'),
  listPendingInteractions: op('GET', '/interactions'),
  submitInteractionDecision: op('POST', '/interactions/{interactionId}/decisions'),
  getOpenApiDocument: op('GET', '/openapi.json'),
  listProjects: op('GET', '/projects'),
  createProject: op('POST', '/projects'),
  getProject: op('GET', '/projects/{projectId}'),
  updateProject: op('PATCH', '/projects/{projectId}'),
  deleteProject: op('DELETE', '/projects/{projectId}'),
  listRuns: op('GET', '/runs'),
  startRun: op('POST', '/runs'),
  getRun: op('GET', '/runs/{runId}'),
  deleteRun: op('DELETE', '/runs/{runId}'),
  listArtifacts: op('GET', '/runs/{runId}/artifacts'),
  getArtifact: op('GET', '/runs/{runId}/artifacts/{artifactId}'),
  cancelRun: op('POST', '/runs/{runId}/cancel'),
  listEvents: op('GET', '/runs/{runId}/events'),
  streamRunEvents: op('GET', '/runs/{runId}/events/stream'),
  resumeRun: op('POST', '/runs/{runId}/resume'),
  getStatus: op('GET', '/status'),
  listWorkflows: op('GET', '/workflows'),
  createWorkflow: op('POST', '/workflows'),
  getWorkflow: op('GET', '/workflows/{workflowId}'),
  updateWorkflow: op('PUT', '/workflows/{workflowId}'),
  deleteWorkflow: op('DELETE', '/workflows/{workflowId}'),
  validateWorkflow: op('POST', '/workflows/validate'),
});

const TERMINAL = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']);
const STATUS = Object.freeze({
  queued: 'TASK_STATE_SUBMITTED',
  running: 'TASK_STATE_WORKING',
  paused: 'TASK_STATE_INPUT_REQUIRED',  // lossy: not every pause is a request for input
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  cancelled: 'TASK_STATE_CANCELED',
  rejected: 'TASK_STATE_REJECTED',
});

function error(status, message, code = -32602, extra = {}) {
  return { httpStatus: status, payload: { error: { code, message, ...extra } } };
}

function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function scalar(value) { return typeof value === 'string' && value.trim().length > 0; }

function compileRequest(command) {
  if (!isObject(command) || !scalar(command.operation) || !Object.hasOwn(OPERATIONS, command.operation)) {
    throw new TypeError('Unknown operation; expected one of the 34 catalog operation IDs');
  }
  const { method, path } = OPERATIONS[command.operation];
  const parameters = command.parameters ?? {};
  const query = command.query ?? {};
  if (!isObject(parameters) || !isObject(query) ||
      (command.body !== undefined && !isObject(command.body) && !Array.isArray(command.body))) {
    throw new TypeError('Invalid parameters, query, or body');
  }
  const expanded = path.replace(/\{([^}]+)\}/g, (_, name) => {
    if (!scalar(parameters[name])) throw new TypeError(`Missing path parameter: ${name}`);
    return encodeURIComponent(parameters[name]);
  });
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name) || !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new TypeError('Query values must be scalar with simple parameter names');
    }
    search.set(name, String(value));
  }
  const headers = {};
  if (command.idempotencyKey !== undefined) {
    if (!scalar(command.idempotencyKey)) throw new TypeError('Invalid idempotencyKey');
    headers['Idempotency-Key'] = command.idempotencyKey;
  }
  if (command.ifMatch !== undefined) {
    if (!scalar(command.ifMatch)) throw new TypeError('Invalid ifMatch');
    headers['If-Match'] = command.ifMatch;
  }
  return {
    operation: command.operation,
    method,
    path: `${expanded}${search.size ? `?${search}` : ''}`,
    headers,
    body: ['POST', 'PATCH', 'PUT'].includes(method) ? (command.body ?? {}) : undefined,
  };
}

async function parseBody(req) {
  const max = 1024 * 1024;
  let count = 0;
  const chunks = [];
  for await (const chunk of req) {
    count += chunk.length;
    if (count > max) throw new TypeError('Request too large (1 MiB limit)');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function respond(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/a2a+json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function taskForRun(run, contextId, origin) {
  const id = run?.id;
  if (!scalar(id)) throw new Error('Backend returned no run.id');
  const state = STATUS[run.status] ?? 'TASK_STATE_UNSPECIFIED';
  const task = {
    id,
    contextId,
    status: { state },
    metadata: { 'aaas.poc': { backendStatus: run.status, originatingOperation: origin } },
  };
  if (state === 'TASK_STATE_INPUT_REQUIRED') {
    task.status.message = {
      messageId: randomUUID(), contextId, taskId: id, role: 'ROLE_AGENT',
      parts: [{ text: 'This execution is paused. Inspect pending interactions before responding.' }],
    };
  }
  if (state === 'TASK_STATE_COMPLETED' && Object.hasOwn(run, 'output') && run.output !== undefined) {
    task.artifacts = [{ artifactId: `${id}-output`, name: 'Run output', parts: [{ data: run.output }] }];
  }
  return task;
}

export function createBridge({ upstream, advertisedUrl, timeoutMs = 30_000 } = {}) {
  if (!upstream) throw new Error('upstream is required');
  const base = new URL(upstream.endsWith('/') ? upstream : `${upstream}/`);
  if (!/^https?:$/.test(base.protocol)) throw new Error('upstream must be HTTP(S)');
  const contextByTask = new Map();
  const contexts = new Map(); // known task to originating operation

  async function forward(authorization, details) {
    // Only paths from the whitelist or native /runs operations reach this function.
    const url = new URL(details.path.replace(/^\//, ''), base);
    const headers = { ...details.headers };
    if (authorization) headers.authorization = authorization;
    if (details.body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await fetch(url, {
        method: details.method,
        headers,
        body: details.body === undefined ? undefined : JSON.stringify(details.body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch {
      return { status: 502, data: { error: { code: 'upstream_unavailable', message: 'AaaS backend unavailable' } } };
    }
    let data;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      // No SSE-to-A2A mapping in the PoC: preserve this gap transparently.
      await response.body?.cancel();
      return { status: 501, data: { error: { code: 'stream_conversion_not_implemented', message: 'A2A streaming conversion is not implemented in this PoC' } } };
    }
    try { data = await response.json(); } catch { data = { error: { code: 'non_json_response', message: 'Backend returned non-JSON response' } }; }
    return { status: response.status, data };
  }

  function makeMessage(operation, result, contextId) {
    return {
      messageId: randomUUID(), contextId, role: 'ROLE_AGENT',
      parts: [{ data: { operation, upstreamStatus: result.status, result: result.data } }],
    };
  }

  async function getTask(id, authorization) {
    if (!contextByTask.has(id)) return error(404, 'Unknown A2A Task', -32001);
    const backend = await forward(authorization, { method: 'GET', path: `/runs/${encodeURIComponent(id)}` });
    if (backend.status >= 400) return error(backend.status, backend.data?.error?.message || 'Could not load task', -32001);
    return { httpStatus: 200, payload: taskForRun(backend.data.run, contextByTask.get(id), contexts.get(id)) };
  }

  async function send(message, authorization) {
    if (!isObject(message) || !scalar(message.messageId) || message.role !== 'ROLE_USER' || !Array.isArray(message.parts) || !message.parts.length) {
      return error(400, 'A2A message must have messageId, ROLE_USER, and nonempty parts');
    }
    const part = message.parts.find(p => isObject(p?.data)) ?? message.parts.find(p => scalar(p?.text));
    if (!part) return error(400, 'PoC accepts structured data or limited plain-text messages');
    let command = part.data;
    if (!command && scalar(part.text)) {
      const text = part.text.trim().toLowerCase();
      // Deliberately deterministic: System One model integration is OUT OF SCOPE here.
      const natural = {
        'list workflows': 'listWorkflows',
        'what workflows are available?': 'listWorkflows',
        'list projects': 'listProjects',
        'list runs': 'listRuns',
        'status': 'getStatus',
      };
      if (!natural[text]) return error(400, 'Free-form natural language requires a System One model (not included in this PoC)');
      command = { operation: natural[text] };
    }
    let compiled;
    try { compiled = compileRequest(command); } catch (e) { return error(400, e.message); }

    if (message.taskId) {
      if (!contextByTask.has(message.taskId)) return error(404, 'Unknown A2A Task', -32001);
      if (message.contextId && message.contextId !== contextByTask.get(message.taskId)) {
        return error(400, 'Task/context mismatch');
      }
      // Only allow a follow-up human decision to target an existing A2A task.
      if (command.operation !== 'submitInteractionDecision') {
        return error(400, 'Only submitInteractionDecision supports task continuation in this PoC');
      }
      const current = await getTask(message.taskId, authorization);
      if (current.httpStatus !== 200) return current;
      if (TERMINAL.has(current.payload.status.state)) return error(409, 'Task is terminal and cannot accept further input');
    }
    const result = await forward(authorization, compiled);
    if (result.status >= 400) {
      return error(result.status, result.data?.error?.message || `Backend returned ${result.status}`, -32603,
        { data: { operation: command.operation, upstreamStatus: result.status, upstreamError: result.data?.error ?? null } });
    }
    if (['startRun', 'sendMessage'].includes(command.operation)) {
      if (!result.data?.run?.id) return error(502, 'Backend returned no run to map to A2A Task');
      const id = result.data.run.id;
      const contextId = message.contextId || `context-${id}`;
      contextByTask.set(id, contextId);
      contexts.set(id, command.operation);
      return { httpStatus: 200, payload: { task: taskForRun(result.data.run, contextId, command.operation) } };
    }
    if (message.taskId && command.operation === 'submitInteractionDecision') {
      const current = await getTask(message.taskId, authorization);
      return current.httpStatus === 200 ? { httpStatus: 200, payload: { task: current.payload } } : current;
    }
    const contextId = message.contextId || randomUUID();
    return { httpStatus: 200, payload: { message: makeMessage(command.operation, result, contextId) } };
  }

  const server = createServer(async (req, res) => {
    try {
      const origin = `http://${req.headers.host || '127.0.0.1'}`;
      const url = new URL(req.url ?? '/', origin);
      if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
        return respond(res, 200, {
          name: 'AaaS Management PoC',
          description: 'Experimental A2A-shaped dispatcher over an existing AaaS HTTP implementation. No LLM; not A2A-conformance-tested.',
          supportedInterfaces: [{ url: advertisedUrl || origin, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
          version: '0.0.1-experimental',
          capabilities: { streaming: false, pushNotifications: false },
          defaultInputModes: ['application/json', 'text/plain'],
          defaultOutputModes: ['application/json', 'text/plain'],
          skills: [
            { id: 'aaas-management', name: 'Manage workflows and projects', description: 'AaaS structured commands through A2A data parts', tags: ['management', 'workflows'] },
          ],
          securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'bearer' } } },
          securityRequirements: [{ schemes: { bearer: { list: [] } } }],
        });
      }
      const auth = req.headers.authorization;
      if (!auth || !/^Bearer \S+$/i.test(auth)) return respond(res, 401, { error: { code: -32000, message: 'Bearer authorization required' } });
      if (req.method === 'POST' && url.pathname === '/message:send') {
        const body = await parseBody(req);
        const result = await send(body.message, auth);
        return respond(res, result.httpStatus, result.payload);
      }
      if (req.method === 'GET' && url.pathname === '/tasks') {
        const query = new URLSearchParams(url.search);
        const backend = await forward(auth, { method: 'GET', path: `/runs${query.size ? `?${query}` : ''}` });
        if (backend.status >= 400) return respond(res, backend.status, { error: { code: -32603, message: 'Could not list tasks' } });
        const tasks = (backend.data.items ?? []).filter(r => contextByTask.has(r.id)).map(r => taskForRun(r, contextByTask.get(r.id), contexts.get(r.id)));
        return respond(res, 200, { tasks, nextPageToken: '' });
      }
      const taskMatch = /^\/tasks\/([^/]+?)(:cancel)?$/.exec(url.pathname);
      if (taskMatch) {
        const id = decodeURIComponent(taskMatch[1]);
        if (!contextByTask.has(id)) return respond(res, 404, { error: { code: -32001, message: 'Unknown A2A Task' } });
        if (req.method === 'GET' && !taskMatch[2]) {
          const t = await getTask(id, auth);
          return respond(res, t.httpStatus, t.payload);
        }
        if (req.method === 'POST' && taskMatch[2]) {
          const backend = await forward(auth, { method: 'POST', path: `/runs/${encodeURIComponent(id)}/cancel`, body: {} });
          if (backend.status >= 400) return respond(res, backend.status, { error: { code: -32603, message: backend.data?.error?.message || 'Cancellation failed' } });
          return respond(res, 200, taskForRun(backend.data.run, contextByTask.get(id), contexts.get(id)));
        }
      }
      return respond(res, 404, { error: { code: -32601, message: 'Unsupported PoC operation' } });
    } catch (e) {
      if (e instanceof SyntaxError || e instanceof TypeError) return respond(res, 400, { error: { code: -32602, message: e.message } });
      // Don't leak tokens, URLs or internal exceptions through HTTP errors.
      return respond(res, 500, { error: { code: -32603, message: 'Internal dispatcher error' } });
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const upstream = process.env.AAAS_UPSTREAM_URL;
  if (!upstream) { console.error('AAAS_UPSTREAM_URL required'); process.exit(2); }
  const port = Number(process.env.A2A_PORT || 3105);
  const host = process.env.A2A_HOST || '127.0.0.1';
  const server = createBridge({ upstream });
  server.listen(port, host, () => {
    console.log(`Experimental AaaS A2A dispatcher listening on http://${host}:${port}`);
    console.log(`Forwarding authenticated structured requests to ${upstream}`);
  });
}
