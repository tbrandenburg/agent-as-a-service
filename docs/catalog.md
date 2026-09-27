# API catalog

All operations are specified in the independent ts-rest contract under `/api/v1`. The generated OpenAPI file provides full request, response, parameter and error schemas. Health and OpenAPI are public; status and every resource operation require HTTP bearer authentication. The example adapter checks one development bearer token; an implementation must enforce its own ownership and authorization rules. Resource operations return structured HTTP 501 until a backend is installed.

| Method | Path | Operation | Declared success | Example adapter |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/conversations` | `listConversations` | 200 | 501 |
| POST | `/api/v1/conversations` | `createConversation` | 201 | 501 |
| GET | `/api/v1/conversations/{conversationId}` | `getConversation` | 200 | 501 |
| PATCH | `/api/v1/conversations/{conversationId}` | `updateConversation` | 200 | 501 |
| DELETE | `/api/v1/conversations/{conversationId}` | `deleteConversation` | 200 | 501 |
| GET | `/api/v1/conversations/{conversationId}/events/stream` | `streamConversationEvents` | 200 | 501 |
| GET | `/api/v1/conversations/{conversationId}/messages` | `listMessages` | 200 | 501 |
| POST | `/api/v1/conversations/{conversationId}/messages` | `sendMessage` | 202 | 501 |
| GET | `/api/v1/health` | `getHealth` | 200 | 200 |
| GET | `/api/v1/interactions` | `listPendingInteractions` | 200 | 501 |
| POST | `/api/v1/interactions/{interactionId}/decisions` | `submitInteractionDecision` | 200 | 501 |
| GET | `/api/v1/openapi.json` | `getOpenApiDocument` | 200 | 200 |
| GET | `/api/v1/projects` | `listProjects` | 200 | 501 |
| POST | `/api/v1/projects` | `createProject` | 201 | 501 |
| GET | `/api/v1/projects/{projectId}` | `getProject` | 200 | 501 |
| DELETE | `/api/v1/projects/{projectId}` | `deleteProject` | 200 | 501 |
| GET | `/api/v1/runs` | `listRuns` | 200 | 501 |
| POST | `/api/v1/runs` | `startRun` | 202 | 501 |
| GET | `/api/v1/runs/{runId}` | `getRun` | 200 | 501 |
| DELETE | `/api/v1/runs/{runId}` | `deleteRun` | 200 | 501 |
| GET | `/api/v1/runs/{runId}/artifacts` | `listArtifacts` | 200 | 501 |
| GET | `/api/v1/runs/{runId}/artifacts/{artifactId}` | `getArtifact` | 200 | 501 |
| POST | `/api/v1/runs/{runId}/cancel` | `cancelRun` | 200 | 501 |
| GET | `/api/v1/runs/{runId}/events` | `listEvents` | 200 | 501 |
| GET | `/api/v1/runs/{runId}/events/stream` | `streamRunEvents` | 200 | 501 |
| POST | `/api/v1/runs/{runId}/resume` | `resumeRun` | 200 | 501 |
| GET | `/api/v1/status` | `getStatus` | 200 | 200 |
| GET | `/api/v1/workflows` | `listWorkflows` | 200 | 501 |
| POST | `/api/v1/workflows` | `createWorkflow` | 201 | 501 |
| GET | `/api/v1/workflows/{workflowId}` | `getWorkflow` | 200 | 501 |
| PUT | `/api/v1/workflows/{workflowId}` | `updateWorkflow` | 200 | 501 |
| DELETE | `/api/v1/workflows/{workflowId}` | `deleteWorkflow` | 200 | 501 |
| POST | `/api/v1/workflows/validate` | `validateWorkflow` | 200 | 501 |

Errors follow `{error:{code,message,details?}}`. Common statuses are 400, 401, 403, 404, 409, 429, 500, 501 and 503; workflow update also declares 412 and inline file writes declare 413. Service routes declare only applicable errors. List responses use explicit cursor pagination where relevant. `GET /health` is a small public probe outside the versioned contract. The [Archon REST parity map](rest-parity.md) links each source route to these operations.
