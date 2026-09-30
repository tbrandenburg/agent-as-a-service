function addCoreProbes(tab, id) {
  const entry = [...tab.nodes, ...tab.configs].find((node) => node.id === "workflow-entry");
  if (!entry) throw new Error("Core entry missing");
  entry.wires[0] = ["aaas-probe-prompt"];
  tab.nodes.push(
    { id: "aaas-probe-prompt", z: id, type: "function", name: "Preserve writer prompt", func: "msg.aaasWriterPrompt=msg.payload;return msg;", outputs: 1, wires: [["aaas-probe-exec"]] },
    { id: "aaas-probe-exec", z: id, type: "exec", name: "Process-relative Exec", command: "pwd", addpay: false, append: "", useSpawn: "false", wires: [["aaas-probe-check"], [], []] },
    { id: "aaas-probe-check", z: id, type: "function", name: "Check process cwd", func: "if (msg.payload.trim() !== env.get('WORKER_CWD')) { node.error('Exec cwd differs from worker cwd'); return null; } msg.filename='aaas-cwd-proof-'+msg.runId+'.txt'; msg.payload=msg.text; return msg;", outputs: 1, wires: [["aaas-probe-file"]] },
    { id: "aaas-probe-file", z: id, type: "file", name: "Relative core File", filename: "filename", filenameType: "msg", appendNewline: false, overwriteFile: "true", createDir: false, encoding: "none", wires: [["aaas-probe-list"]] },
    { id: "aaas-probe-list", z: id, type: "cwd-list-example", name: "Process-relative JS listing", wires: [["aaas-probe-list-check"]] },
    { id: "aaas-probe-list-check", z: id, type: "function", name: "Check JS listing", func: "if (msg.cwdListing?.directory !== env.get('WORKER_CWD') || !msg.cwdListing?.files?.includes(msg.filename)) { node.error('Process-relative JavaScript listing missed File output'); return null; } msg.payload=msg.aaasWriterPrompt;delete msg.aaasWriterPrompt;return msg;", outputs: 1, wires: [["writer-agent"]] },
  );
}
module.exports = { addCoreProbes };
