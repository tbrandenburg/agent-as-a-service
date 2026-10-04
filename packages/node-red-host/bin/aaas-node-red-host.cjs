#!/usr/bin/env node
"use strict";

const { resolveConfig, resolveNodeRedModules } = require("../lib/config.cjs");

try {
  resolveConfig();
  resolveNodeRedModules();
  require("../lib/supervisor.cjs").listen();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Node-RED host configuration failed");
  process.exitCode = 1;
}
