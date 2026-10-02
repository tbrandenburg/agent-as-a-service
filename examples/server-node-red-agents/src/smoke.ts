import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { smokeRoundtrip } from "./smoke-roundtrip.js";

const startedAt = new Date().toISOString();
const started = performance.now();
const timings: Record<string, number> = {};
const root = fileURLToPath(new URL("../../../", import.meta.url));
const instance = `smoke-${randomUUID().replaceAll("-", "")}`;
const project = `aas-node-red-agents-${instance}`;
const compose = [
  "compose",
  "-p",
  project,
  "-f",
  "examples/server-node-red-agents/compose.yaml",
];
const env = {
  ...process.env,
  INSTANCE: instance,
  API_TOKEN: randomBytes(32).toString("hex"),
  INTERNAL_TOKEN: randomBytes(32).toString("hex"),
};
const controller = new AbortController();
const interrupt = () => controller.abort(new Error("Smoke interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const execute = promisify(execFile);
const command = async (
  binary: string,
  args: string[],
  interruptible = true,
) => {
  const { stdout, stderr } = await execute(binary, args, {
    cwd: root,
    env,
    timeout: 300_000,
    maxBuffer: 4 * 1024 * 1024,
    ...(interruptible ? { signal: controller.signal } : {}),
  });
  if (stderr) process.stderr.write(stderr);
  return stdout;
};
const measure = async <T>(phase: string, work: () => Promise<T>) => {
  const before = performance.now();
  try {
    return await work();
  } finally {
    timings[phase] = Math.round((performance.now() - before) * 1000) / 1000;
  }
};

let owned = false;
let result: Awaited<ReturnType<typeof smokeRoundtrip>> | undefined;
const errors: unknown[] = [];
try {
  await measure("preparationMs", async () => {
    const dockerRoot = (
      await command("docker", ["info", "--format", "{{.DockerRootDir}}"])
    ).trim();
    const space = await command("df", ["-Pk", dockerRoot]);
    const available = Number(
      space.trim().split("\n")[1]?.trim().split(/\s+/)[3],
    );
    if (!Number.isFinite(available) || available < 4 * 1024 * 1024)
      throw new Error(
        "Smoke build requires at least 4 GiB free in Docker storage",
      );
    for (const resource of ["container", "volume", "network"]) {
      const existing = await command("docker", [
        resource,
        "ls",
        ...(resource === "container" ? ["--all"] : []),
        "--quiet",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ]);
      if (existing.trim()) throw new Error(`Project collision: ${project}`);
    }
  });
  owned = true;
  const output = await measure("spawnMs", () =>
    command("bash", ["examples/server-node-red-agents/instance.sh", "start"]),
  );
  const base = output.match(/URL: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  if (!base) throw new Error("Instance startup did not report an API URL");
  console.log(`Instance: ${instance} | URL: ${base} | spawn includes build`);
  result = await smokeRoundtrip(
    base,
    env.API_TOKEN,
    controller.signal,
    measure,
  );
  timings.stepsCompleteMs = performance.now() - started;
} catch (error) {
  errors.push(error);
  console.error("BROKEN: smoke roundtrip failed", error);
} finally {
  if (owned) {
    if (errors.length) {
      try {
        process.stderr.write(
          await command(
            "docker",
            [...compose, "logs", "--no-color", "--tail=100"],
            false,
          ),
        );
      } catch (error) {
        console.error("Could not retrieve instance logs", error);
      }
    }
    try {
      await measure("cleanupMs", async () => {
        await command(
          "docker",
          [...compose, "down", "--volumes", "--remove-orphans"],
          false,
        );
        for (const service of ["api", "node-red"]) {
          const image = `${project}-${service}:latest`;
          const present = await command(
            "docker",
            ["image", "ls", "--quiet", "--filter", `reference=${image}`],
            false,
          );
          if (present.trim())
            await command("docker", ["image", "rm", image], false);
        }
      });
    } catch (error) {
      errors.push(error);
      console.error(`BROKEN: cleanup failed for ${project}`, error);
    }
  }
  timings.overallMs = performance.now() - started;
  console.log(
    `SMOKE_RESULT ${JSON.stringify({
      status: errors.length ? "BROKEN" : "WORKING",
      startedAt,
      finishedAt: new Date().toISOString(),
      instance,
      spawnIncludesBuild: true,
      ...result,
      timings: Object.fromEntries(
        Object.entries(timings).map(([key, value]) => [
          key,
          Math.round(value * 1000) / 1000,
        ]),
      ),
    })}`,
  );
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  if (errors.length) process.exitCode = 1;
}
