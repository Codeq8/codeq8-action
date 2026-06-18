import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { syncCodeq8PluginInstall } from "./install-codeq8-plugin.mjs";
import { syncCodeq8PlaywrightMcpCodexConfig } from "./sync-codeq8-playwright-mcp-config.mjs";
import {
  CODEQ8_WORKSPACE_MCP_CONFIG_END,
  CODEQ8_WORKSPACE_MCP_CONFIG_START,
  extractWorkspaceMcpSections,
  sanitizeWorkspaceMcpSection,
  syncWorkspaceMcpCodexConfig,
} from "./sync-workspace-mcp-config.mjs";

const FIXED_NOW = () => new Date("2026-06-17T00:00:00.000Z");

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

async function withWorkspaceMcpFixture(fn) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-workspace-mcp-"));
  try {
    const homePath = path.join(tempRoot, "home");
    const codexHome = path.join(homePath, ".codex-runner");
    const workspacePath = path.join(tempRoot, "workspace");
    const binPath = path.join(tempRoot, "bin");
    const playwrightBrowsersPath = path.join(homePath, ".cache", "codeq8", "ms-playwright");
    const playwrightMcpPath = path.join(binPath, "playwright-mcp");
    await writeExecutable(playwrightMcpPath);
    await fs.mkdir(codexHome, { recursive: true });
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(playwrightBrowsersPath, { recursive: true });
    const env = {
      ...process.env,
      HOME: homePath,
      CODEX_HOME: codexHome,
      GITHUB_WORKSPACE: workspacePath,
      PATH: `${binPath}:${process.env.PATH || ""}`,
      PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath,
      CODEQ8_TRIGGERING_GITHUB_WEB_SESSION_COOKIE: "secret-cookie-value",
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
      workspacePath,
      binPath,
      playwrightMcpPath,
      env,
    });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function writeWorkspaceConfig(workspacePath, contents) {
  const configPath = path.join(workspacePath, ".codex", "config.toml");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, contents, "utf8");
  return configPath;
}

test("extractWorkspaceMcpSections returns only MCP server tables", () => {
  const sections = extractWorkspaceMcpSections([
    'model = "gpt-5"',
    "",
    "[mcp_servers.funplay]",
    'command = "funplay-mcp"',
    "",
    "[tools]",
    'web_search = "disabled"',
    "",
    '[mcp_servers."unity-playtesting"]',
    'command = "unity-playtesting-mcp"',
    "",
  ].join("\n"));

  assert.deepEqual(
    sections.map((section) => section.serverId),
    ["funplay", "unity-playtesting"],
  );
});

test("sanitizeWorkspaceMcpSection adds workspace cwd and filters dangerous forwarded env vars", () => {
  const section = extractWorkspaceMcpSections([
    "[mcp_servers.funplay]",
    'command = "funplay-mcp"',
    'args = ["--port", "8765"]',
    "env_vars = [",
    '  "PATH",',
    '  "UNITY_HOME",',
    '  "GITHUB_TOKEN",',
    '  "FIREBASE_PRIVATE_KEY",',
    "]",
    "",
  ].join("\n"))[0];

  const sanitized = sanitizeWorkspaceMcpSection(section, {
    workspacePath: "/tmp/example-workspace",
  });
  const output = sanitized.lines.join("\n");

  assert.match(output, /\[mcp_servers\.funplay\]/);
  assert.match(output, /cwd = "\/tmp\/example-workspace"/);
  assert.match(output, /"PATH"/);
  assert.match(output, /"UNITY_HOME"/);
  assert.doesNotMatch(output, /GITHUB_TOKEN/);
  assert.doesNotMatch(output, /FIREBASE_PRIVATE_KEY/);
  assert.deepEqual(sanitized.blockedEnvVars, [
    "GITHUB_TOKEN",
    "FIREBASE_PRIVATE_KEY",
  ]);
});

