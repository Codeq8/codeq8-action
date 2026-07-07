#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  WORKSPACE_MCP_CONFIG_RELATIVE_PATH,
  extractWorkspaceMcpSections,
} from "./sync-workspace-mcp-config.mjs";
import {
  CODEQ8_PLAYWRIGHT_MCP_BROWSER,
  CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
  CODEQ8_PLAYWRIGHT_MCP_PACKAGE_NAME,
  parsePlaywrightInstallLocations,
} from "./prepare-codeq8-playwright-mcp.mjs";

export const WORKSPACE_PLAYWRIGHT_MCP_CAPABILITY =
  "workspace_playwright_mcp_browser";

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

function parseTomlStringValue(line) {
  const match = String(line || "").match(/^\s*[A-Za-z0-9_-]+\s*=\s*(["'])(.*)\1\s*(?:#.*)?$/);
  if (!match) {
    return null;
  }
  return match[2];
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

function readSectionString(section, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  for (const line of section.lines.slice(1)) {
    if (!pattern.test(line)) {
      continue;
    }
    return normalizeText(parseTomlStringValue(line));
  }
  return "";
}

function readSectionStringArray(section, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  const lines = section.lines.slice(1);
  for (let index = 0; index < lines.length; index += 1) {
    if (!pattern.test(lines[index])) {
      continue;
    }
    const assignment = collectArrayAssignment(lines, index);
    return parseTomlStringLiterals(assignment.lines.join("\n"));
  }
  return [];
}

function commandBaseName(command) {
  return path.basename(normalizeText(command)).toLowerCase();
}

function isPlaywrightMcpPackageSpec(value) {
  return /^@playwright\/mcp(?:@.+)?$/i.test(normalizeText(value));
}

function resolveBrowserFromArgs(args = []) {
  const normalizedArgs = normalizeList(args);
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const current = normalizedArgs[index];
    if (current.startsWith("--browser=")) {
      return normalizeText(current.slice("--browser=".length)) || CODEQ8_PLAYWRIGHT_MCP_BROWSER;
    }
    if (current === "--browser") {
      return normalizeText(normalizedArgs[index + 1]) || CODEQ8_PLAYWRIGHT_MCP_BROWSER;
    }
  }
  return CODEQ8_PLAYWRIGHT_MCP_BROWSER;
}

function buildWorkspacePlaywrightMcpInvocation(section) {
  const command = readSectionString(section, "command");
  const args = readSectionStringArray(section, "args");
  const browser = resolveBrowserFromArgs(args);
  const commandName = commandBaseName(command);
  if (!command) {
    return null;
  }

  if (commandName === "playwright-mcp") {
    return {
      serverId: section.serverId,
      command,
      prefixArgs: [],
      browser,
    };
  }

  if (commandName === "pnpm") {
    const dlxIndex = args.findIndex((arg) => normalizeText(arg) === "dlx");
    if (dlxIndex === -1) {
      return null;
    }
    const packageIndex = args.findIndex(
      (arg, index) => index > dlxIndex && isPlaywrightMcpPackageSpec(arg),
    );
    if (packageIndex === -1) {
      return null;
    }
    return {
      serverId: section.serverId,
      command,
      prefixArgs: args.slice(0, packageIndex + 1),
      browser,
    };
  }

  if (commandName === "npx") {
    const packageIndex = args.findIndex((arg) => isPlaywrightMcpPackageSpec(arg));
    if (packageIndex === -1) {
      return null;
    }
    return {
      serverId: section.serverId,
      command,
      prefixArgs: args.slice(0, packageIndex + 1),
      browser,
    };
  }

  return null;
}

export function collectWorkspacePlaywrightMcpInvocations(sections = []) {
  return sections
    .map((section) => buildWorkspacePlaywrightMcpInvocation(section))
    .filter(Boolean);
}

function buildDryRunArgs(invocation) {
  return [
    ...invocation.prefixArgs.map((arg) => normalizeText(arg)).filter(Boolean),
    "install-browser",
    normalizeText(invocation.browser) || CODEQ8_PLAYWRIGHT_MCP_BROWSER,
    "--dry-run",
  ];
}

function buildInstallArgs(invocation) {
  return [
    ...invocation.prefixArgs.map((arg) => normalizeText(arg)).filter(Boolean),
    "install-browser",
    normalizeText(invocation.browser) || CODEQ8_PLAYWRIGHT_MCP_BROWSER,
    "--no-progress",
  ];
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
        code: -1,
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (code) => {
      resolve({
        ok: Number(code ?? -1) === 0,
        code: Number(code ?? -1),
        stdout,
        stderr,
      });
    });
  });
}

async function hasFileNamed(rootPath, names, maxDepth = 8) {
  const normalizedRootPath = normalizeText(rootPath);
  if (!normalizedRootPath || maxDepth < 0) {
    return false;
  }
  let children = [];
  try {
    children = await fs.readdir(normalizedRootPath, { withFileTypes: true });
  } catch {
    return false;
  }
  const nameSet = new Set(normalizeList(names));
  for (const child of children) {
    const childPath = path.join(normalizedRootPath, child.name);
    if (child.isFile() && nameSet.has(child.name)) {
      return true;
    }
    if (child.isDirectory() && (await hasFileNamed(childPath, names, maxDepth - 1))) {
      return true;
    }
  }
  return false;
}

