#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveCodeq8PluginInstallPaths } from "./install-codeq8-plugin.mjs";

export const CODEQ8_WORKSPACE_MCP_CONFIG_START =
  "# Codeq8-managed workspace MCP start";
export const CODEQ8_WORKSPACE_MCP_CONFIG_END =
  "# Codeq8-managed workspace MCP end";
export const WORKSPACE_MCP_CAPABILITY = "workspace_mcp_config";
export const WORKSPACE_MCP_CONFIG_RELATIVE_PATH = ".codex/config.toml";

const DENIED_ENV_VAR_PATTERN =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SESSION|COOKIE|WEBHOOK_SECRET|MASTER_KEY)(?:$|_)|^(?:GH_TOKEN|GITHUB_TOKEN|CODE_WEB_CHAT_RUN_TOKEN|CODEQ8_GITHUB_REPOSITORY_TOKEN)$/i;

function normalizeText(value) {
  return String(value ?? "").trim();
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
  const normalizedPath = normalizeText(targetPath);
  if (!normalizedPath) {
    return false;
  }
  try {
    await fs.access(normalizedPath);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const result = {
    repoRoot: "",
    workspacePath: "",
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
    if (key === "workspace-path") {
      result.workspacePath = nextValue;
      index += 1;
    }
  }
  return result;
}

function resolveWorkspacePath({ workspacePath = "", env = process.env } = {}) {
  const explicit = normalizeText(workspacePath);
  if (explicit) {
    return path.resolve(explicit);
  }
  const fromEnv =
    normalizeText(env.CODE_WORKSPACE_PATH) ||
    normalizeText(env.GITHUB_WORKSPACE) ||
    "";
  return fromEnv ? path.resolve(fromEnv) : "";
}

function resolveWorkspaceConfigPath(workspacePath) {
  const normalizedWorkspacePath = path.resolve(normalizeText(workspacePath));
  return normalizedWorkspacePath
    ? path.join(normalizedWorkspacePath, WORKSPACE_MCP_CONFIG_RELATIVE_PATH)
    : "";
}

function isTableHeaderLine(line) {
  return /^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(String(line || ""));
}

function parseMcpServerTableHeader(line) {
  const match = String(line || "").match(/^\s*\[\s*(.+?)\s*\]\s*(?:#.*)?$/);
  if (!match) {
    return null;
  }
  const tableName = normalizeText(match[1]);
  const prefix = "mcp_servers.";
  if (!tableName.startsWith(prefix)) {
    return null;
  }
  const rawServerId = normalizeText(tableName.slice(prefix.length));
  if (!rawServerId) {
    return null;
  }
  let serverId = rawServerId;
  if (
    (rawServerId.startsWith('"') && rawServerId.endsWith('"')) ||
    (rawServerId.startsWith("'") && rawServerId.endsWith("'"))
  ) {
    serverId = rawServerId.slice(1, -1);
  }
  serverId = normalizeText(serverId);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,79}$/.test(serverId)) {
    throw new Error(`Workspace MCP server id is unsupported: ${serverId || rawServerId}.`);
  }
  return serverId;
}

export function extractWorkspaceMcpSections(source) {
  const lines = String(source || "").split(/\r?\n/g);
  const sections = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isTableHeaderLine(lines[index])) {
      continue;
    }
    const serverId = parseMcpServerTableHeader(lines[index]);
    if (!serverId) {
      continue;
    }
    const sectionLines = [lines[index]];
    let nextIndex = index + 1;
    for (; nextIndex < lines.length; nextIndex += 1) {
      if (isTableHeaderLine(lines[nextIndex])) {
        break;
      }
      sectionLines.push(lines[nextIndex]);
    }
    sections.push({
      serverId,
      lines: sectionLines,
    });
    index = nextIndex - 1;
  }
  return sections;
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