test("sanitizeWorkspaceMcpSection omits cwd for streamable_http MCP servers", () => {
  const section = extractWorkspaceMcpSections([
    "[mcp_servers.funplay]",
    'transport = "streamable_http"',
    'url = "http://127.0.0.1:8765/mcp"',
    'cwd = "./Tools"',
    "",
  ].join("\n"))[0];

  const sanitized = sanitizeWorkspaceMcpSection(section, {
    workspacePath: "/tmp/example-workspace",
  });
  const output = sanitized.lines.join("\n");

  assert.match(output, /\[mcp_servers\.funplay\]/);
  assert.match(output, /transport = "streamable_http"/);
  assert.match(output, /url = "http:\/\/127\.0\.0\.1:8765\/mcp"/);
  assert.doesNotMatch(output, /^\s*cwd\s*=/m);
});

test("sanitizeWorkspaceMcpSection omits cwd for URL-only MCP servers", () => {
  const section = extractWorkspaceMcpSections([
    "[mcp_servers.funplay]",
    'url = "http://127.0.0.1:8765/"',
    "startup_timeout_sec = 5",
    "tool_timeout_sec = 120",
    "enabled = true",
    "",
  ].join("\n"))[0];

  const sanitized = sanitizeWorkspaceMcpSection(section, {
    workspacePath: "/tmp/example-workspace",
  });
  const output = sanitized.lines.join("\n");

  assert.match(output, /\[mcp_servers\.funplay\]/);
  assert.match(output, /url = "http:\/\/127\.0\.0\.1:8765\/"/);
  assert.match(output, /startup_timeout_sec = 5/);
  assert.match(output, /tool_timeout_sec = 120/);
  assert.doesNotMatch(output, /^\s*cwd\s*=/m);
});

test("sanitizeWorkspaceMcpSection drops explicit cwd from URL MCP servers", () => {
  const section = extractWorkspaceMcpSections([
    "[mcp_servers.funplay]",
    'url = "http://127.0.0.1:8765/"',
    'cwd = "./Tools"',
    "",
  ].join("\n"))[0];

  const sanitized = sanitizeWorkspaceMcpSection(section, {
    workspacePath: "/tmp/example-workspace",
  });
  const output = sanitized.lines.join("\n");

  assert.match(output, /url = "http:\/\/127\.0\.0\.1:8765\/"/);
  assert.doesNotMatch(output, /^\s*cwd\s*=/m);
});