async function isInstallLocationComplete(installLocation) {
  const normalizedLocation = normalizeText(installLocation);
  if (!normalizedLocation || !(await pathExists(normalizedLocation))) {
    return false;
  }
  if (!(await pathExists(path.join(normalizedLocation, "INSTALLATION_COMPLETE")))) {
    return false;
  }
  const baseName = path.basename(normalizedLocation);
  if (baseName.startsWith("chromium_headless_shell-")) {
    return await hasFileNamed(normalizedLocation, [
      "chrome-headless-shell",
      "chrome-headless-shell.exe",
    ]);
  }
  if (baseName.startsWith("chromium-")) {
    return await hasFileNamed(normalizedLocation, [
      "Google Chrome for Testing",
      "chrome",
      "chrome.exe",
    ]);
  }
  return true;
}

async function allInstallLocationsComplete(installLocations = []) {
  if (!Array.isArray(installLocations) || installLocations.length === 0) {
    return false;
  }
  for (const installLocation of installLocations) {
    if (!(await isInstallLocationComplete(installLocation))) {
      return false;
    }
  }
  return true;
}

function summarizeFirstLine(value) {
  return normalizeText(value).split("\n")[0] || "unknown error";
}

export async function prepareWorkspacePlaywrightMcpBrowsers({
  workspacePath = "",
  env = process.env,
  runCommandImpl = runProcessCapture,
  logger = null,
} = {}) {
  const resolvedWorkspacePath = resolveWorkspacePath({ workspacePath, env });
  const configPath = resolveWorkspaceConfigPath(resolvedWorkspacePath);
  if (!resolvedWorkspacePath || !(await pathExists(configPath))) {
    return {
      ok: true,
      status: "skipped",
      code: "config_missing",
      capability: WORKSPACE_PLAYWRIGHT_MCP_CAPABILITY,
      configPath,
      preparedServers: [],
    };
  }

  const workspaceConfig = await fs.readFile(configPath, "utf8");
  const sections = extractWorkspaceMcpSections(workspaceConfig);
  const invocations = collectWorkspacePlaywrightMcpInvocations(sections);
  if (invocations.length === 0) {
    return {
      ok: true,
      status: "skipped",
      code: "no_workspace_playwright_mcp",
      capability: WORKSPACE_PLAYWRIGHT_MCP_CAPABILITY,
      configPath,
      preparedServers: [],
    };
  }

  const preparedServers = [];
  for (const invocation of invocations) {
    const dryRun = await runCommandImpl(invocation.command, buildDryRunArgs(invocation), {
      cwd: resolvedWorkspacePath,
      env,
    });
    if (!dryRun.ok) {
      throw new Error(
        `Unable to inspect workspace Playwright MCP browser payload for ${invocation.serverId} (${summarizeFirstLine(dryRun.stderr || dryRun.stdout)}).`,
      );
    }
    const installLocations = parsePlaywrightInstallLocations(dryRun.stdout);
    if (await allInstallLocationsComplete(installLocations)) {
      logger?.log?.(
        `[codeq8-workspace-playwright-mcp] status=already-prepared capability=${WORKSPACE_PLAYWRIGHT_MCP_CAPABILITY} server=${invocation.serverId} package=${CODEQ8_PLAYWRIGHT_MCP_PACKAGE_NAME} browser=${invocation.browser}`,
      );
      preparedServers.push({
        serverId: invocation.serverId,
        status: "already-prepared",
        browser: invocation.browser,
        installLocations,
      });
      continue;
    }

    const install = await runCommandImpl(invocation.command, buildInstallArgs(invocation), {
      cwd: resolvedWorkspacePath,
      env,
    });
    if (!install.ok) {
      throw new Error(
        `Unable to install workspace Playwright MCP browser payload for ${invocation.serverId} (${summarizeFirstLine(install.stderr || install.stdout)}).`,
      );
    }
    const postInstallDryRun = await runCommandImpl(invocation.command, buildDryRunArgs(invocation), {
      cwd: resolvedWorkspacePath,
      env,
    });
    const postInstallLocations = postInstallDryRun.ok
      ? parsePlaywrightInstallLocations(postInstallDryRun.stdout)
      : installLocations;
    if (!(await allInstallLocationsComplete(postInstallLocations))) {
      throw new Error(
        `Workspace Playwright MCP browser install completed for ${invocation.serverId}, but expected browser payload paths are incomplete.`,
      );
    }
    logger?.log?.(
      `[codeq8-workspace-playwright-mcp] status=prepared capability=${WORKSPACE_PLAYWRIGHT_MCP_CAPABILITY} server=${invocation.serverId} package=${CODEQ8_PLAYWRIGHT_MCP_PACKAGE_NAME} browser=${invocation.browser}`,
    );
    preparedServers.push({
      serverId: invocation.serverId,
      status: "prepared",
      browser: invocation.browser,
      installLocations: postInstallLocations,
    });
  }

  return {
    ok: true,
    status: "prepared",
    capability: WORKSPACE_PLAYWRIGHT_MCP_CAPABILITY,
    configPath,
    preparedServers,
  };
}

async function main() {
  const args = parseArgs();
  try {
    const result = await prepareWorkspacePlaywrightMcpBrowsers({
      workspacePath: args.workspacePath,
      logger: args.json ? null : console,
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      `ok status=${result.status} capability=${WORKSPACE_PLAYWRIGHT_MCP_CAPABILITY} servers=${
        result.preparedServers?.map((server) => server.serverId).join(",") || "none"
      }\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

const executedPath = normalizeText(process.argv[1]);
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
  await main();
}
