import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CODEQ8_PLAYWRIGHT_MCP_BROWSER,
  CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
  CODEQ8_PLAYWRIGHT_MCP_PACKAGE_SPEC,
  buildPlaywrightMcpBrowserInstallCommand,
  prepareCodeq8PlaywrightMcp,
} from "./prepare-codeq8-playwright-mcp.mjs";

test("buildPlaywrightMcpBrowserInstallCommand uses npm exec for the MCP browser installer", () => {
  const command = buildPlaywrightMcpBrowserInstallCommand({
    npmPath: "/usr/local/bin/npm",
    packageSpec: CODEQ8_PLAYWRIGHT_MCP_PACKAGE_SPEC,
    browser: CODEQ8_PLAYWRIGHT_MCP_BROWSER,
  });

  assert.equal(command.command, "/usr/local/bin/npm");
  assert.deepEqual(command.args, [
    "exec",
    "--yes",
    "--package",
    "@playwright/mcp@latest",
    "--",
    "playwright-mcp",
    "install-browser",
    "chromium",
  ]);
});

test("prepareCodeq8PlaywrightMcp reports prepared when the browser installer succeeds", async () => {
  const calls = [];
  const logs = [];
  const result = await prepareCodeq8PlaywrightMcp({
    repoRoot: process.cwd(),
    npmPath: "/usr/local/bin/npm",
    runCommandImpl: async (call) => {
      calls.push(call);
      return { ok: true, code: 0, stdout: "", stderr: "" };
    },
    logger: {
      log: (message) => logs.push(message),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "prepared");
  assert.equal(result.capability, CODEQ8_PLAYWRIGHT_MCP_CAPABILITY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, path.resolve(process.cwd()));
  assert.deepEqual(calls[0].args.slice(-3), [
    "playwright-mcp",
    "install-browser",
    "chromium",
  ]);
  assert.match(logs.join("\n"), /status=prepared/);
  assert.match(logs.join("\n"), /codeq8_plugin_playwright_mcp/);
});

test("prepareCodeq8PlaywrightMcp warns but does not throw when optional prep fails", async () => {
  const warnings = [];
  const result = await prepareCodeq8PlaywrightMcp({
    repoRoot: process.cwd(),
    npmPath: "/usr/local/bin/npm",
    runCommandImpl: async () => ({
      ok: false,
      code: 1,
      stdout: "",
      stderr: "registry unavailable\nmore details",
    }),
    logger: {
      warn: (message) => warnings.push(message),
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "registry unavailable");
  assert.match(warnings.join("\n"), /::warning::\[codeq8-playwright-mcp\]/);
  assert.match(warnings.join("\n"), /status=skipped/);
});

test("public action prepares Playwright MCP after installing the Codeq8 plugin", () => {
  const actionSource = fs.readFileSync(path.join(process.cwd(), "action.yml"), "utf8");
  const pluginInstallIndex = actionSource.indexOf("scripts/install-codeq8-plugin.mjs");
  const playwrightPrepIndex = actionSource.indexOf("scripts/prepare-codeq8-playwright-mcp.mjs");

  assert.notEqual(pluginInstallIndex, -1);
  assert.notEqual(playwrightPrepIndex, -1);
  assert.equal(pluginInstallIndex < playwrightPrepIndex, true);
  assert.match(actionSource, /--npm-path "\$npm_bin"/);
});