function parseTomlStringValue(line) {
  const match = String(line || "").match(/^\s*[A-Za-z0-9_-]+\s*=\s*(["'])(.*)\1\s*(?:#.*)?$/);
  if (!match) {
    return null;
  }
  return match[2];
}

function parseTomlStringLiterals(value) {
  const source = String(value || "");
  const results = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
  let match = pattern.exec(source);
  while (match) {
    const rawValue = match[1] ?? match[2] ?? "";
    results.push(rawValue.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
    match = pattern.exec(source);
  }
  return results;
}

function collectArrayAssignment(lines, startIndex) {
  const collected = [];
  let bracketDepth = 0;
  let sawOpen = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    collected.push(line);
    for (const char of String(line || "")) {
      if (char === "[") {
        bracketDepth += 1;
        sawOpen = true;
      } else if (char === "]") {
        bracketDepth = Math.max(0, bracketDepth - 1);
      }
    }
    if (sawOpen && bracketDepth === 0) {
      return {
        lines: collected,
        endIndex: index,
      };
    }
  }
  return {
    lines: collected,
    endIndex: lines.length - 1,
  };
}

function isDeniedEnvVarName(name) {
  const normalizedName = normalizeText(name);
  return !normalizedName || DENIED_ENV_VAR_PATTERN.test(normalizedName);
}

export function sanitizeWorkspaceMcpSection(section, { workspacePath }) {
  const normalizedWorkspacePath = path.resolve(normalizeText(workspacePath));
  const outputLines = [`[mcp_servers.${section.serverId}]`];
  const blockedEnvVars = [];
  let sawCwd = false;
  const bodyLines = section.lines.slice(1);
  for (let index = 0; index < bodyLines.length; index += 1) {
    const line = bodyLines[index];
    if (/^\s*cwd\s*=/.test(line)) {
      const cwdValue = parseTomlStringValue(line);
      if (cwdValue !== null) {
        const resolvedCwd = path.isAbsolute(cwdValue)
          ? cwdValue
          : path.resolve(normalizedWorkspacePath, cwdValue);
        outputLines.push(`cwd = ${tomlString(resolvedCwd)}`);
        sawCwd = true;
        continue;
      }
    }
    if (/^\s*env_vars\s*=/.test(line)) {
      const assignment = collectArrayAssignment(bodyLines, index);
      const envVars = parseTomlStringLiterals(assignment.lines.join("\n"));
      const allowedEnvVars = [];
      for (const envVar of envVars) {
        if (isDeniedEnvVarName(envVar)) {
          blockedEnvVars.push(envVar);
        } else {
          allowedEnvVars.push(envVar);
        }
      }
      if (allowedEnvVars.length > 0) {
        outputLines.push(`env_vars = ${renderTomlArray(allowedEnvVars)}`);
      }
      index = assignment.endIndex;
      continue;
    }
    outputLines.push(line);
  }
  if (!sawCwd) {
    outputLines.splice(1, 0, `cwd = ${tomlString(normalizedWorkspacePath)}`);
  }
  return {
    serverId: section.serverId,
    lines: outputLines,
    blockedEnvVars,
  };
}

function stripManagedWorkspaceBlock(contents) {
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
    if (trimmed === CODEQ8_WORKSPACE_MCP_CONFIG_START) {
      insideManagedBlock = true;
      removed += 1;
      continue;
    }
    if (insideManagedBlock) {
      if (trimmed === CODEQ8_WORKSPACE_MCP_CONFIG_END) {
        insideManagedBlock = false;
      }
      continue;
    }
    nextLines.push(line);
  }
  if (insideManagedBlock) {
    throw new Error("Codex config has an unterminated Codeq8-managed workspace MCP block.");
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

function buildManagedWorkspaceBlock({
  configRelativePath,
  configHash,
  sanitizedSections,
}) {
  const sectionBlocks = sanitizedSections.map((section) => section.lines.join("\n"));
  return [
    CODEQ8_WORKSPACE_MCP_CONFIG_START,
    `# source = ${normalizeText(configRelativePath) || WORKSPACE_MCP_CONFIG_RELATIVE_PATH}`,
    `# source_sha256 = ${normalizeText(configHash)}`,
    ...sectionBlocks,
    CODEQ8_WORKSPACE_MCP_CONFIG_END,
    "",
  ].join("\n\n");
}

function summarizeResult(result) {
  const parts = [
    `status=${result.status}`,
    `capability=${WORKSPACE_MCP_CAPABILITY}`,
    `servers=${normalizeList(result.serverIds).join(",") || "none"}`,
  ];
  if (result.configPath) {
    parts.push(`config=${result.configPath}`);
  }
  if (result.reason) {
    parts.push(`reason=${result.reason}`);
  }
  if (normalizeList(result.blockedEnvVars).length > 0) {
    parts.push(`blocked_env_vars=${normalizeList(result.blockedEnvVars).join(",")}`);
  }
  return parts.join(" ");
}

export async function syncWorkspaceMcpCodexConfig({
  repoRoot = process.cwd(),
  workspacePath = "",
  env = process.env,
  logger = null,
} = {}) {
  const paths = resolveCodeq8PluginInstallPaths({ repoRoot, env });
  const resolvedWorkspacePath = resolveWorkspacePath({ workspacePath, env });
  const configPath = resolveWorkspaceConfigPath(resolvedWorkspacePath);
  if (!paths.codexHome) {
    return {
      ok: false,
      status: "skipped",
      code: "missing_home",
      reason: "HOME or Codex home could not be resolved.",
      capability: WORKSPACE_MCP_CAPABILITY,
      configPath,
      serverIds: [],
      blockedEnvVars: [],
    };
  }
  if (!resolvedWorkspacePath || !(await pathExists(resolvedWorkspacePath))) {
    return {
      ok: false,
      status: "skipped",
      code: "missing_workspace",
      reason: "Workspace path could not be resolved.",
      capability: WORKSPACE_MCP_CAPABILITY,
      configPath,
      serverIds: [],
      blockedEnvVars: [],
    };
  }
  if (!(await pathExists(configPath))) {
    return {
      ok: true,
      status: "skipped",
      code: "config_missing",
      reason: "Workspace Codex config is not present.",
      capability: WORKSPACE_MCP_CAPABILITY,
      configPath,
      serverIds: [],
      blockedEnvVars: [],
    };
  }

  let workspaceConfig = "";
  let sections = [];
  try {
    workspaceConfig = await fs.readFile(configPath, "utf8");
    sections = extractWorkspaceMcpSections(workspaceConfig);
  } catch (error) {
    return {
      ok: false,
      status: "skipped",
      code: "invalid_workspace_config",
      reason: error instanceof Error ? error.message : String(error),
      capability: WORKSPACE_MCP_CAPABILITY,
      configPath,
      serverIds: [],
      blockedEnvVars: [],
    };
  }
  if (sections.length === 0) {
    return {
      ok: true,
      status: "skipped",
      code: "no_mcp_servers",
      reason: "Workspace Codex config has no MCP server entries.",
      capability: WORKSPACE_MCP_CAPABILITY,
      configPath,
      serverIds: [],
      blockedEnvVars: [],
    };
  }

  const sanitizedSections = sections.map((section) =>
    sanitizeWorkspaceMcpSection(section, { workspacePath: resolvedWorkspacePath }),
  );
  const serverIds = sanitizedSections.map((section) => section.serverId);
  const blockedEnvVars = sanitizedSections.flatMap((section) => section.blockedEnvVars);
  const codexConfigPath = path.join(paths.codexHome, "config.toml");
  const existingConfig = (await pathExists(codexConfigPath))
    ? await fs.readFile(codexConfigPath, "utf8")
    : "";
  let strippedConfig = null;
  try {
    strippedConfig = stripManagedWorkspaceBlock(existingConfig);
  } catch (error) {
    return {
      ok: false,
      status: "skipped",
      code: "invalid_config",
      reason: error instanceof Error ? error.message : String(error),
      capability: WORKSPACE_MCP_CAPABILITY,
      configPath,
      codexConfigPath,
      serverIds,
      blockedEnvVars,
    };
  }
  const collisions = serverIds.filter((serverId) =>
    hasUnmanagedServerTable(strippedConfig.contents, serverId),
  );
  if (collisions.length > 0) {
    return {
      ok: false,
      status: "skipped",
      code: "collision",
      reason: `Codex config already has unmarked MCP server table(s): ${collisions.join(", ")}.`,
      capability: WORKSPACE_MCP_CAPABILITY,
      configPath,
      codexConfigPath,
      serverIds,
      blockedEnvVars,
    };
  }

  const relativeConfigPath = path
    .relative(resolvedWorkspacePath, configPath)
    .split(path.sep)
    .join("/");
  const configHash = crypto.createHash("sha256").update(workspaceConfig).digest("hex");
  const managedBlock = buildManagedWorkspaceBlock({
    configRelativePath: relativeConfigPath,
    configHash,
    sanitizedSections,
  });
  const nextConfig = `${strippedConfig.contents ? `${strippedConfig.contents}\n\n` : ""}${managedBlock}`;
  if (nextConfig === existingConfig) {
    logger?.log?.(`[codeq8-workspace-mcp-config] ${summarizeResult({
      status: "already_configured",
      serverIds,
      configPath,
      blockedEnvVars,
    })}`);
    return {
      ok: true,
      status: "already_configured",
      capability: WORKSPACE_MCP_CAPABILITY,
      configPath,
      codexConfigPath,
      serverIds,
      blockedEnvVars,
    };
  }

  await fs.mkdir(path.dirname(codexConfigPath), { recursive: true });
  await fs.writeFile(codexConfigPath, nextConfig, "utf8");
  logger?.log?.(`[codeq8-workspace-mcp-config] ${summarizeResult({
    status: "configured",
    serverIds,
    configPath,
    blockedEnvVars,
  })}`);
  return {
    ok: true,
    status: "configured",
    capability: WORKSPACE_MCP_CAPABILITY,
    configPath,
    codexConfigPath,
    serverIds,
    blockedEnvVars,
  };
}

async function main() {
  const args = parseArgs();
  const result = await syncWorkspaceMcpCodexConfig({
    repoRoot:
      args.repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    workspacePath: args.workspacePath,
    logger: args.json ? null : console,
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${result.ok ? "ok" : "error"} status=${result.status} servers=${
        normalizeList(result.serverIds).join(",") || "none"
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
