import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
  const fixture = join(root, "repo", "examples", "server-node-red-agents");
  await mkdir(fixture, { recursive: true });
  const launcher = join(fixture, "instance.sh");
  await copyFile(script, launcher);
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
if [[ "$1" == container && "$2" == ls ]]; then
  if [[ "\${COLLIDE_FIRST:-}" == container && ! -f "$FAKE_DOCKER_ROOT/checked" ]]; then
    touch "$FAKE_DOCKER_ROOT/checked"
    printf 'existing-container\n'
  fi
  exit 0
fi
if [[ "$1" == volume && "$2" == ls ]]; then
  if [[ "\${COLLIDE_FIRST:-}" == volume && ! -f "$FAKE_DOCKER_ROOT/checked" ]]; then
    touch "$FAKE_DOCKER_ROOT/checked"
    printf 'existing-volume\n'
  fi
  exit 0
fi
if [[ "$1" == network && "$2" == ls ]]; then
  if [[ "\${COLLIDE_FIRST:-}" == network && ! -f "$FAKE_DOCKER_ROOT/checked" ]]; then
    touch "$FAKE_DOCKER_ROOT/checked"
    printf 'existing-network\n'
  fi
  exit 0
fi
if [[ "$1" == compose ]]; then
  for arg in "$@"; do
    case "$arg" in
      up) [[ "\${FAIL_UP:-}" != 1 ]]; exit ;;
      down) [[ "\${FAIL_DOWN:-}" != 1 ]]; exit ;;
      logs) exit 0 ;;
      ps) exit 0 ;;
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
  const result = spawnSync("bash", [launcher, action], {
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
  return {
    result,
    calls: await readFile(calls, "utf8").catch(() => ""),
    seed: join(root, "repo", ".home"),
  };
}

describe("disposable Compose lifecycle", () => {
  it("creates the local seed before Compose", async () => {
    const named = await run("start", {
      INSTANCE: "alpha",
      API_TOKEN: "public",
      INTERNAL_TOKEN: "internal",
      NODE_RED_ADMIN_TOKEN: "admin",
    });
    expect(named.result.status).toBe(0);
    expect((await stat(named.seed)).isDirectory()).toBe(true);
    expect(named.calls).toContain(" up --build -d");
  });
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

describe("spawned persistent instances", () => {
  const tokens = {
    API_TOKEN: "public-test-token",
    INTERNAL_TOKEN: "internal-test-token",
    NODE_RED_ADMIN_TOKEN: "admin-test-token",
  };

  it("generates independent names, delegates to start, and prints lifecycle commands", async () => {
    const first = await run("spawn", tokens);
    const second = await run("spawn", tokens);
    for (const { result, calls } of [first, second]) {
      expect(result.status).toBe(0);
      const instance = result.stdout.match(
        /Instance: (aaas-[a-f0-9]{8}) \|/,
      )?.[1];
      expect(instance).toBeDefined();
      expect(result.stdout).toContain(
        `Project: aas-node-red-agents-${instance} | URL: http://127.0.0.1:39094`,
      );
      for (const action of ["status", "logs", "stop", "cleanup"])
        expect(result.stdout).toContain(
          `make ${action}-node-red-agents INSTANCE=${instance}`,
        );
      expect(calls).toContain(
        `docker volume ls --quiet --filter label=com.docker.compose.project=aas-node-red-agents-${instance}`,
      );
      expect(calls).toContain(`-p aas-node-red-agents-${instance} `);
      expect(calls).toContain(" up --build -d");
      expect(calls).not.toContain(" down ");
    }
    expect(
      first.result.stdout.match(/Instance: (aaas-[a-f0-9]{8}) \|/)?.[1],
    ).not.toBe(
      second.result.stdout.match(/Instance: (aaas-[a-f0-9]{8}) \|/)?.[1],
    );
  });

  for (const resource of ["container", "volume", "network"]) {
    it(`retries when a generated project's ${resource} already exists`, async () => {
      const { result, calls } = await run("spawn", {
        ...tokens,
        COLLIDE_FIRST: resource,
      });
      expect(result.status).toBe(0);
      const projects = [
        ...calls.matchAll(
          /docker volume ls --quiet --filter label=com\.docker\.compose\.project=(aas-node-red-agents-aaas-[a-f0-9]{8})/g,
        ),
      ].map((match) => match[1]);
      expect(projects).toHaveLength(2);
      expect(projects[0]).not.toBe(projects[1]);
      expect(calls).toMatch(
        new RegExp(`-p ${projects[1]} -f [^\\n]+ up --build -d`),
      );
      expect(calls).not.toMatch(
        new RegExp(`-p ${projects[0]} -f [^\\n]+ up --build -d`),
      );
    });
  }

  it("does not report success when credentials or start fail", async () => {
    const missing = await run("spawn", {
      API_TOKEN: "public-test-token",
      INTERNAL_TOKEN: "",
      NODE_RED_ADMIN_TOKEN: "",
    });
    expect(missing.result.status).not.toBe(0);
    expect(missing.calls).not.toContain(" up --build -d");
    const failed = await run("spawn", { ...tokens, FAIL_UP: "1" });
    expect(failed.result.status).not.toBe(0);
    expect(failed.result.stdout).not.toContain("Cleanup:");
    expect(failed.calls).toContain(" up --build -d");
  });
});
