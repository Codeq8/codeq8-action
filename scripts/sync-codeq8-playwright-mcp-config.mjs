#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CODEQ8_PLUGIN_NAME,
  resolveCodeq8PluginInstallPaths,
} from "./install-codeq8-plugin.mjs";
import {
  CODEQ8_PLAYWRIGHT_MCP_BINARY,
  CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
} from "./prepare-codeq8-playwright-mcp.mjs";

export const CODEQ8_PLAYWRIGHT_MCP_SERVER_ID = "codeq8_playwright";
export const CODEQ8_PLAYWRIGHT_MCP_CONFIG_TARGET =
  `mcp:${CODEQ8_PLAYWRIGHT_MCP_SERVER_ID}`;
export const CODEQ8_PLAYWRIGHT_MCP_CONFIG_START =
  `# Codeq8-managed MCP start: ${CODEQ8_PLAYWRIGHT_MCP_SERVER_ID}`;
export const CODEQ8_PLAYWRIGHT_MCP_CONFIG_END =
  `# Codeq8-managed MCP end: ${CODEQ8_PLAYWRIGHT_MCP_SERVER_ID}`;

const REQUIRED_ENV_VARS = Object.freeze([
  "CODEQ8_E2E_GITHUB_WEB_SESSION_COOKIE",
  "CODEQ8_GITHUB_WEB_SESSION_COOKIE",
  "CODEQ8_TRIGGERING_GITHUB_WEB_SESSION_COOKIE",
  "CODE_WEB_CHAT_RUN_TOKEN",
  "CODE_WORKSPACE_REPOSITORY",
  "CODE_CHAT_THREAD_ID",
  "CODE_CHAT_RUN_ID",
  "PLAYWRIGHT_BROWSERS_PATH",
]);

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeList(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((entry) => normalizeText(entry))
        .filter(Boolean),
    ),
  );
}

async function pathExists(targetPath) {
  const normalized = normalizeText(targetPath);
  if (!normalized) {
    return false;
  }
  try {
    await fs.access(normalized);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(targetPath) {
  return JSON.parse(await fs.readFile(targetPath, "utf8"));
}

function parseArgs(argv = process.argv.slice(2)) {
  const result = {
    repoRoot: "",
    serverId: CODEQ8_PLAYWRIGHT_MCP_SERVER_ID,
    playwrightMcpPath: "",
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const current = normalizeText(argv[index]);
    if (current === "--json") {
      result.json = true;
      continue;
    }
    if (!current.startsWith("--")) {
      continue;
    }
    const key = current.slice(2);
    const nextValue = normalizeText(argv[index + 1]);
    if (!nextValue || nextValue.startsWith("--")) {
      continue;
    }
    if (key === "repo-root") {
      result.repoRoot = nextValue;
      index += 1;
      continue;
    }
    if (key === "server-id") {
      result.serverId = nextValue;
      index += 1;
      continue;
    }
    if (key === "playwright-mcp-path") {
      result.playwrightMcpPath = nextValue;
      index += 1;
    }
  }
  return result;
}

function isValidServerId(value) {
  return /^[A-Za-z0-9_][A-Za-z0-9_-]{0,79}$/.test(normalizeText(value));
}

async function runProcessCapture(command, args, { cwd, env } = {}) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: cwd || process.cwd(),
      env: env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        stdout,
        stderr,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (code) => {
      resolve({
        ok: Number(code || 0) === 0,
        stdout,
        stderr,
        reason: Number(code || 0) === 0 ? "" : `exit_code=${Number(code || 0)}`,
      });
    });
  });
}

async function resolveExecutablePath({ explicitPath = "", binaryName, env, cwd }) {
  const explicit = normalizeText(explicitPath);
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!(await pathExists(resolved))) {
      throw new Error(`${binaryName} executable was not found at ${resolved}.`);
    }
    return resolved;
  }

  const commandName = normalizeText(binaryName);
  const whichResult = await runProcessCapture("/bin/bash", ["-lc", `command -v ${commandName}`], {
    cwd,
    env,
  });
  const resolved = normalizeText(whichResult.stdout);
  if (whichResult.ok && resolved && (await pathExists(resolved))) {
    return resolved;
  }
  throw new Error(`${commandName} executable was not found.`);
}

function resolvePluginInitPageArg({ arg, pluginInstallPath }) {
  const normalizedArg = normalizeText(arg);
  if (!normalizedArg) {
    return normalizedArg;
  }
  if (normalizedArg.startsWith("--init-page=")) {
    const initPage = normalizedArg.slice("--init-page=".length);
    const resolvedInitPage = path.isAbsolute(initPage)
      ? initPage
      : path.join(pluginInstallPath, initPage);
    return `--init-page=${resolvedInitPage}`;
  }
  return normalizedArg;
}

