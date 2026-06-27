import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { syncCodeq8PluginInstall } from "./install-codeq8-plugin.mjs";
import {
  CODEQ8_PLAYWRIGHT_MCP_CONFIG_END,
  CODEQ8_PLAYWRIGHT_MCP_CONFIG_START,
  CODEQ8_PLAYWRIGHT_MCP_SERVER_ID,
  syncCodeq8PlaywrightMcpCodexConfig,
} from "./sync-codeq8-playwright-mcp-config.mjs";

const FIXED_NOW = () => new Date("2026-06-16T00:00:00.000Z");

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function writeExecutable(filePath, source = "#!/bin/sh\nexit 0\n") {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, source, "utf8");
  await fs.chmod(filePath, 0o755);
}

async function withMcpConfigFixture(fn) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-mcp-config-"));
  try {
    const homePath = path.join(tempRoot, "home");
    const codexHome = path.join(homePath, ".codex-runner");
    const binPath = path.join(tempRoot, "bin");
    const playwrightBrowsersPath = path.join(homePath, ".cache", "codeq8", "ms-playwright");
    const playwrightMcpPath = path.join(binPath, "playwright-mcp");
    await writeExecutable(playwrightMcpPath);
    await fs.mkdir(codexHome, { recursive: true });
    await fs.mkdir(playwrightBrowsersPath, { recursive: true });
    const env = {
      ...process.env,
      HOME: homePath,
      CODEX_HOME: codexHome,
      PATH: `${binPath}:${process.env.PATH || ""}`,
      PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath,
      CODEQ8_TRIGGERING_GITHUB_WEB_SESSION_COOKIE: "secret-cookie-value",
      CODE_WEB_CHAT_RUN_TOKEN: "secret-run-token",
    };
    const installResult = await syncCodeq8PluginInstall({
      repoRoot: process.cwd(),
      env,
      sourceRef: "public-action-sha",
      now: FIXED_NOW,
    });
    assert.equal(installResult.ok, true);
    await fn({
      tempRoot,
      homePath,
      codexHome,
      binPath,
      playwrightMcpPath,
      env,
    });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test("sync Codeq8 Playwright MCP config creates a managed Codex config block without secrets", async () => {
  await withMcpConfigFixture(async ({ codexHome, playwrightMcpPath, env }) => {
    const configPath = path.join(codexHome, "config.toml");
    await fs.writeFile(
      configPath,
      [
        'model = "gpt-5.5"',
        "",
        "[mcp_servers.playwright]",
        'command = "/usr/local/bin/user-playwright"',
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await syncCodeq8PlaywrightMcpCodexConfig({
      repoRoot: process.cwd(),
      env,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "configured");
    assert.equal(result.serverId, CODEQ8_PLAYWRIGHT_MCP_SERVER_ID);
    assert.equal(result.playwrightMcpPath, playwrightMcpPath);

    const config = await fs.readFile(configPath, "utf8");
    const pluginInstallPath = path.join(codexHome, "plugins", "codeq8");
    const initPagePath = path.join(pluginInstallPath, "playwright-mcp-auth-init.ts");
    assert.match(config, /model = "gpt-5\.5"/);
    assert.match(config, /\[mcp_servers\.playwright\]/);
    assert.match(config, new RegExp(`\\[mcp_servers\\.${CODEQ8_PLAYWRIGHT_MCP_SERVER_ID}\\]`));
    assert.match(config, new RegExp(`command = ${JSON.stringify(playwrightMcpPath)}`));
    assert.match(config, new RegExp(`cwd = ${JSON.stringify(pluginInstallPath)}`));
    assert.match(config, new RegExp(JSON.stringify(initPagePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(config, /env_vars = \[/);
    assert.match(config, /"CODEQ8_TRIGGERING_GITHUB_WEB_SESSION_COOKIE"/);
    assert.match(config, /"CODE_WEB_CHAT_RUN_TOKEN"/);
    assert.match(config, /"PLAYWRIGHT_BROWSERS_PATH"/);
    assert.doesNotMatch(config, /secret-cookie-value/);
    assert.doesNotMatch(config, /secret-run-token/);
    assert.doesNotMatch(config, /^env =/m);
    assert.equal(await pathExists(path.join(codexHome, "auth.json")), false);
    assert.equal(await pathExists(path.join(codexHome, "sessions")), false);
  });
});

test("sync Codeq8 Playwright MCP config is idempotent when the managed block already matches", async () => {
  await withMcpConfigFixture(async ({ codexHome, env }) => {
    const firstResult = await syncCodeq8PlaywrightMcpCodexConfig({
      repoRoot: process.cwd(),
      env,
    });
    assert.equal(firstResult.ok, true);
    const configPath = path.join(codexHome, "config.toml");
    const firstConfig = await fs.readFile(configPath, "utf8");

    const secondResult = await syncCodeq8PlaywrightMcpCodexConfig({
      repoRoot: process.cwd(),
      env,
    });
    const secondConfig = await fs.readFile(configPath, "utf8");

    assert.equal(secondResult.ok, true);
    assert.equal(secondResult.status, "already_configured");
    assert.equal(secondConfig, firstConfig);
    assert.equal((secondConfig.match(new RegExp(CODEQ8_PLAYWRIGHT_MCP_CONFIG_START, "g")) || []).length, 1);
    assert.equal((secondConfig.match(new RegExp(CODEQ8_PLAYWRIGHT_MCP_CONFIG_END, "g")) || []).length, 1);
  });
});

test("sync Codeq8 Playwright MCP config replaces only the managed block when paths change", async () => {
  await withMcpConfigFixture(async ({ codexHome, binPath, env }) => {
    const firstResult = await syncCodeq8PlaywrightMcpCodexConfig({
      repoRoot: process.cwd(),
      env,
    });
    assert.equal(firstResult.ok, true);

    const nextPlaywrightMcpPath = path.join(binPath, "playwright-mcp-next");
    await writeExecutable(nextPlaywrightMcpPath);
    const secondResult = await syncCodeq8PlaywrightMcpCodexConfig({
      repoRoot: process.cwd(),
      env,
      playwrightMcpPath: nextPlaywrightMcpPath,
    });

    assert.equal(secondResult.ok, true);
    assert.equal(secondResult.status, "configured");
    const config = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
    assert.match(config, new RegExp(JSON.stringify(nextPlaywrightMcpPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal((config.match(new RegExp(CODEQ8_PLAYWRIGHT_MCP_CONFIG_START, "g")) || []).length, 1);
  });
});

test("sync Codeq8 Playwright MCP config refuses to overwrite an unmarked server table", async () => {
  await withMcpConfigFixture(async ({ codexHome, env }) => {
    const configPath = path.join(codexHome, "config.toml");
    const originalConfig = [
      `[mcp_servers.${CODEQ8_PLAYWRIGHT_MCP_SERVER_ID}]`,
      'command = "/usr/local/bin/user-owned"',
      "",
    ].join("\n");
    await fs.writeFile(configPath, originalConfig, "utf8");

    const result = await syncCodeq8PlaywrightMcpCodexConfig({
      repoRoot: process.cwd(),
      env,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "collision");
    assert.match(result.reason, /unmarked/);
    assert.equal(await fs.readFile(configPath, "utf8"), originalConfig);
  });
});

test("Codeq8 public action syncs Playwright MCP config after package and browser preparation", async () => {
  const actionSource = await fs.readFile(path.join(process.cwd(), "action.yml"), "utf8");
  const syncSource = await fs.readFile(
    path.join(process.cwd(), "scripts", "sync-codeq8-playwright-mcp-config.mjs"),
    "utf8",
  );
  const installIndex = actionSource.indexOf("scripts/install-codeq8-plugin.mjs");
  const globalToolsIndex = actionSource.indexOf("scripts/runner-global-cli-tools.mjs");
  const browserPrepIndex = actionSource.indexOf("scripts/prepare-codeq8-playwright-mcp.mjs");
  const configSyncIndex = actionSource.indexOf(
    "scripts/sync-codeq8-playwright-mcp-config.mjs",
  );

  assert.notEqual(installIndex, -1);
  assert.notEqual(globalToolsIndex, -1);
  assert.notEqual(browserPrepIndex, -1);
  assert.notEqual(configSyncIndex, -1);
  assert.equal(installIndex < globalToolsIndex, true);
  assert.equal(globalToolsIndex < browserPrepIndex, true);
  assert.equal(browserPrepIndex < configSyncIndex, true);
  assert.doesNotMatch(actionSource, /CODEX_HOME=/);
  assert.doesNotMatch(syncSource, /auth\.json|sessions/);
  assert.doesNotMatch(syncSource, /secret-cookie-value/);
  assert.match(syncSource, /env_vars/);
  assert.match(syncSource, /config\.toml/);
});
