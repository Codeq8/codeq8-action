#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CODEQ8_PLAYWRIGHT_MCP_PACKAGE_NAME = "@playwright/mcp";
export const CODEQ8_PLAYWRIGHT_MCP_PACKAGE_VERSION = "0.0.76";
export const CODEQ8_PLAYWRIGHT_MCP_BROWSER = "chromium";
export const CODEQ8_PLAYWRIGHT_MCP_BINARY = "playwright-mcp";
export const CODEQ8_PLAYWRIGHT_MCP_CAPABILITY = "codeq8_plugin_playwright_mcp";
export const DEFAULT_MARKER_FILE = "~/.cache/codeq8/playwright-mcp-browser.json";
export const DEFAULT_BROWSER_CACHE_MARKER_FILE =
  "~/.cache/codeq8/playwright-mcp-browser-default.json";
export const DEFAULT_BROWSER_CACHE_LABEL = "playwright-default";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function expandHomePath(value, homeDirectory = os.homedir()) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  if (normalized === "~") {
    return homeDirectory;
  }
  if (normalized.startsWith("~/")) {
    return path.join(homeDirectory, normalized.slice(2));
  }
  if (normalized === "$HOME") {
    return homeDirectory;
  }
  if (normalized.startsWith("$HOME/")) {
    return path.join(homeDirectory, normalized.slice("$HOME/".length));
  }
  if (normalized === "${HOME}") {
    return homeDirectory;
  }
  if (normalized.startsWith("${HOME}/")) {
    return path.join(homeDirectory, normalized.slice("${HOME}/".length));
  }
  return normalized;
}

function parseArgs(argv = process.argv.slice(2)) {
  const result = {
    repoRoot: "",
    markerFile: "",
    playwrightMcpPath: "",
    browser: CODEQ8_PLAYWRIGHT_MCP_BROWSER,
    defaultBrowserCache: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const current = normalizeText(argv[index]);
    if (current === "--default-browser-cache") {
      result.defaultBrowserCache = true;
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
    if (key === "marker-file") {
      result.markerFile = nextValue;
      index += 1;
      continue;
    }
    if (key === "playwright-mcp-path") {
      result.playwrightMcpPath = nextValue;
      index += 1;
      continue;
    }
    if (key === "browser") {
      result.browser = nextValue;
      index += 1;
    }
  }
  return result;
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

async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeJsonFile(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function runCommand({ command, args, cwd, env }) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
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
        stderr: normalizeText(error instanceof Error ? error.message : String(error)),
      });
    });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        code: Number(code ?? -1),
        stdout,
        stderr,
      });
    });
  });
}

async function resolvePlaywrightMcpPath({
  playwrightMcpPath = "",
  env = process.env,
  cwd = process.cwd(),
  runCommandImpl = runCommand,
} = {}) {
  const explicit = normalizeText(playwrightMcpPath);
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (await pathExists(resolved)) {
      return resolved;
    }
    throw new Error(`playwright-mcp executable was not found at ${resolved}.`);
  }

  const whichResult = await runCommandImpl({
    command: "/bin/bash",
    args: ["-lc", `command -v ${CODEQ8_PLAYWRIGHT_MCP_BINARY}`],
    cwd,
    env,
  });
  const resolved = normalizeText(whichResult.stdout);
  if (whichResult.ok && resolved && (await pathExists(resolved))) {
    return resolved;
  }
  throw new Error(
    "playwright-mcp executable was not found. Ensure runner-global-cli-tools installed @playwright/mcp first.",
  );
}

export function buildPlaywrightMcpBrowserDryRunCommand({
  playwrightMcpPath = CODEQ8_PLAYWRIGHT_MCP_BINARY,
  browser = CODEQ8_PLAYWRIGHT_MCP_BROWSER,
} = {}) {
  return {
    command: normalizeText(playwrightMcpPath) || CODEQ8_PLAYWRIGHT_MCP_BINARY,
    args: ["install-browser", normalizeText(browser) || CODEQ8_PLAYWRIGHT_MCP_BROWSER, "--dry-run"],
  };
}

