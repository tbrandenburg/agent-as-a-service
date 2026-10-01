import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { empty, load, ratchet, regressions } from "./report.js";

const directories: string[] = [];
const root = process.cwd();
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "quality-gates-"));
  directories.push(directory);
  return directory;
}
function cli(script: string, cwd: string, args: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      resolve(root, "node_modules/tsx/dist/loader.mjs"),
      resolve(root, `scripts/quality/${script}.ts`),
      ...args,
    ],
    { cwd, encoding: "utf8", timeout: 15_000 },
  );
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("warning ratchet and measurement integrity", () => {
  it("warns on growth, coverage loss and new measurements; tolerates bounded runtime variance", () => {
    expect(
      regressions("sizes", { backend: 1370, added: 10 }, { backend: 1369 }),
    ).toHaveLength(2);
    expect(regressions("coverage", { total: 79 }, { total: 80 })).toHaveLength(
      1,
    );
    expect(regressions("runtime", { suite: 1500 }, { suite: 1000 })).toEqual(
      [],
    );
    expect(
      regressions("runtime", { suite: 1751 }, { suite: 1000 }),
    ).toHaveLength(1);
  });
  it("tightens improvements but cannot bless a regression", () => {
    const previous = {
      ...empty(),
      sizes: { grows: 10, shrinks: 20 },
      coverage: { total: 80 },
      mutation: { managed: 50 },
    };
    const current = {
      ...empty(),
      sizes: { grows: 20, shrinks: 10 },
      coverage: { total: 70 },
      mutation: { managed: 60 },
    };
    expect(ratchet(current, previous)).toMatchObject({
      sizes: { grows: 10, shrinks: 10 },
      coverage: { total: 80 },
      mutation: { managed: 60 },
    });
  });
  it("rejects corrupt baselines instead of silently resetting them", async () => {
    const directory = await fixture();
    const path = join(directory, "baseline.json");
    await writeFile(
      path,
      JSON.stringify({ ...empty(), runtime: { suite: -1 } }),
    );
    await expect(load(path)).rejects.toThrow();
  });
  it("fails the structure CLI when the measurement scope is empty", async () => {
    const directory = await fixture();
    await mkdir(join(directory, "scripts/quality"), { recursive: true });
    await writeFile(
      join(directory, "scripts/quality/baseline.json"),
      JSON.stringify(empty()),
    );
    const result = cli("check", directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("matched no source/test files");
  });
  it("annotates real source growth with exit zero and excludes nested worktrees", async () => {
    const directory = await fixture();
    const path = "examples/server-node-red-agents/src/new.ts";
    await mkdir(
      join(directory, "examples/server-node-red-agents/src/.worktrees/other"),
      { recursive: true },
    );
    await mkdir(join(directory, "scripts/quality"), { recursive: true });
    await writeFile(
      join(directory, path),
      "export const value = 1;\nexport const extra = 2;\n",
    );
    await writeFile(
      join(
        directory,
        "examples/server-node-red-agents/src/.worktrees/other/leak.ts",
      ),
      "broken syntax",
    );
    await writeFile(
      join(directory, "scripts/quality/baseline.json"),
      JSON.stringify({ ...empty(), sizes: { [path]: 1 } }),
    );
    const result = cli("check", directory);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning title=Quality drift::sizes");
    expect(result.stdout).toContain("2.00 regressed from 1.00");
    expect(result.stdout).toContain("sizes: 1 measurements");
  });
  it.each([
    ["Pending", 1, "incomplete mutation"],
    ["Survived", 0, "surviving mutants ran zero tests"],
  ])(
    "fails mutation reporting for %s with %i executed tests",
    async (status, testsCompleted, message) => {
      const directory = await fixture();
      await mkdir(join(directory, "data/quality/mutation"), {
        recursive: true,
      });
      await writeFile(
        join(directory, "data/quality/mutation/mutation.json"),
        JSON.stringify({
          files: { "managed.ts": { mutants: [{ status, testsCompleted }] } },
        }),
      );
      const result = cli("mutation", directory);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    },
  );
  it("propagates real test runner configuration failure", async () => {
    const directory = await fixture();
    await symlink(
      join(root, "node_modules"),
      join(directory, "node_modules"),
      "dir",
    );
    const result = cli("test", directory, [
      "--config",
      "scripts/quality/missing.config.ts",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing.config.ts");
  });
});
