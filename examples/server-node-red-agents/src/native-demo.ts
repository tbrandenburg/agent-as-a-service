import { execFileSync } from "node:child_process";
import { createClient, startRun } from "../../client/src/index.js";

const project = process.env.DEMO_COMPOSE_PROJECT;
const base = process.env.DEMO_BASE_URL;
const token = process.env.API_TOKEN;
if (!project || !base || !token)
  throw new Error("DEMO_COMPOSE_PROJECT, DEMO_BASE_URL and API_TOKEN required");
const api = createClient(base, token);
const admin = (method: string, body?: unknown): unknown => {
  const script = `fetch('http://127.0.0.1:1880/flows',{method:${JSON.stringify(method)},headers:{authorization:'Bearer '+process.env.NODE_RED_ADMIN_TOKEN,'content-type':'application/json','Node-RED-Deployment-Type':'full'},${body === undefined ? "" : `body:${JSON.stringify(JSON.stringify(body))},`}}).then(async r=>{if(!r.ok)throw new Error('Admin '+r.status);console.log(JSON.stringify(r.status===204?null:await r.json()))}).catch(e=>{console.error(e.message);process.exitCode=1})`;
  return JSON.parse(
    execFileSync(
      "docker",
      [
        "compose",
        "-p",
        project,
        "-f",
        "examples/server-node-red-agents/compose.yaml",
        "exec",
        "-T",
        "node-red",
        "node",
        "-e",
        script,
      ],
      { encoding: "utf8", timeout: 20_000 },
    ),
  );
};
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const snapshot = admin("GET");
const fixture = {
  id: "agents-tab",
  label: "Native acceptance fixture",
  configs: [],
  nodes: [
    {
      id: "workflow-in",
      z: "agents-tab",
      type: "link in",
      wires: [["native-work"]],
    },
    {
      id: "native-work",
      z: "agents-tab",
      type: "function",
      outputs: 1,
      func: "msg.payload='working'; const input=msg.input; if(input?.mode==='error'){node.error('fixture failure',msg);return null;} if(input?.mode==='wait')return null; msg.payload=input?.output??JSON.stringify(msg.input); msg.runId='forged';msg.status='failed';return msg;",
      wires: [["native-return"]],
    },
    {
      id: "native-return",
      z: "agents-tab",
      type: "link out",
      mode: "return",
      links: [],
      wires: [],
    },
    {
      id: "native-catch",
      z: "agents-tab",
      type: "catch",
      scope: ["native-work"],
      uncaught: false,
      wires: [["native-return"]],
    },
  ],
};
const poll = async (id: string) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await api.runs.getRun({ params: { runId: id } });
    ensure(result.status === 200, "Run readable immediately");
    if (["completed", "failed"].includes(result.body.run.status))
      return result.body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Native run ${id} timed out`);
};
try {
  admin("POST", [
    { id: fixture.id, type: "tab", label: fixture.label },
    ...fixture.nodes,
  ]);
  const inputs = [
    "native string",
    {
      repository: "acme/example",
      branch: "feature/link-call",
      limit: 3,
      enabled: true,
      flags: { includeTests: true },
      items: ["a", "b"],
    },
    [{ type: "text" as const, text: "input part" }],
  ];
  for (const input of inputs) {
    const accepted = await startRun(api, {
      target: { kind: "workflow", workflowId: "node-red-demo" },
      input,
    });
    ensure(accepted.status === 202, "Generic native acceptance");
    const detail = await poll(accepted.body.run.id);
    ensure(
      detail.run.status === "completed" &&
        detail.run.output === JSON.stringify(input),
      "Exact input types survived working payload overwrite",
    );
    ensure(
      detail.conversations?.length === 0,
      "Non-agent flow requires no conversation",
    );
  }
  const parts = [
    { type: "text", text: "ok" },
    { type: "data", data: { limit: 3 } },
  ];
  for (const output of ["ok", parts, {}]) {
    const accepted = await startRun(api, {
      target: { kind: "workflow", workflowId: "node-red-demo" },
      input: { output },
    });
    ensure(accepted.status === 202, "Output acceptance");
    const detail = await poll(accepted.body.run.id);
    ensure(detail.run.id === accepted.body.run.id, "Host run ID authoritative");
    if (!Array.isArray(output) && typeof output === "object") {
      ensure(
        detail.run.status === "failed" &&
          detail.run.error?.code === "workflow_failed",
        "Unsupported output fails explicitly",
      );
      continue;
    }
    ensure(
      detail.run.status === "completed" &&
        JSON.stringify(detail.run.output) === JSON.stringify(output),
      "Shared output schema projection",
    );
  }
  const accepted = await Promise.all(
    ["first", "second"].map((output) =>
      startRun(api, {
        target: { kind: "workflow", workflowId: "node-red-demo" },
        input: { output },
      }),
    ),
  );
  for (const [index, result] of accepted.entries()) {
    ensure(result.status === 202, "Concurrent acceptance");
    ensure(
      (await poll(result.body.run.id)).run.output ===
        ["first", "second"][index],
      "Concurrent run correlation",
    );
  }
  const failed = await startRun(api, {
    target: { kind: "workflow", workflowId: "node-red-demo" },
    input: { mode: "error" },
  });
  ensure(failed.status === 202, "Node failure acceptance");
  ensure(
    (await poll(failed.body.run.id)).run.status === "failed",
    "Node failure finalizes",
  );
  const pending = await startRun(api, {
    target: { kind: "workflow", workflowId: "node-red-demo" },
    input: { mode: "wait" },
  });
  ensure(pending.status === 202, "Pending worker acceptance");
  const terminate = `const fs=require('node:fs');const deadline=Date.now()+15000;const find=()=>{for(const id of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){let args;try{args=fs.readFileSync('/proc/'+id+'/cmdline','utf8').split('\\0')}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')continue;throw e}if(args[1]==='/seed/worker-host.js'&&args[4]===${JSON.stringify(pending.body.run.id)}){process.kill(Number(id),'SIGKILL');return}}if(Date.now()>deadline)throw new Error('Owned worker not found');setTimeout(find,100)};find();`;
  execFileSync(
    "docker",
    [
      "compose",
      "-p",
      project,
      "-f",
      "examples/server-node-red-agents/compose.yaml",
      "exec",
      "-T",
      "node-red",
      "node",
      "-e",
      terminate,
    ],
    { timeout: 20_000 },
  );
  const crashed = await poll(pending.body.run.id);
  ensure(
    crashed.run.status === "failed" &&
      crashed.run.error?.code === "worker_failed",
    "Worker crash finalizes the correct pending run",
  );
  console.log(
    "Native Docker HTTP acceptance: generic inputs, independent payload, outputs, failures and concurrency passed",
  );
} finally {
  admin("POST", snapshot);
}
