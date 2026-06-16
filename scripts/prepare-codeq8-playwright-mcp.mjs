#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CODEQ8_PLAYWRIGHT_MCP_PACKAGE_SPEC = "@playwright/mcp@latest";
export const CODEQ8_PLAYWRIGHT_MCP_BROWSER = "chromium";
export const CODEQ8_PLAYWRIGHT_MCP_CAPABILITY = "codeq8_plugin_playwright_mcp";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function parseArgs(argv = process.argv.slice(2)) {
  const result = {
    repoRoot: "",
    npmPath: "",
    packageSpec: CODEQ8_PLAYWRIGHT_MCP_PACKAGE_SPEC,
    browser: CODEQ8_PLAYWRIGHT_MCP_BROWSER,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const current = normalizeText(argv[index]);
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
    if (key === "npm-path") {
      result.npmPath = nextValue;
      index += 1;
      continue;
    }
    if (key === "package-spec") {
      result.packageSpec = nextValue;
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

function resolveNpmPath({ npmPath = "", env = process.env }) {
  const explicit = normalizeText(npmPath);
  if (explicit) {
    return path.resolve(explicit);
  }
  const fromEnv = normalizeText(env.npm_execpath);
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return "npm";
}

export function buildPlaywrightMcpBrowserInstallCommand({
  npmPath = "",
  packageSpec = CODEQ8_PLAYWRIGHT_MCP_PACKAGE_SPEC,
  browser = CODEQ8_PLAYWRIGHT_MCP_BROWSER,
  env = process.env,
} = {}) {
  return {
    command: resolveNpmPath({ npmPath, env }),
    args: [
      "exec",
      "--yes",
      "--package",
      normalizeText(packageSpec) || CODEQ8_PLAYWRIGHT_MCP_PACKAGE_SPEC,
      "--",
      "playwright-mcp",
      "install-browser",
      normalizeText(browser) || CODEQ8_PLAYWRIGHT_MCP_BROWSER,
    ],
  };
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

export async function prepareCodeq8PlaywrightMcp({
  repoRoot = process.cwd(),
  npmPath = "",
  packageSpec = CODEQ8_PLAYWRIGHT_MCP_PACKAGE_SPEC,
  browser = CODEQ8_PLAYWRIGHT_MCP_BROWSER,
  env = process.env,
  runCommandImpl = runCommand,
  logger = null,
} = {}) {
  const normalizedRepoRoot = path.resolve(normalizeText(repoRoot) || process.cwd());
  const installCommand = buildPlaywrightMcpBrowserInstallCommand({
    npmPath,
    packageSpec,
    browser,
    env,
  });
  const result = await runCommandImpl({
    ...installCommand,
    cwd: normalizedRepoRoot,
    env: {
      ...env,
      npm_config_update_notifier: "false",
    },
  });
  if (result?.ok) {
    logger?.log?.(
      `[codeq8-playwright-mcp] status=prepared capability=${CODEQ8_PLAYWRIGHT_MCP_CAPABILITY} package=${normalizeText(packageSpec)} browser=${normalizeText(browser)}`,
    );
    return {
      ok: true,
      status: "prepared",
      capability: CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
      packageSpec: normalizeText(packageSpec),
      browser: normalizeText(browser),
    };
  }
  const stderr = normalizeText(result?.stderr).split("\n")[0] || "unknown error";
  logger?.warn?.(
    `::warning::[codeq8-playwright-mcp] status=skipped capability=${CODEQ8_PLAYWRIGHT_MCP_CAPABILITY} package=${normalizeText(packageSpec)} browser=${normalizeText(browser)} reason=${stderr}`,
  );
  return {
    ok: false,
    status: "skipped",
    capability: CODEQ8_PLAYWRIGHT_MCP_CAPABILITY,
    packageSpec: normalizeText(packageSpec),
    browser: normalizeText(browser),
    reason: stderr,
  };
}

async function main() {
  const args = parseArgs();
  await prepareCodeq8PlaywrightMcp({
    repoRoot:
      args.repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    npmPath: args.npmPath,
    packageSpec: args.packageSpec,
    browser: args.browser,
    logger: console,
  });
}

const executedAsScript = path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);

if (executedAsScript) {
  await main();
}
