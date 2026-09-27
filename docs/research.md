# Archon REST capability inventory

Reference: [Archon API documentation](https://archon.diy/reference/api/) and pinned Archon `dev` commit `879c99fe4dceeeae1bef98869e9427f38aadeea4`, inspected 2026-09-27. The checked-in [65-route parity map](rest-parity.md) accounts for 59 declared OpenAPI routes, three additional stream/artifact routes, an OpenAPI document route and two webhooks. This is a snapshot of Archon's REST surface, not a promise of future parity.

| Archon REST area | Source capabilities | Stable independent core |
| --- | --- | --- |
| Codebases | List/create/get/delete; environment variables and isolation environments | Project CRUD; optional server-side `localPath` and `projectId` context |
| Conversations | CRUD, message list/send and conversation stream | CRUD plus list/send typed messages and conversation-scoped SSE |
| Workflow definitions | Discover, validate, get/save/delete; command listing | List saved and server-provided workflows; validate/create/get/update/delete writable definitions |
| Runs | Start/list/get; dashboard; cancel/resume/abandon/signal/delete | Start/list/get/delete, cancel/resume, decisions |
| Human input | Approve/reject/respond | Generic decision plus pending-interaction list across runs |
| Events and artifacts | Dashboard stream, conversation stream, run details, artifact list/content | Poll or stream ordered run events, stream conversation events, list/get artifacts; generic executions in run detail |
| Provider and model configuration | Config, provider/model listing, credentials, user AI preferences | Deferred as implementation configuration |
| Authentication | GitHub device flow, provider OAuth, auth status | Bearer access token for resource routes; backend owns identity and authorization |
| Administration and integrations | Health, update check, GitHub and source webhooks | Health and OpenAPI document; integration triggers deferred |

The map explicitly marks excluded source operations. Source `cwd` becomes optional `localPath` on a project; engine-owned node sessions remain outside the portable wire format. [Design choices](design.md) explain run, conversation and workflow semantics. Archon is a functional reference; this repository contains no Archon dependency and no CLI or MCP API.
