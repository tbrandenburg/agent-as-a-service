const { createHash } = require("node:crypto");
const { mkdtemp, writeFile, mkdir, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { execFileSync } = require("node:child_process");

// Extract the unchanged upstream adapter without installing its unused CLI runtime.
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
      const content = execFileSync("tar", ["-xOf", path, source], { timeout: 10_000 });
      await writeFile(join(resolve(destination), name), content);
    }
    console.log("Extracted unchanged node-red-cli@0.2.18 adapter; SHA-512 verified");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
extract().catch((error) => { console.error(error); process.exitCode = 1; });
