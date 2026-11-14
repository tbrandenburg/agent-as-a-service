import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { Backend } from "../src/backend.js";
import { createApp } from "../src/app.js";
import {
  ClientFactory,
  ClientFactoryOptions,
  RestTransportFactory,
} from "@a2a-js/sdk/client";
import { Role, TaskState } from "@a2a-js/sdk";
import { randomUUID } from "node:crypto";
import net from "node:net";

const servers: Array<ReturnType<express.Express["listen"]>> = [];
afterEach(async () =>
  Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  ),
);

describe("native A2A agent", () => {
  it("publishes a protected Agent Card and interoperates with an independent REST SDK client", async () => {
    let polls = 0;
    let runNumber = 0;
    let failedRunPoll: (() => void) | undefined;
    const failedRunPollObserved = new Promise<void>((resolve) => {
      failedRunPoll = resolve;
    });
    let raceRunReadStarted: (() => void) | undefined;
    const raceRunReadObserved = new Promise<void>((resolve) => {
      raceRunReadStarted = resolve;
    });
    let releaseRaceRunRead: (() => void) | undefined;
    const raceRunReadReleased = new Promise<void>((resolve) => {
      releaseRaceRunRead = resolve;
    });
    let raceCancelStarted: (() => void) | undefined;
    const raceCancelObserved = new Promise<void>((resolve) => {
      raceCancelStarted = resolve;
    });
    let releaseRaceCancel: (() => void) | undefined;
    const raceCancelReleased = new Promise<void>((resolve) => {
      releaseRaceCancel = resolve;
    });
    const cancelCalls = new Map<string, number>();
    const runStates = new Map<string, string>();
    const backendApp = express();
    backendApp.use(express.json());
    backendApp.get("/api/v1/workflows", (_request, response) =>
      response.json({ items: [{ id: "multiply", name: "Multiply" }] }),
    );
    backendApp.post("/api/v1/runs", (_request, response) => {
      const id = `run-${++runNumber}`;
      runStates.set(id, "running");
      response.status(202).json({ run: { id, status: "running" } });
    });
    backendApp.get("/api/v1/runs/:runId", (request, response) => {
      if (request.params.runId === "run-4") {
        raceRunReadStarted?.();
        void raceRunReadReleased.then(() =>
          response.json({
            run: { id: "run-4", status: "completed", output: 6 },
          }),
        );
        return;
      }
      if (request.params.runId === "run-2") {
        response.status(503).json({ error: { code: "temporary" } });
        failedRunPoll?.();
        return;
      }
      polls += 1;
      const status =
        request.params.runId === "run-1" && polls > 1
          ? "completed"
          : (runStates.get(request.params.runId) ?? "running");
      runStates.set(request.params.runId, status);
      response.json({
        run: { id: request.params.runId, status, output: -110 },
      });
    });
    backendApp.post("/api/v1/runs/:runId/cancel", (request, response) => {
      const cancelCount = (cancelCalls.get(request.params.runId) ?? 0) + 1;
      cancelCalls.set(request.params.runId, cancelCount);
      if (request.params.runId === "run-3" && cancelCount === 1) {
        response.status(409).json({ error: { code: "run_not_active" } });
        return;
      }
      if (request.params.runId === "run-4") {
        raceCancelStarted?.();
        void raceCancelReleased.then(() => {
          runStates.set(request.params.runId, "cancelled");
          response.json({
            run: { id: request.params.runId, status: "cancelled" },
          });
        });
        return;
      }
      runStates.set(request.params.runId, "cancelled");
      response.json({ run: { id: request.params.runId, status: "cancelled" } });
    });
    const backendServer = backendApp.listen(0, "127.0.0.1");
    servers.push(backendServer);
    await onceListening(backendServer);
    const backendAddress = backendServer.address();
    if (!backendAddress || typeof backendAddress === "string")
      throw new Error("Missing test backend address");
    const backend = new Backend(
      `http://127.0.0.1:${backendAddress.port}`,
      "backend-secret",
      2000,
    );
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const app = createApp({
      token: "test-secret",
      tokens: new Map([
        ["test-secret", "caller-one"],
        ["second-secret", "caller-two"],
      ]),
      backend,
      publicUrl: baseUrl,
    });
    const server = app.listen(port, "127.0.0.1");
    servers.push(server);
    await onceListening(server);
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test server address");

    const cardResponse = await fetch(`${baseUrl}/.well-known/agent-card.json`);
    const card = (await cardResponse.json()) as {
      name: string;
      supportedInterfaces: Array<{
        protocolBinding: string;
        protocolVersion: string;
      }>;
      capabilities: { streaming?: boolean };
    };
    expect(card.name).toBe("AaaS Management Agent");
    expect(card.supportedInterfaces).toContainEqual(
      expect.objectContaining({
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
      }),
    );
    expect(card.capabilities.streaming).toBe(false);
    const unauthorized = await fetch(`${baseUrl}/message:send`, {
      method: "POST",
      headers: { "content-type": "application/a2a+json", "A2A-Version": "1.0" },
      body: JSON.stringify({
        message: {
          messageId: randomUUID(),
          role: Role.ROLE_USER,
          parts: [
            { content: { text: "list workflows" }, mediaType: "text/plain" },
          ],
        },
        configuration: {
          acceptedOutputModes: ["application/json"],
          returnImmediately: true,
        },
      }),
    });
    expect([401, 403]).toContain(unauthorized.status);
    expect(unauthorized.headers.get("content-type")).toMatch(
      /^application\/a2a\+json/,
    );
    expect(await unauthorized.json()).toEqual({
      error: {
        code: 401,
        status: "UNAUTHENTICATED",
        message: "Unauthorized",
        details: [],
      },
    });
    expect(
      (
        await fetch(`${baseUrl}/tasks/missing`, {
          headers: { authorization: "Bearer incorrect-secret" },
        })
      ).status,
    ).toBe(401);

    const authFetch: typeof fetch = (input, init) =>
      fetch(input, {
        ...init,
        headers: { ...init?.headers, authorization: "Bearer test-secret" },
      });
    const factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [new RestTransportFactory({ fetchImpl: authFetch })],
      }),
    );
    const client = await factory.createFromUrl(baseUrl);
    const options = {};
    const invalid = await client.sendMessage(
      requestMessage({
        data: { operation: "unsupported", parameters: {} },
      }),
      options,
    );
    expect("parts" in invalid).toBe(true);
    if (!("parts" in invalid))
      throw new Error("Expected an unsupported-input response");
    expect(invalid.parts[0]?.content?.$case).toBe("text");
    expect(invalid.parts[0]?.content?.value).toBe(
      "Unsupported management operation",
    );
    expect(runNumber).toBe(0);
    const discovery = await client.sendMessage(
      requestMessage({ text: "list workflows" }),
      options,
    );
    expect("parts" in discovery).toBe(true);
    if (!("parts" in discovery)) throw new Error("Expected a message response");
    expect(discovery.parts[0]?.content?.$case).toBe("data");

    const result = await client.sendMessage(
      requestMessage({
        data: {
          operation: "workflows.execute",
          parameters: { workflowId: "multiply", input: { a: 13.75, b: -8 } },
        },
      }),
      options,
    );
    expect("id" in result).toBe(true);
    if (!("id" in result)) throw new Error("Expected an SDK Task");
    const taskId = result.id;
    expect(result.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    let task = await client.getTask(
      { id: taskId, tenant: "", historyLength: 10 },
      options,
    );
    for (
      let attempt = 0;
      attempt < 40 && task.status?.state === TaskState.TASK_STATE_WORKING;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      task = await client.getTask(
        { id: taskId, tenant: "", historyLength: 10 },
        options,
      );
    }
    expect(task.id).toBe(taskId);
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(task.artifacts[0]?.parts[0]?.content).toEqual({
      $case: "data",
      value: -110,
    });
    await expect(
      client.cancelTask(
        { id: taskId, tenant: "", metadata: undefined },
        options,
      ),
    ).rejects.toThrow();
    await expect(
      client.getTask({ id: "unknown-task", tenant: "" }, options),
    ).rejects.toThrow();
    const secondCaller = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [
          new RestTransportFactory({
            fetchImpl: (input, init) =>
              fetch(input, {
                ...init,
                headers: {
                  ...init?.headers,
                  authorization: "Bearer second-secret",
                },
              }),
          }),
        ],
      }),
    );
    const otherClient = await secondCaller.createFromUrl(baseUrl);
    await expect(
      otherClient.getTask({ id: taskId, tenant: "" }),
    ).rejects.toThrow();

    const pending = await client.sendMessage(
      requestMessage({
        data: {
          operation: "workflows.execute",
          parameters: { workflowId: "multiply", input: { a: 1, b: 1 } },
        },
      }),
      options,
    );
    if (!("id" in pending)) throw new Error("Expected a second SDK Task");
    await failedRunPollObserved;
    const uncertain = await client.getTask(
      { id: pending.id, tenant: "" },
      options,
    );
    expect(uncertain.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    const canceled = await client.cancelTask(
      { id: pending.id, tenant: "", metadata: undefined },
      options,
    );
    expect(canceled.id).toBe(pending.id);
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(cancelCalls.get("run-2")).toBe(1);
    const repeatedCancellation = await client.cancelTask(
      { id: pending.id, tenant: "", metadata: undefined },
      options,
    );
    expect(repeatedCancellation.status?.state).toBe(
      TaskState.TASK_STATE_CANCELED,
    );
    expect(cancelCalls.get("run-2")).toBe(1);

    const cancellationFailure = await client.sendMessage(
      requestMessage({
        data: {
          operation: "workflows.execute",
          parameters: { workflowId: "multiply", input: { a: 1, b: 2 } },
        },
      }),
      options,
    );
    if (!("id" in cancellationFailure))
      throw new Error("Expected a Task for cancellation failure test");
    await expect(
      client.cancelTask(
        { id: cancellationFailure.id, tenant: "", metadata: undefined },
        options,
      ),
    ).rejects.toThrow();
    const activeAfterFailure = await client.getTask(
      { id: cancellationFailure.id, tenant: "" },
      options,
    );
    expect(activeAfterFailure.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    const retriedCancellation = await client.cancelTask(
      { id: cancellationFailure.id, tenant: "", metadata: undefined },
      options,
    );
    expect(retriedCancellation.status?.state).toBe(
      TaskState.TASK_STATE_CANCELED,
    );
    expect(cancelCalls.get("run-3")).toBe(2);

    const racing = await client.sendMessage(
      requestMessage({
        data: {
          operation: "workflows.execute",
          parameters: { workflowId: "multiply", input: { a: 2, b: 3 } },
        },
      }),
      options,
    );
    if (!("id" in racing)) throw new Error("Expected a Task for race test");
    await raceRunReadObserved;
    const raceCancellation = client.cancelTask(
      { id: racing.id, tenant: "", metadata: undefined },
      options,
    );
    await raceCancelObserved;
    releaseRaceCancel?.();
    const raceResult = await raceCancellation;
    expect(raceResult.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    releaseRaceRunRead?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const stableRaceResult = await client.getTask(
      { id: racing.id, tenant: "" },
      options,
    );
    expect(stableRaceResult.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it("fails clearly when the backend is unavailable", async () => {
    const backend = new Backend("http://127.0.0.1:1", "never-print-this", 30);
    await expect(backend.listWorkflows()).rejects.toThrow();
  });

  it("applies request deadlines and sanitizes backend error responses", async () => {
    const delayedFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    await expect(
      new Backend(
        "http://127.0.0.1",
        "secret",
        10,
        delayedFetch,
      ).listWorkflows(),
    ).rejects.toThrow();
    const failingFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: { code: "backend_unavailable", message: "token=secret" },
        }),
        { status: 503 },
      );
    await expect(
      new Backend(
        "http://127.0.0.1",
        "secret",
        100,
        failingFetch,
      ).listWorkflows(),
    ).rejects.toThrow("503, backend_unavailable");
    await expect(
      new Backend(
        "http://127.0.0.1",
        "secret",
        100,
        failingFetch,
      ).listWorkflows(),
    ).rejects.not.toThrow("token=secret");
  });
});

function requestMessage(input: { text?: string; data?: unknown }) {
  return {
    message: {
      messageId: randomUUID(),
      contextId: "",
      taskId: "",
      role: Role.ROLE_USER,
      parts: [
        input.text === undefined
          ? {
              content: { $case: "data" as const, value: input.data },
              mediaType: "application/json",
              metadata: undefined,
              filename: "",
            }
          : {
              content: { $case: "text" as const, value: input.text },
              mediaType: "text/plain",
              metadata: undefined,
              filename: "",
            },
      ],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    tenant: "",
    configuration: {
      acceptedOutputModes: ["application/json"],
      returnImmediately: true,
      taskPushNotificationConfig: undefined,
    },
    metadata: undefined,
  };
}

function onceListening(
  server: ReturnType<express.Express["listen"]>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

async function freePort(): Promise<number> {
  const temporary = net.createServer();
  await new Promise<void>((resolve, reject) =>
    temporary.listen(0, "127.0.0.1", resolve).once("error", reject),
  );
  const address = temporary.address();
  if (!address || typeof address === "string")
    throw new Error("Could not reserve test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    temporary.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
