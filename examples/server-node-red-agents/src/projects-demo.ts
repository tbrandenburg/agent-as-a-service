import { createClient, startRun } from "../../client/src/index.js";
import { execFileSync } from "node:child_process";

const base = process.env.DEMO_BASE_URL;
const token = process.env.API_TOKEN;
if (!base || !token) throw new Error("DEMO_BASE_URL and API_TOKEN required");
const api = createClient(base, token);
const compose = process.env.DEMO_COMPOSE_PROJECT;
const inspect = (command: string, args: string[]) => {
  ensure(compose, "DEMO_COMPOSE_PROJECT required for filesystem assertions");
  return execFileSync(
    "docker",
    [
      "compose",
      "-p",
      compose,
      "-f",
      "examples/server-node-red-agents/compose.yaml",
      "exec",
      "-T",
      "node-red",
      command,
      ...args,
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
};
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const call = (path: string, method: string, body?: unknown) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(75_000),
  });
const create = async (body: unknown) => {
  const result = await call("/projects", "POST", body);
  ensure(result.status === 201, `create project: ${result.status}`);
  return (await result.json()) as {
    id: string;
    name: string;
    localPath: string;
    repositoryUrl?: string;
  };
};
const poll = async (id: string) => {
  for (let attempt = 0; attempt < 960; attempt++) {
    const response = await api.runs.getRun({ params: { runId: id } });
    ensure(response.status === 200, `run ${id} not readable`);
    if (["failed", "completed"].includes(response.body.run.status))
      return response.body;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`run ${id} timed out`);
};
const invalid = async (body: unknown, status: number) => {
  const response = await call("/projects", "POST", body);
  ensure(
    response.status === status,
    `invalid provisioning expected ${status}, got ${response.status}`,
  );
};

try {
  inspect("test", ["-d", "/data/projects/existing-fixture"]);
} catch (error) {
  if (
    error instanceof Error &&
    "status" in error &&
    error.status === 1 &&
    "stderr" in error &&
    !String(error.stderr).trim()
  ) {
    throw new Error(
      `Missing /data/projects/existing-fixture in Compose project ${compose}. Create it with: docker compose -p ${compose} -f examples/server-node-red-agents/compose.yaml exec -T node-red mkdir -p /data/projects/existing-fixture`,
      { cause: error },
    );
  }
  throw error;
}