export async function readInstalledPluginPlaywrightMcpConfig(pluginInstallPath) {
  const mcpConfigPath = path.join(pluginInstallPath, ".mcp.json");
  const mcpConfig = normalizeObject(await readJsonFile(mcpConfigPath));
  const playwrightConfig = normalizeObject(mcpConfig.playwright);
  const command = normalizeText(playwrightConfig.command);
  const args = normalizeList(playwrightConfig.args);
  const envVars = normalizeList(playwrightConfig.env_vars);
  if (!command) {
    throw new Error("installed Codeq8 plugin Playwright MCP command is missing.");
  }
  if (Object.keys(normalizeObject(playwrightConfig.env)).length > 0) {
    throw new Error("installed Codeq8 plugin Playwright MCP config must not contain static env.");
  }
  for (const requiredEnvVar of REQUIRED_ENV_VARS) {
    if (!envVars.includes(requiredEnvVar)) {
      throw new Error(
        `installed Codeq8 plugin Playwright MCP env_vars is missing ${requiredEnvVar}.`,
      );
    }
  }
  return {
    command,
    args,
    envVars,
    startupTimeoutSec: Number(playwrightConfig.startup_timeout_sec || 20),
    toolTimeoutSec: Number(playwrightConfig.tool_timeout_sec || 60),
  };
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function renderTomlArray(values) {
  const normalizedValues = normalizeList(values);
  if (normalizedValues.length === 0) {
    return "[]";
  }
  return [
    "[",
    ...normalizedValues.map((value) => `  ${tomlString(value)},`),
    "]",
  ].join("\n");
}

function stripManagedBlock(contents) {
  const source = String(contents || "");
  if (!source) {
    return { contents: "", removed: 0 };
  }
  const lines = source.split(/\r?\n/g);
  const nextLines = [];
  let removed = 0;
  let insideManagedBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === CODEQ8_PLAYWRIGHT_MCP_CONFIG_START) {
      insideManagedBlock = true;
      removed += 1;
      continue;
    }
    if (insideManagedBlock) {
      if (trimmed === CODEQ8_PLAYWRIGHT_MCP_CONFIG_END) {
        insideManagedBlock = false;
      }
      continue;
    }
    nextLines.push(line);
  }
  if (insideManagedBlock) {
    throw new Error("Codex config has an unterminated Codeq8-managed MCP block.");
  }
  return {
    contents: nextLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd(),
    removed,
  };
}

