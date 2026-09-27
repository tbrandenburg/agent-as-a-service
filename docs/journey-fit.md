# User journeys against the core contract

This assesses specification coverage; the example backend returns 501 for all resource operations.

| Journey | Fit | Route through the contract |
| --- | --- | --- |
| 1. Ask the default assistant | Yes | Create conversation `{}`, send message, follow conversation SSE or inspect linked run. |
| 2. Continue later | Yes | Get conversation, list messages, send again without an agent ID. |
| 3. Ask without chat | Yes | Start default agent run with only input, poll run. |
| 4. Choose an agent | Yes | Supply known agent ID at conversation creation or run start. Agent discovery is deferred. |
| 5. Watch long work | Yes | Follow conversation SSE for chat, or poll ordered run events/follow run SSE for execution detail; read run output/error. |
| 6. Review a decision | Yes | List pending interactions, inspect the run, submit a decision; continuation follows when possible. |
| 7. Work in a repository | Partial | Register a project by server-side local path or repository URL and associate a run; environment management and Git mutations are outside core. |
| 8. Reuse a workflow | Yes | List saved or server-provided definitions, validate/create a workflow and start its run. |
| 9. Team review | Partial | Decision is modeled; reviewer identity and authorization require a backend. |
| 10. Trigger from external alert | Deferred | No webhook, scheduler or trigger routing in the stable core. |

The real gaps for a production system are persistence, an actual agent/executor and authorization, all deliberately delegated to the replaceable backend. SSE delivery belongs to the backend; webhook routing and project environment administration remain outside this initial REST contract.