export function buildPlaywrightMcpBrowserInstallCommand({
  playwrightMcpPath = CODEQ8_PLAYWRIGHT_MCP_BINARY,
  browser = CODEQ8_PLAYWRIGHT_MCP_BROWSER,
} = {}) {
  return {
    command: normalizeText(playwrightMcpPath) || CODEQ8_PLAYWRIGHT_MCP_BINARY,
    args: [
      "install-browser",
      normalizeText(browser) || CODEQ8_PLAYWRIGHT_MCP_BROWSER,
      "--no-progress",
    ],
  };
}

export function parsePlaywrightInstallLocations(output = "") {
  const locations = [];
  const pattern = /^\s*Install location:\s*(.+?)\s*$/gm;
  let match = pattern.exec(String(output || ""));
  while (match) {
    const location = normalizeText(match[1]);
    if (location) {
      locations.push(location);
    }
    match = pattern.exec(String(output || ""));
  }
  return locations;
}

async function allPathsExist(paths = []) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return false;
  }
  for (const entry of paths) {
    if (!(await pathExists(entry))) {
      return false;
    }
  }
  return true;
}

function markerMatches({
  marker,
  browser,
  installLocations,
  browserCache,
}) {
  return (
    normalizeText(marker?.package_name) === CODEQ8_PLAYWRIGHT_MCP_PACKAGE_NAME &&
    normalizeText(marker?.package_version) === CODEQ8_PLAYWRIGHT_MCP_PACKAGE_VERSION &&
    normalizeText(marker?.browser) === normalizeText(browser) &&
    normalizeText(marker?.playwright_browsers_path) === normalizeText(browserCache) &&
    JSON.stringify(marker?.install_locations || []) === JSON.stringify(installLocations)
  );
}

function resolveBrowserCacheMarkerValue(env = process.env) {
  return normalizeText(env?.PLAYWRIGHT_BROWSERS_PATH) || DEFAULT_BROWSER_CACHE_LABEL;
}

function summarizeFirstLine(value) {
  return normalizeText(value).split("\n")[0] || "unknown error";
}

