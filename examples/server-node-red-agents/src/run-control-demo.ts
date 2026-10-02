import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { echo } from "./native-fixtures.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const execute = promisify(execFile);

export async function runControlAcceptance(
  base: string,
  token: string,
  completed: string,
) {
  const call = async (
    path: string,
    method: string,
    status: number,
    body?: unknown,
    key?: string,
  ) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, status, `${method} ${path}`);
    console.log(`Run control ${method} ${path}: ${response.status}`);
    return response.json();
  };
  const absentWorker = async (id: string) => {
    const project = process.env.DEMO_COMPOSE_PROJECT;
    assert.ok(
      project,
      "DEMO_COMPOSE_PROJECT required for worker absence proof",
    );
    const { stdout } = await execute(
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
        `const fs=require('node:fs'); const id=process.argv[1]; const matches=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).filter(p=>{try{const args=fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0');return args.includes('/seed/worker-host.js')&&args.includes(id);}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')return false;throw e;}});process.stdout.write(JSON.stringify(matches));`,
        id,
      ],
      { timeout: 15_000 },
    );
    assert.deepEqual(JSON.parse(stdout), [], `No worker for ${id}`);
    console.log(`Worker absence run=${id}: verified`);
  };
  const resume = async (id: string) => {
    assert.equal(
      (await call(`/runs/${id}/resume`, "POST", 409, {})).error.code,
      "run_not_resumable",
    );
  };
  const removed = async (id: string) => {
    assert.deepEqual(await call(`/runs/${id}`, "DELETE", 200), {
      success: true,
    });
    await call(`/runs/${id}`, "GET", 404);
    await call(`/runs/${id}/events`, "GET", 404);
    const listed = await call("/runs?limit=100", "GET", 200);
    assert.ok(!listed.items.some((run: { id: string }) => run.id === id));
  };
  const slow = await call(
    "/workflows",
    "POST",
    201,
    echo(
      "setTimeout(()=>{msg.payload='late';node.send(msg);node.done();},6000);return;",
    ),
  );
  const body = {
    target: { kind: "workflow", id: slow.id },
    input: null,
  };
  const key = randomUUID();
  const accepted = await call("/runs", "POST", 202, body, key);
  const id = accepted.run.id as string;
  const deadline = Date.now() + 45_000;
  let observed = false;
  while (Date.now() < deadline) {
    const detail = await call(`/runs/${id}`, "GET", 200);
    assert.equal(detail.run.status, "running");
    if (
      detail.executions?.some(
        (execution: { key: string; status: string }) =>
          execution.key === "work" && execution.status === "running",
      )
    ) {
      observed = true;
      break;
    }
    await sleep(100);
  }
  assert.ok(observed, "Slow Function observed before cancellation");
  await resume(id);
  assert.equal(
    (await call(`/runs/${id}`, "DELETE", 409)).error.code,
    "run_active",
  );
  const cancelled = await call(`/runs/${id}/cancel`, "POST", 200, {
    reason: "native acceptance",
  });
  assert.equal(cancelled.run.status, "cancelled");
  assert.equal(cancelled.run.error, undefined);
  const detail = await call(`/runs/${id}`, "GET", 200);
  assert.ok(
    detail.executions.some(
      (execution: { key: string; status: string }) =>
        execution.key === "work" && execution.status === "unconfirmed",
    ),
  );
  const events = await call(`/runs/${id}/events?limit=100`, "GET", 200);
  assert.ok(
    events.some(
      (event: { type: string; data?: { reason?: string } }) =>
        event.type === "run.cancelled" &&
        event.data?.reason === "native acceptance",
    ),
  );
  await absentWorker(id);
  await resume(id);

  const immediate = await call("/runs", "POST", 202, body);
  const immediateId = immediate.run.id as string;
  assert.equal(
    (await call(`/runs/${immediateId}/cancel`, "POST", 200)).run.status,
    "cancelled",
  );
  await absentWorker(immediateId);
  await sleep(6500);
  for (const cancelledId of [id, immediateId]) {
    assert.equal(
      (await call(`/runs/${cancelledId}`, "GET", 200)).run.status,
      "cancelled",
    );
    await absentWorker(cancelledId);
  }
  await removed(id);
  assert.deepEqual(await call("/runs", "POST", 202, body, key), accepted);
  await call(`/runs/${id}`, "GET", 404);
  await absentWorker(id);
  await removed(immediateId);
  await resume(completed);
  await removed(completed);

  // Released capacity must execute new work; failed runs also reject resume.
  const good = await call("/workflows", "POST", 201, echo());
  const bad = await call(
    "/workflows",
    "POST",
    201,
    echo("node.done(new Error('fixture failure'));return;"),
  );
  for (const [workflow, status] of [
    [good, "completed"],
    [bad, "failed"],
  ] as const) {
    const response = await call("/runs", "POST", 202, {
      target: { kind: "workflow", id: workflow.id },
      input: "capacity released",
    });
    const runId = response.run.id as string;
    const end = Date.now() + 45_000;
    let terminal = false;
    while (Date.now() < end) {
      const result = await call(`/runs/${runId}`, "GET", 200);
      if (["completed", "failed"].includes(result.run.status)) {
        assert.equal(result.run.status, status);
        if (status === "completed")
          assert.equal(result.run.output, "capacity released");
        terminal = true;
        break;
      }
      await sleep(200);
    }
    assert.ok(terminal, "Following run completes within deadline");
    await resume(runId);
    await removed(runId);
    await call(`/workflows/${workflow.id}`, "DELETE", 200);
  }
  await call(`/workflows/${slow.id}`, "DELETE", 200);
  console.log(
    "Native run controls passed: observed/immediate cancel, unconfirmed nodes, no late workers, capacity, resume 409, terminal delete and identical idempotency replay",
  );
}