test("sync workspace MCP config skips when workspace config is absent", async () => {
  await withWorkspaceMcpFixture(async ({ env, workspacePath }) => {
    const result = await syncWorkspaceMcpCodexConfig({
      repoRoot: process.cwd(),
      env,
      workspacePath,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "skipped");
    assert.equal(result.code, "config_missing");
  });
});

test("sync workspace MCP config imports workspace servers alongside Codeq8 Playwright MCP", async () => {
  await withWorkspaceMcpFixture(async ({ codexHome, env, workspacePath }) => {
    await writeWorkspaceConfig(workspacePath, [
      'model = "gpt-5"',
      "",
      "[mcp_servers.funplay]",
      'command = "funplay-mcp"',
      'args = ["--port", "8765"]',
      "",
      "[mcp_servers.unity_playtesting]",
      'command = "unity-playtesting-mcp"',
      'cwd = "./Tools"',
      "",
    ].join("\n"));
    const codeq8McpResult = await syncCodeq8PlaywrightMcpCodexConfig({
      repoRoot: process.cwd(),
      env,
    });
    assert.equal(codeq8McpResult.ok, true);

    const result = await syncWorkspaceMcpCodexConfig({
      repoRoot: process.cwd(),
      env,
      workspacePath,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "configured");
    assert.deepEqual(result.serverIds, ["funplay", "unity_playtesting"]);

    const config = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
    assert.match(config, /\[mcp_servers\.codeq8_playwright\]/);
    assert.match(config, new RegExp(CODEQ8_WORKSPACE_MCP_CONFIG_START));
    assert.match(config, /\[mcp_servers\.funplay\]/);
    assert.match(config, /\[mcp_servers\.unity_playtesting\]/);
    assert.match(config, new RegExp(`cwd = ${JSON.stringify(workspacePath)}`));
    assert.match(
      config,
      new RegExp(`cwd = ${JSON.stringify(path.join(workspacePath, "Tools"))}`),
    );
    assert.match(config, /source = \.codex\/config\.toml/);
    assert.match(config, new RegExp(CODEQ8_WORKSPACE_MCP_CONFIG_END));
    assert.doesNotMatch(config, /secret-cookie-value/);
  });
});

test("sync workspace MCP config is idempotent and replaces only its managed block", async () => {
  await withWorkspaceMcpFixture(async ({ codexHome, env, workspacePath }) => {
    await writeWorkspaceConfig(workspacePath, [
      "[mcp_servers.funplay]",
      'command = "funplay-mcp"',
      "",
    ].join("\n"));

    const firstResult = await syncWorkspaceMcpCodexConfig({
      repoRoot: process.cwd(),
      env,
      workspacePath,
    });
    assert.equal(firstResult.ok, true);
    const configPath = path.join(codexHome, "config.toml");
    const firstConfig = await fs.readFile(configPath, "utf8");

    const secondResult = await syncWorkspaceMcpCodexConfig({
      repoRoot: process.cwd(),
      env,
      workspacePath,
    });
    assert.equal(secondResult.ok, true);
    assert.equal(secondResult.status, "already_configured");
    assert.equal(await fs.readFile(configPath, "utf8"), firstConfig);

    await writeWorkspaceConfig(workspacePath, [
      "[mcp_servers.funplay]",
      'command = "funplay-mcp"',
      'args = ["--port", "8766"]',
      "",
    ].join("\n"));
    const thirdResult = await syncWorkspaceMcpCodexConfig({
      repoRoot: process.cwd(),
      env,
      workspacePath,
    });
    assert.equal(thirdResult.ok, true);
    const updatedConfig = await fs.readFile(configPath, "utf8");
    assert.match(updatedConfig, /8766/);
    assert.equal((updatedConfig.match(new RegExp(CODEQ8_WORKSPACE_MCP_CONFIG_START, "g")) || []).length, 1);
  });
});

test("sync workspace MCP config refuses to overwrite unmarked existing MCP server tables", async () => {
  await withWorkspaceMcpFixture(async ({ codexHome, env, workspacePath }) => {
    await writeWorkspaceConfig(workspacePath, [
      "[mcp_servers.funplay]",
      'command = "funplay-mcp"',
      "",
    ].join("\n"));
    const configPath = path.join(codexHome, "config.toml");
    const originalConfig = [
      "[mcp_servers.funplay]",
      'command = "/usr/local/bin/user-owned-funplay"',
      "",
    ].join("\n");
    await fs.writeFile(configPath, originalConfig, "utf8");

    const result = await syncWorkspaceMcpCodexConfig({
      repoRoot: process.cwd(),
      env,
      workspacePath,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "collision");
    assert.match(result.reason, /funplay/);
    assert.equal(await fs.readFile(configPath, "utf8"), originalConfig);
  });
});

test("public action syncs workspace MCP config before running the chat bridge", async () => {
  const actionSource = await fs.readFile(path.join(process.cwd(), "action.yml"), "utf8");
  const playwrightSyncIndex = actionSource.indexOf(
    "scripts/sync-codeq8-playwright-mcp-config.mjs",
  );
  const workspaceSyncIndex = actionSource.indexOf(
    "scripts/sync-workspace-mcp-config.mjs",
  );
  const bridgeIndex = actionSource.indexOf(
    "scripts/github-actions-web-chat-runner-bridge.mjs",
  );

  assert.notEqual(playwrightSyncIndex, -1);
  assert.notEqual(workspaceSyncIndex, -1);
  assert.notEqual(bridgeIndex, -1);
  assert.equal(playwrightSyncIndex < workspaceSyncIndex, true);
  assert.equal(workspaceSyncIndex < bridgeIndex, true);
  assert.match(actionSource, /--workspace-path "\$\{GITHUB_WORKSPACE:-\}"/);
});

test("sync workspace MCP config does not create config when no MCP entries exist", async () => {
  await withWorkspaceMcpFixture(async ({ codexHome, env, workspacePath }) => {
    await writeWorkspaceConfig(workspacePath, [
      'model = "gpt-5"',
      "",
      "[tools]",
      'web_search = "disabled"',
      "",
    ].join("\n"));

    const result = await syncWorkspaceMcpCodexConfig({
      repoRoot: process.cwd(),
      env,
      workspacePath,
    });

    assert.equal(result.ok, true);
    assert.equal(result.code, "no_mcp_servers");
    assert.equal(await pathExists(path.join(codexHome, "config.toml")), false);
  });
});
