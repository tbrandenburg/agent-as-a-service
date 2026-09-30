import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../instance.sh");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function run(action: string, options: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "aas-demo-lifecycle-"));
  roots.push(root);
  const calls = join(root, "calls");
  await writeFile(
    join(root, "docker"),
    `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$CALLS"
if [[ "$1" == info ]]; then printf '%s\\n' "$FAKE_DOCKER_ROOT"; exit 0; fi
if [[ "$1" == image && "$2" == ls ]]; then
  [[ "\${FAIL_IMAGE_LIST:-}" == 1 ]] && exit 1
  [[ "\${NO_IMAGES:-}" == 1 ]] || printf 'image-id\\n'
  exit 0
fi
if [[ "$1" == image && "$2" == rm ]]; then [[ "\${FAIL_IMAGE_RM:-}" != 1 ]]; exit; fi
if [[ "$1" == compose ]]; then
  for arg in "$@"; do
    case "$arg" in
      up) [[ "\${FAIL_UP:-}" != 1 ]]; exit ;;
      down) [[ "\${FAIL_DOWN:-}" != 1 ]]; exit ;;
      logs) exit 0 ;;
      port) printf '127.0.0.1:39094\\n'; exit 0 ;;
      exec) exit 0 ;;
    esac
  done
fi
exit 1
`,
  );
  await writeFile(
    join(root, "df"),
    `#!/usr/bin/env bash
printf 'df %s\\n' "$*" >> "$CALLS"
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/fake 9999999 0 %s 0%% /\\n' "$FAKE_FREE_KIB"
`,
  );
  for (const name of ["docker", "df", "curl", "npm"]) {
    if (name === "curl" || name === "npm")
      await writeFile(join(root, name), "#!/usr/bin/env bash\nexit 0\n");
    await chmod(join(root, name), 0o755);
  }
  const result = spawnSync("bash", [script, action], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      CALLS: calls,
      FAKE_DOCKER_ROOT: root,
      FAKE_FREE_KIB: String(5 * 1024 * 1024),
      ...options,
    },
    timeout: 10_000,
  });
  return { result, calls: await readFile(calls, "utf8").catch(() => "") };
}

describe("disposable Compose lifecycle", () => {
  it("checks Docker-root capacity before building", async () => {
    const { result, calls } = await run("demo", { FAKE_FREE_KIB: "900000" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("needs at least 4 GiB free");
    expect(calls).not.toContain(" up ");
    expect(calls).not.toContain(" down ");
  });

  it("removes just the disposable project's images after down", async () => {
    const { result, calls } = await run("demo");
    expect(result.status).toBe(0);
    const project = calls.match(
      /-p (aas-node-red-agents-demo-[a-f0-9-]+) -f/,
    )?.[1];
    expect(project).toBeDefined();
    expect(calls).toContain(`docker image rm ${project}-api:latest`);
    expect(calls).toContain(`docker image rm ${project}-node-red:latest`);
    expect(calls.indexOf(" down ")).toBeLessThan(
      calls.indexOf("docker image rm"),
    );
    expect(calls).not.toContain("prune");
  });

  it("cleans up images after a partial build failure", async () => {
    const { result, calls } = await run("demo", { FAIL_UP: "1" });
    expect(result.status).toBe(1);
    expect(calls).toContain(" down --volumes --remove-orphans");
    expect(calls).toContain("docker image rm ");
  });

  it("does not remove images when down fails; reports image removal failures", async () => {
    const failedDown = await run("demo", { FAIL_DOWN: "1" });
    expect(failedDown.result.status).toBe(1);
    expect(failedDown.calls).not.toContain("docker image rm");
    const failedRm = await run("demo", { FAIL_IMAGE_RM: "1" });
    expect(failedRm.result.status).toBe(1);
    expect(failedRm.calls).toContain("docker image rm");
    const failedList = await run("demo", { FAIL_IMAGE_LIST: "1" });
    expect(failedList.result.status).toBe(1);
    expect(failedList.result.stderr).toContain(
      "Could not list disposable image",
    );
    expect(failedList.calls).not.toContain("docker image rm");
  });

  it("preserves named instances and skips absent images", async () => {
    const named = await run("stop", { INSTANCE: "alpha" });
    expect(named.result.status).toBe(0);
    expect(named.calls).toContain("-p aas-node-red-agents-alpha ");
    expect(named.calls).not.toContain("docker image ");
    const empty = await run("demo", { NO_IMAGES: "1" });
    expect(empty.result.status).toBe(0);
    expect(empty.calls).not.toContain("docker image rm");
  });
});
