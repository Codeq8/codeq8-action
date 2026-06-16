#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const GLOBAL_CLI_TOOLS = Object.freeze([
  {
    label: "codex",
    packageName: "@openai/codex",
    binaryName: "codex",
    desiredVersionPath: "codex-cli/package.json",
  },
  {
    label: "codeq8",
    packageName: "@codeq8/codeq8",
    binaryName: "codeq8",
    desiredVersionPath: "codeq8-cli/package.json",
  },
  {
    label: "playwright-mcp",
    packageName: "@playwright/mcp",
    binaryName: "playwright-mcp",
    desiredVersionPath: "playwright-mcp/package.json",
  },
]);

const DEFAULT_STATE_FILE = "~/.config/codeq8/runner-global-cli-tools.json";

function normalizeText(value) {
  return String(value || "").trim();
}

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
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

async function ensureDirectory(targetPath) {
  const normalized = normalizeText(targetPath);
  if (!normalized) {
    return;
  }
  await fs.mkdir(normalized, { recursive: true });
}

async function isExecutableFile(targetPath) {
  const normalized = normalizeText(targetPath);
  if (!normalized) {
    return false;
  }
  try {
    await fs.access(normalized, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
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
        signal: "error",
        stdout,
        stderr,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (code, signal) => {
      resolve({
        ok: Number(code || 0) === 0,
        code: Number.isFinite(code) ? Number(code) : -1,
        signal: signal || "none",
        stdout,
        stderr,
        reason: Number(code || 0) === 0 ? "" : `exit_code=${Number.isFinite(code) ? Number(code) : -1}`,
      });
    });
  });
}

