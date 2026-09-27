/** Public REST specification. No server, database, provider or mock dependency. */
import { initContract } from "@ts-rest/core";
import { projects } from "./v1/projects.js";
import { conversations } from "./v1/conversations.js";
import { workflows } from "./v1/workflows.js";
import { runs } from "./v1/runs.js";
import { interactions } from "./v1/interactions.js";
import { system } from "./v1/system.js";
export * as schemas from "./v1/schemas/domain.js";
export { projects, conversations, workflows, runs, interactions, system };
export const contract = initContract().router({
  projects,
  conversations,
  workflows,
  runs,
  interactions,
  system,
});
/** The only unauthenticated routes in the versioned API. */
export const publicPaths = [
  system.getHealth.path,
  system.getOpenApiDocument.path,
] as const;