export async function prepareCodeq8PlaywrightMcp({
  repoRoot = process.cwd(),
  markerFile = DEFAULT_MARKER_FILE,
  playwrightMcpPath = "",
  browser = CODEQ8_PLAYWRIGHT_MCP_BROWSER,
  defaultBrowserCache = false,
  env = process.env,
  runCommandImpl = runCommand,
  logger = null,
} = {}) {
  const normalizedRepoRoot = path.resolve(normalizeText(repoRoot) || process.cwd());
  const normalizedBrowser = normalizeText(browser) || CODEQ8_PLAYWRIGHT_MCP_BROWSER;
  const homeDirectory = normalizeText(env?.HOME) || normalizeText(process.env.HOME) || os.homedir();
  const markerFilePath = path.resolve(
    expandHomePath(normalizeText(markerFile) || DEFAULT_MARKER_FILE, homeDirectory),
  );
  const resolvedPlaywrightMcpPath = await resolvePlaywrightMcpPath({
    playwrightMcpPath,
    env,
    cwd: normalizedRepoRoot,
    runCommandImpl,
  });
  const commandEnv = {
    ...env,
    npm_config_update_notifier: "false",
  };
  if (defaultBrowserCache) {
    delete commandEnv.PLAYWRIGHT_BROWSERS_PATH;
  }
  const browserCache = resolveBrowserCacheMarkerValue(commandEnv);

  const dryRunCommand = buildPlaywrightMcpBrowserDryRunCommand({
    playwrightMcpPath: resolvedPlaywrightMcpPath,
    browser: normalizedBrowser,
  });
  const dryRun = await runCommandImpl({
    ...dryRunCommand,
    cwd: normalizedRepoRoot,
    env: commandEnv,
  });
  if (!dryRun?.ok) {
    throw new Error(
      `Unable to inspect Playwright MCP browser payload (${summarizeFirstLine(dryRun?.stderr || dryRun?.stdout)}).`,
    );
  }

  const installLocations = parsePlaywrightInstallLocations(dryRun.stdout);
  const marker = await readJsonFile(markerFilePath);
  if (
    markerMatches({
      marker,
      browser: normalizedBrowser,
      installLocations,
      browserCache,
    }) &&
    (await allPathsExist(installLocations))
  ) {
    logger?.log?.(
      `[codeq8-playwright-mcp] status=already-prepared capability=${CODEQ8_PLAYWRIGHT_MCP_CAPABILITY} package=${CODEQ8_PLAYWRIGHT_MCP_PACKAGE_NAME}@${CODEQ8_PLAYWRIGHT_MCP_PACKAGE_VERSION} browser=${normalizedBrowser} cache=${browserCache}`,
    );
    return {
      ok: true,
      status: "already-prepared",
      capability: CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
      packageName: CODEQ8_PLAYWRIGHT_MCP_PACKAGE_NAME,
      packageVersion: CODEQ8_PLAYWRIGHT_MCP_PACKAGE_VERSION,
      browser: normalizedBrowser,
      browserCache,
      markerFilePath,
      installLocations,
    };
  }

  const installCommand = buildPlaywrightMcpBrowserInstallCommand({
    playwrightMcpPath: resolvedPlaywrightMcpPath,
    browser: normalizedBrowser,
  });
  const install = await runCommandImpl({
    ...installCommand,
    cwd: normalizedRepoRoot,
    env: commandEnv,
  });
  if (!install?.ok) {
    throw new Error(
      `Unable to install required Playwright MCP browser payload (${summarizeFirstLine(install?.stderr || install?.stdout)}).`,
    );
  }

  const postInstallDryRun = await runCommandImpl({
    ...dryRunCommand,
    cwd: normalizedRepoRoot,
    env: commandEnv,
  });
  const postInstallLocations = postInstallDryRun?.ok
    ? parsePlaywrightInstallLocations(postInstallDryRun.stdout)
    : installLocations;
  if (!(await allPathsExist(postInstallLocations))) {
    throw new Error(
      "Playwright MCP browser install completed, but the expected browser payload paths are missing.",
    );
  }

  await writeJsonFile(markerFilePath, {
    managed_by: "codeq8-playwright-mcp-prep",
    capability: CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
    package_name: CODEQ8_PLAYWRIGHT_MCP_PACKAGE_NAME,
    package_version: CODEQ8_PLAYWRIGHT_MCP_PACKAGE_VERSION,
    browser: normalizedBrowser,
    playwright_browsers_path: browserCache,
    install_locations: postInstallLocations,
    prepared_at: new Date().toISOString(),
  });

  logger?.log?.(
    `[codeq8-playwright-mcp] status=prepared capability=${CODEQ8_PLAYWRIGHT_MCP_CAPABILITY} package=${CODEQ8_PLAYWRIGHT_MCP_PACKAGE_NAME}@${CODEQ8_PLAYWRIGHT_MCP_PACKAGE_VERSION} browser=${normalizedBrowser} cache=${browserCache}`,
  );
  return {
    ok: true,
    status: "prepared",
    capability: CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
    packageName: CODEQ8_PLAYWRIGHT_MCP_PACKAGE_NAME,
    packageVersion: CODEQ8_PLAYWRIGHT_MCP_PACKAGE_VERSION,
    browser: normalizedBrowser,
    browserCache,
    markerFilePath,
    installLocations: postInstallLocations,
  };
}

async function main() {
  const args = parseArgs();
  await prepareCodeq8PlaywrightMcp({
    repoRoot:
      args.repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    markerFile: args.markerFile,
    playwrightMcpPath: args.playwrightMcpPath,
    browser: args.browser,
    defaultBrowserCache: args.defaultBrowserCache,
    logger: console,
  });
}

const executedAsScript = path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);

if (executedAsScript) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::[codeq8-playwright-mcp] ${message}`);
    process.exitCode = 1;
  }
}