function hasUnmanagedServerTable(contents, serverId) {
  const escapedServerId = normalizeText(serverId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^\\s*\\[\\s*mcp_servers\\.(?:${escapedServerId}|"${escapedServerId}"|'${escapedServerId}')\\s*\\]\\s*$`,
    "m",
  );
  return pattern.test(String(contents || ""));
}

export function buildCodeq8PlaywrightMcpManagedBlock({
  serverId = CODEQ8_PLAYWRIGHT_MCP_SERVER_ID,
  playwrightMcpPath,
  pluginInstallPath,
  pluginMcpConfig,
}) {
  const normalizedServerId = normalizeText(serverId);
  if (!isValidServerId(normalizedServerId)) {
    throw new Error("Codeq8 Playwright MCP server id is invalid.");
  }
  const normalizedPlaywrightMcpPath = normalizeText(playwrightMcpPath);
  const normalizedPluginInstallPath = path.resolve(pluginInstallPath);
  const normalizedPluginMcpConfig = normalizeObject(pluginMcpConfig);
  const sourceArgs = normalizeList(normalizedPluginMcpConfig.args);
  const args = [];
  for (let index = 0; index < sourceArgs.length; index += 1) {
    const current = sourceArgs[index];
    if (current === "--init-page") {
      const nextArg = normalizeText(sourceArgs[index + 1]);
      args.push(current);
      args.push(
        path.isAbsolute(nextArg) ? nextArg : path.join(normalizedPluginInstallPath, nextArg),
      );
      index += 1;
      continue;
    }
    args.push(
      resolvePluginInitPageArg({
        arg: current,
        pluginInstallPath: normalizedPluginInstallPath,
      }),
    );
  }

  return [
    CODEQ8_PLAYWRIGHT_MCP_CONFIG_START,
    `[mcp_servers.${normalizedServerId}]`,
    `command = ${tomlString(normalizedPlaywrightMcpPath)}`,
    `args = ${renderTomlArray(args)}`,
    `cwd = ${tomlString(normalizedPluginInstallPath)}`,
    `env_vars = ${renderTomlArray(normalizedPluginMcpConfig.envVars)}`,
    `startup_timeout_sec = ${Number(normalizedPluginMcpConfig.startupTimeoutSec || 20)}`,
    `tool_timeout_sec = ${Number(normalizedPluginMcpConfig.toolTimeoutSec || 60)}`,
    "enabled = true",
    CODEQ8_PLAYWRIGHT_MCP_CONFIG_END,
    "",
  ].join("\n");
}

export async function syncCodeq8PlaywrightMcpCodexConfig({
  repoRoot = process.cwd(),
  env = process.env,
  serverId = CODEQ8_PLAYWRIGHT_MCP_SERVER_ID,
  playwrightMcpPath = "",
  logger = null,
} = {}) {
  const paths = resolveCodeq8PluginInstallPaths({ repoRoot, env });
  const normalizedServerId = normalizeText(serverId) || CODEQ8_PLAYWRIGHT_MCP_SERVER_ID;
  if (!isValidServerId(normalizedServerId)) {
    return {
      ok: false,
      status: "skipped",
      code: "invalid_server_id",
      reason: "Codeq8 Playwright MCP server id is invalid.",
      capability: CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
      target: CODEQ8_PLAYWRIGHT_MCP_CONFIG_TARGET,
    };
  }
  if (!paths.codexHome || !paths.pluginInstallPath) {
    return {
      ok: false,
      status: "skipped",
      code: "missing_home",
      reason: "HOME or Codex home could not be resolved.",
      capability: CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
      target: CODEQ8_PLAYWRIGHT_MCP_CONFIG_TARGET,
    };
  }
  if (!(await pathExists(path.join(paths.pluginInstallPath, ".mcp.json")))) {
    return {
      ok: false,
      status: "skipped",
      code: "plugin_missing",
      reason: `installed Codeq8 plugin MCP config is missing for ${CODEQ8_PLUGIN_NAME}.`,
      capability: CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
      target: CODEQ8_PLAYWRIGHT_MCP_CONFIG_TARGET,
    };
  }

  let pluginMcpConfig = null;
  let resolvedPlaywrightMcpPath = "";
  try {
    pluginMcpConfig = await readInstalledPluginPlaywrightMcpConfig(paths.pluginInstallPath);
    resolvedPlaywrightMcpPath = await resolveExecutablePath({
      explicitPath: playwrightMcpPath,
      binaryName: CODEQ8_PLAYWRIGHT_MCP_BINARY,
      env,
      cwd: paths.repoRoot,
    });
  } catch (error) {
    return {
      ok: false,
      status: "skipped",
      code: "invalid_source",
      reason: error instanceof Error ? error.message : String(error),
      capability: CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
      target: CODEQ8_PLAYWRIGHT_MCP_CONFIG_TARGET,
    };
  }

  const managedBlock = buildCodeq8PlaywrightMcpManagedBlock({
    serverId: normalizedServerId,
    playwrightMcpPath: resolvedPlaywrightMcpPath,
    pluginInstallPath: paths.pluginInstallPath,
    pluginMcpConfig,
  });
  const configPath = path.join(paths.codexHome, "config.toml");
  const existingConfig = (await pathExists(configPath))
    ? await fs.readFile(configPath, "utf8")
    : "";
  let strippedConfig = null;
  try {
    strippedConfig = stripManagedBlock(existingConfig);
  } catch (error) {
    return {
      ok: false,
      status: "skipped",
      code: "invalid_config",
      reason: error instanceof Error ? error.message : String(error),
      capability: CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
      target: CODEQ8_PLAYWRIGHT_MCP_CONFIG_TARGET,
      configPath,
    };
  }
  if (hasUnmanagedServerTable(strippedConfig.contents, normalizedServerId)) {
    return {
      ok: false,
      status: "skipped",
      code: "collision",
      reason: `Codex config already has an unmarked [mcp_servers.${normalizedServerId}] table.`,
      capability: CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
      target: CODEQ8_PLAYWRIGHT_MCP_CONFIG_TARGET,
      configPath,
    };
  }

  const nextConfig = `${strippedConfig.contents ? `${strippedConfig.contents}\n\n` : ""}${managedBlock}`;
  if (nextConfig === existingConfig) {
    logger?.log?.(
      `[codeq8-playwright-mcp-config] status=already-configured capability=${CODEQ8_PLAYWRIGHT_MCP_CAPABILITY} server=${normalizedServerId}`,
    );
    return {
      ok: true,
      status: "already_configured",
      capability: CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
      target: CODEQ8_PLAYWRIGHT_MCP_CONFIG_TARGET,
      serverId: normalizedServerId,
      configPath,
      playwrightMcpPath: resolvedPlaywrightMcpPath,
      pluginInstallPath: paths.pluginInstallPath,
    };
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, nextConfig, "utf8");
  logger?.log?.(
    `[codeq8-playwright-mcp-config] status=configured capability=${CODEQ8_PLAYWRIGHT_MCP_CAPABILITY} server=${normalizedServerId}`,
  );
  return {
    ok: true,
    status: "configured",
    capability: CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
    target: CODEQ8_PLAYWRIGHT_MCP_CONFIG_TARGET,
    serverId: normalizedServerId,
    configPath,
    playwrightMcpPath: resolvedPlaywrightMcpPath,
    pluginInstallPath: paths.pluginInstallPath,
  };
}

async function main() {
  const args = parseArgs();
  const result = await syncCodeq8PlaywrightMcpCodexConfig({
    repoRoot:
      args.repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    serverId: args.serverId,
    playwrightMcpPath: args.playwrightMcpPath,
    logger: args.json ? null : console,
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${result.ok ? "ok" : "error"} status=${result.status} server=${
        result.serverId || args.serverId
      } config=${result.configPath || ""}\n`,
    );
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

const executedPath = normalizeText(process.argv[1]);
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
  await main();
}
