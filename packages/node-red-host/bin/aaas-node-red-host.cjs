#!/usr/bin/env node
"use strict";

const { resolveConfig, resolveNodeRedModules } = require("../lib/config.cjs");

try {
  const config = resolveConfig();
  process.env.WORKER_CALLBACK_URL = config.callbackUrl;
  process.env.NODE_RED_MODULES = resolveNodeRedModules();
  const supervisor = require("../lib/supervisor.cjs");
  supervisor.installSignalHandlers();
  supervisor.listen();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Node-RED host configuration failed");
  process.exitCode = 1;
}
