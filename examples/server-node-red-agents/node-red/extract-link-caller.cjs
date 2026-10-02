const { createHash } = require("node:crypto");
const { mkdtemp, writeFile, mkdir, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { execFileSync } = require("node:child_process");

// Extract native Link Call without the CLI's single-tab/static-wires preflight.
const integrity = "ZPtIyjuKo6bzeax9IHXKhWGsXV7z+6OcWnoNWs9TJTFm0Dq5vTHAJpiuxDtFUrG4aZoaMxmMD8z/bbCL3cid5A==";
async function extract() {
  const destination = process.argv[2];
  if (!destination) throw new Error("Adapter destination required");
  const response = await fetch("https://registry.npmjs.org/@tbrandenburg/node-red-cli/-/node-red-cli-0.2.18.tgz", { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Adapter download failed (${response.status})`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha512").update(archive).digest("base64") !== integrity)
    throw new Error("Upstream adapter integrity mismatch");
  const directory = await mkdtemp(join(tmpdir(), "aaas-link-adapter-"));
  try {
    const path = join(directory, "upstream.tgz");
    await writeFile(path, archive);
    await mkdir(destination, { recursive: true });
    for (const [source, name] of [["package/src/link-call.js", "link-call.cjs"], ["package/LICENSE", "link-call.LICENSE"]]) {
      const original = execFileSync("tar", ["-xOf", path, source], { timeout: 10_000 });
      const preflight = "const validation = validateTarget(RED, target, { flow });";
      const exports = "module.exports = { createHostLinkCaller, resolveFlow, validateTarget };";
      if (name === "link-call.cjs" && (!original.toString().includes(preflight) || !original.toString().includes(exports) || !original.toString().includes("function createHostLinkCaller(RED)"))) throw new Error("Upstream preflight patch no longer applies");
      // Trusted complete flows can cross Links/subflows. Runtime lookup and timeout
      // are authoritative; preserve the upstream call/return implementation.
      const content = name === "link-call.cjs"
        ? `"use strict";\nconst crypto = require("node:crypto");\n${original.toString().slice(original.toString().indexOf("function createHostLinkCaller(RED)"))}`
          .replace(preflight, "const validation = { ok: true, targetId: target, warnings: [] };")
          .replace(exports, "module.exports = { createHostLinkCaller };")
        : original;
      await writeFile(join(resolve(destination), name), content);
    }
    console.log("Extracted node-red-cli@0.2.18 native adapter; SHA-512 verified; static CLI preflight bypassed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
extract().catch((error) => { console.error(error); process.exitCode = 1; });