const empty = await create({
  name: "first",
  folderName: "chosen-empty",
  provisioning: { kind: "empty" },
});
const clone = await create({
  name: "second",
  folderName: "chosen-clone",
  provisioning: {
    kind: "clone",
    repositoryUrl: "https://github.com/octocat/Hello-World.git",
  },
});
const existing = await create({
  name: "third",
  provisioning: {
    kind: "existing",
    localPath: "/data/projects/existing-fixture",
  },
});
ensure(
  inspect("ls", ["-A", empty.localPath]).trim() === "",
  "empty project must start empty",
);
ensure(
  inspect("ls", ["-A", existing.localPath]).trim() === "",
  "registered existing directory must not be git-initialized",
);
ensure(
  inspect("git", [
    "-C",
    clone.localPath,
    "remote",
    "get-url",
    "origin",
  ]).trim() === clone.repositoryUrl,
  "clone remote and destination",
);
ensure(
  empty.localPath === "/data/projects/chosen-empty" &&
    clone.localPath === "/data/projects/chosen-clone" &&
    existing.localPath === "/data/projects/existing-fixture",
  "project paths",
);
await invalid({ folderName: "chosen-empty" }, 409);
await invalid({ folderName: "../escape" }, 400);
await invalid(
  { provisioning: { kind: "existing", localPath: "/data/projects/missing" } },
  404,
);
await invalid(
  {
    provisioning: { kind: "clone", repositoryUrl: "https://example.org/repo" },
  },
  400,
);
await invalid(
  {
    provisioning: {
      kind: "clone",
      repositoryUrl:
        "https://github.com/aaas-no-such-org/aaas-no-such-repo.git",
    },
    folderName: "failed-clone",
  },
  503,
);
ensure(
  !inspect("ls", ["-A", "/data/projects"]).includes("failed-clone"),
  "failed clone left no destination or temporary sibling",
);
const first = await api.projects.listProjects({ query: { limit: 2 } });
ensure(
  first.status === 200 &&
    first.body.items.length === 2 &&
    first.body.nextCursor,
  "project pagination first page",
);
const second = await api.projects.listProjects({
  query: { limit: 2, cursor: first.body.nextCursor },
});
ensure(
  second.status === 200 &&
    second.body.items.length === 1 &&
    second.body.nextCursor === null,
  "project pagination second page",
);
ensure(
  (await call("/projects?cursor=bad", "GET")).status === 400,
  "invalid pagination cursor",
);
const inventory = await api.projects.listProjects({ query: { limit: 10 } });
ensure(
  inventory.status === 200 &&
    inventory.body.items.length === 3 &&
    inventory.body.items.every((item) => item.localPath !== "/data/agent-work"),
  "global directory absent from project registry",
);
ensure(
  (
    await call("/projects", "POST", {
      provisioning: { kind: "empty" },
      localPath: "/data/projects/contradiction",
    })
  ).status === 400,
  "contradictory provisioning",
);
const renamed = await api.projects.updateProject({
  params: { projectId: empty.id },
  body: { name: "renamed" },
});
ensure(
  renamed.status === 200 &&
    renamed.body.localPath === empty.localPath &&
    renamed.body.name === "renamed",
  "rename retains cwd",
);
for (const item of [empty, clone, existing]) {
  const lookup = await api.projects.getProject({
    params: { projectId: item.id },
  });
  ensure(
    lookup.status === 200 && lookup.body.localPath === item.localPath,
    "project lookup",
  );
}
const core = await api.workflows.getWorkflow({
  params: { workflowId: "core" },
});
ensure(core.status === 200 && core.body.readOnly, "built-in Core resolved");
const target = {
  kind: "workflow" as const,
  id: "core",
};
const begin = async (projectId?: string) => {
  const accepted = await startRun(api, {
    target,
    input: { text: "Run pwd and include its exact output in your reply." },
    ...(projectId ? { projectId } : {}),
  });
  ensure(
    accepted.status === 202 &&
      accepted.body.conversations?.length === 0 &&
      accepted.body.run.projectId === (projectId ?? null),
    "workflow acceptance",
  );
  const immediate = await api.runs.getRun({
    params: { runId: accepted.body.run.id },
  });
  ensure(immediate.status === 200, "run immediately readable");
  return accepted.body.run.id;
};
const ids = await Promise.all([
  begin(empty.id),
  begin(empty.id),
  begin(clone.id),
  begin(existing.id),
]);
ensure(new Set(ids).size === 4, "distinct concurrent runs");
ensure(
  (await call("/runs", "POST", { target, input: { text: "Fifth run" } }))
    .status === 503,
  "bounded worker admission",
);
ensure(
  (await call(`/projects/${empty.id}`, "DELETE")).status === 409,
  "active delete guard",
);
const completed = await Promise.all(ids.map(poll));
for (const [index, detail] of completed.entries()) {
  ensure(
    detail.run.status === "completed" && detail.conversations?.length === 1,
    `workflow completion ${index}: ${JSON.stringify({ status: detail.run.status, error: detail.run.error, conversations: detail.conversations?.length })}`,
  );
  const expected = [
    empty.localPath,
    empty.localPath,
    clone.localPath,
    existing.localPath,
  ][index];
  ensure(
    typeof detail.run.output === "string" &&
      detail.run.output.includes(expected),
    `Core agent cwd for ${detail.run.id}`,
  );
  for (const link of detail.conversations) {
    const messages = await api.conversations.listMessages({
      params: { conversationId: link.conversationId },
      query: { limit: 10 },
    });
    ensure(
      messages.status === 200 &&
        messages.body.items.some(
          (message) =>
            message.role === "assistant" &&
            typeof message.content === "string" &&
            message.content.trim(),
        ),
      `real agent response for ${detail.run.id}`,
    );
  }
  console.log(
    `Workflow ${detail.run.id} cwd=${expected} conversations=${detail.conversations.length}`,
  );
}
const projectless = await begin();
const global = await poll(projectless);
ensure(
  global.run.status === "completed" && global.run.projectId === null,
  "projectless workflow",
);
ensure(
  typeof global.run.output === "string" &&
    global.run.output.includes("/data/agent-work"),
  "projectless process cwd",
);
const globalAgent = await startRun(api, {
  target: { kind: "workflow", id: "core" },
  input: { text: "Run pwd and include its exact output in your reply." },
});
ensure(
  globalAgent.status === 202 && globalAgent.body.run.projectId === null,
  "projectless Core acceptance",
);
const globalAgentDetail = await poll(globalAgent.body.run.id);
ensure(
  globalAgentDetail.run.status === "completed" &&
    typeof globalAgentDetail.run.output === "string" &&
    globalAgentDetail.run.output.includes("/data/agent-work") &&
    globalAgentDetail.conversations?.length === 1,
  "projectless Core cwd and public conversation",
);
const bootstrap = await startRun(api, {
  target: { kind: "workflow", id: "core" },
  input: { text: "Run pwd and include its exact output in your reply." },
  projectId: empty.id,
});
ensure(
  bootstrap.status === 202 && bootstrap.body.conversations?.length === 0,
  "fresh Core workflow",
);
const coreDetail = await poll(bootstrap.body.run.id);
ensure(
  coreDetail.run.status === "completed" &&
    typeof coreDetail.run.output === "string" &&
    coreDetail.run.output.includes(empty.localPath) &&
    coreDetail.conversations?.length === 1,
  "Core cwd and link",
);
ensure(
  (
    await call("/runs", "POST", {
      target: { kind: "workflow", id: "core" },
      input: { text: "Continue elsewhere" },
      conversationId: coreDetail.conversations[0].conversationId,
      projectId: clone.id,
    })
  ).status === 501,
  "conversation continuation rejected before acceptance",
);
const otherProject = await startRun(api, {
  target: { kind: "workflow", id: "core" },
  input: { text: "Run pwd and include its exact output in your reply." },
  projectId: clone.id,
});
ensure(otherProject.status === 202, "Core run in another project");
const otherDetail = await poll(otherProject.body.run.id);
ensure(
  otherDetail.run.status === "completed" &&
    typeof otherDetail.run.output === "string" &&
    otherDetail.run.output.includes(clone.localPath),
  "Core selects a different explicit project",
);
ensure(
  (
    await call("/runs", "POST", {
      target: { kind: "agent", id: "orchestrator" },
      input: { text: "hello" },
    })
  ).status === 501,
  "unsupported agent target",
);
ensure(
  (await call(`/projects/${empty.id}`, "DELETE")).status === 200,
  "terminal delete",
);
ensure(
  (await call(`/projects/${empty.id}`, "GET")).status === 404,
  "deleted project absent",
);
ensure(
  (
    await call("/runs", "POST", {
      projectId: empty.id,
      target,
      input: { text: "old" },
    })
  ).status === 404,
  "deleted project not runnable",
);
ensure(
  (await call(`/runs/${ids[0]}`, "GET")).status === 200,
  "historical run retained",
);
console.log(
  `Projects CRUD, overlap, Core cwd and retention verified: ${ids.join(", ")}`,
);