async function resolveNpmPath({
  npmPath = "",
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const explicit = normalizeText(npmPath);
  if (explicit && (await isExecutableFile(explicit))) {
    return explicit;
  }

  const fromEnv = normalizeText(env.npm_execpath);
  if (fromEnv && (await isExecutableFile(fromEnv))) {
    return fromEnv;
  }

  const nodeDirectory = path.dirname(process.execPath || "");
  const localCandidate = nodeDirectory ? path.join(nodeDirectory, "npm") : "";
  if (localCandidate && (await isExecutableFile(localCandidate))) {
    return localCandidate;
  }

  const whichResult = await runProcessCapture("/bin/bash", ["-lc", "command -v npm"], {
    cwd,
    env,
  });
  const resolved = normalizeText(whichResult.stdout);
  if (whichResult.ok && resolved && (await isExecutableFile(resolved))) {
    return resolved;
  }

  throw new Error("npm executable was not found.");
}

async function resolveBinaryPath({
  binaryName,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const normalizedBinaryName = normalizeText(binaryName);
  if (!normalizedBinaryName) {
    return "";
  }

  const whichResult = await runProcessCapture(
    "/bin/bash",
    ["-lc", `command -v ${normalizedBinaryName}`],
    {
      cwd,
      env,
    },
  );
  const resolved = normalizeText(whichResult.stdout);
  if (whichResult.ok && resolved && (await isExecutableFile(resolved))) {
    return resolved;
  }

  const candidates = [
    `/opt/homebrew/bin/${normalizedBinaryName}`,
    `/usr/local/bin/${normalizedBinaryName}`,
    `/usr/bin/${normalizedBinaryName}`,
  ];
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return "";
}

async function readState(stateFilePath) {
  try {
    const raw = await fs.readFile(stateFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(stateFilePath, payload) {
  await ensureDirectory(path.dirname(stateFilePath));
  await fs.writeFile(stateFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readDesiredToolVersion(tool, cwd = process.cwd()) {
  const relativePath = normalizeText(tool?.desiredVersionPath);
  if (!relativePath) {
    return "";
  }
  try {
    const packageJsonPath = path.resolve(cwd, relativePath);
    const raw = await fs.readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeText(parsed?.version);
  } catch {
    return "";
  }
}

async function resolveToolSnapshot({ env = process.env, cwd = process.cwd() } = {}) {
  const snapshot = [];
  for (const tool of GLOBAL_CLI_TOOLS) {
    snapshot.push({
      ...tool,
      desiredVersion: await readDesiredToolVersion(tool, cwd),
      binaryPath: await resolveBinaryPath({
        binaryName: tool.binaryName,
        env,
        cwd,
      }),
    });
  }
  return snapshot;
}

export async function ensureRunnerGlobalCliTools({
  force = false,
  stateFile = DEFAULT_STATE_FILE,
  npmPath = "",
  env = process.env,
  cwd = process.cwd(),
  logger = () => {},
} = {}) {
  const homeDirectory = normalizeText(env?.HOME) || normalizeText(process.env.HOME) || os.homedir();
  const stateFilePath = path.resolve(expandHomePath(stateFile, homeDirectory));
  const previousState = await readState(stateFilePath);
  const toolSnapshot = await resolveToolSnapshot({ env, cwd });
  const missingTools = toolSnapshot.filter((tool) => !tool.binaryPath);
  const previousToolVersions =
    previousState.tool_versions &&
    typeof previousState.tool_versions === "object" &&
    !Array.isArray(previousState.tool_versions)
      ? previousState.tool_versions
      : {};
  const versionMismatchTools = toolSnapshot.filter((tool) => {
    if (!normalizeText(tool.desiredVersion)) {
      return false;
    }
    return normalizeText(previousToolVersions[tool.packageName]) !== normalizeText(tool.desiredVersion);
  });
  const lastSuccessAt = parsePositiveInteger(previousState.last_success_at, 0);

  if (!force && missingTools.length === 0 && versionMismatchTools.length === 0) {
    return {
      ok: true,
      refreshed: false,
      reason: "Global CLI tools are present and pinned versions match.",
      lastSuccessAt,
      stateFilePath,
      tools: toolSnapshot,
    };
  }

  const resolvedNpmPath = await resolveNpmPath({
    npmPath,
    env,
    cwd,
  });
  logger(
    "Refreshing runner global CLI tools",
    `force=${force ? "yes" : "no"} missing=${missingTools.map((tool) => tool.label).join(",") || "none"} version_mismatch=${versionMismatchTools.map((tool) => tool.label).join(",") || "none"}`,
  );

  const installTargets = GLOBAL_CLI_TOOLS.map((tool) => {
    const desiredVersion = normalizeText(
      toolSnapshot.find((entry) => entry.packageName === tool.packageName)?.desiredVersion,
    );
    return desiredVersion ? `${tool.packageName}@${desiredVersion}` : tool.packageName;
  });

  const install = await runProcessCapture(
    resolvedNpmPath,
    [
      "install",
      "--global",
      "--no-audit",
      "--no-fund",
      ...installTargets,
    ],
    {
      cwd,
      env: {
        ...env,
        npm_config_update_notifier: "false",
      },
    },
  );

  if (!install.ok) {
    throw new Error(
      `Unable to install required global CLI tools (${install.reason || `exit_code=${install.code}`}). ${
        normalizeText(install.stderr) || normalizeText(install.stdout) || "No install output."
      }`,
    );
  }

  const nextSnapshot = await resolveToolSnapshot({ env, cwd });
  const stillMissing = nextSnapshot.filter((tool) => !tool.binaryPath);
  if (stillMissing.length > 0) {
    throw new Error(
      `Global CLI refresh completed but these binaries are still missing: ${stillMissing
        .map((tool) => tool.binaryName)
        .join(", ")}.`,
    );
  }

  const now = Date.now();
  await writeState(stateFilePath, {
    last_success_at: now,
    tool_versions: Object.fromEntries(
      nextSnapshot
        .map((tool) => [tool.packageName, normalizeText(tool.desiredVersion)])
        .filter((entry) => entry[1]),
    ),
    tools: nextSnapshot.map((tool) => ({
      label: tool.label,
      package_name: tool.packageName,
      binary_name: tool.binaryName,
      binary_path: tool.binaryPath,
      desired_version: normalizeText(tool.desiredVersion),
    })),
  });

  return {
    ok: true,
    refreshed: install.ok,
    reason: install.ok ? "Global CLI tools refreshed." : "Global CLI refresh failed, but existing binaries remain available.",
    installWarning: install.ok
      ? ""
      : normalizeText(install.stderr) || normalizeText(install.stdout) || install.reason,
    lastSuccessAt: now,
    stateFilePath,
    tools: nextSnapshot,
  };
}

function parseCliArgs(argv) {
  return {
    force: Array.isArray(argv) && argv.includes("--force"),
    json: Array.isArray(argv) && argv.includes("--json"),
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  try {
    const result = await ensureRunnerGlobalCliTools({
      force: args.force,
      logger(message, details = "") {
        const suffix = normalizeText(details);
        process.stderr.write(
          `[runner-global-cli-tools] ${message}${suffix ? ` | ${suffix}` : ""}\n`,
        );
      },
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      `${result.refreshed ? "refreshed" : "ok"} ${result.tools
        .map((tool) => `${tool.binaryName}:${tool.binaryPath || "<missing>"}`)
        .join(" ")}\n`,
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
