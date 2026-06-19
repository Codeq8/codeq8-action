#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const GLOBAL_CLI_TOOLS = Object.freeze([
  {
    label: "codeq8",
    packageName: "@codeq8/codeq8",
    binaryName: "codeq8",
    desiredVersionPath: "codeq8-cli/package.json",
    localPackagePath: "codeq8-cli",
    requireManagedPrefix: true,
    capabilityCheckArgs: ["threads", "--help"],
  },
  {
    label: "playwright-mcp",
    packageName: "@playwright/mcp",
    binaryName: "playwright-mcp",
    desiredVersionPath: "playwright-mcp/package.json",
    requireManagedPrefix: true,
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

  const whichResult = await runProcessCapture("/bin/bash", ["-c", "command -v npm"], {
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
    ["-c", `command -v ${normalizedBinaryName}`],
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

function resolveManagedNpmBinPath(env = process.env) {
  const npmPrefix = normalizeText(env.NPM_CONFIG_PREFIX);
  return npmPrefix ? path.resolve(npmPrefix, "bin") : "";
}

async function resolveManagedBinaryPath(binaryName, managedNpmBinPath) {
  const normalizedBinaryName = normalizeText(binaryName);
  const normalizedManagedNpmBinPath = normalizeText(managedNpmBinPath);
  if (!normalizedBinaryName || !normalizedManagedNpmBinPath) {
    return "";
  }
  const candidate = path.join(normalizedManagedNpmBinPath, normalizedBinaryName);
  return (await isExecutableFile(candidate)) ? candidate : "";
}

function isPathInsideDirectory(filePath, directoryPath) {
  const normalizedFilePath = normalizeText(filePath);
  const normalizedDirectoryPath = normalizeText(directoryPath);
  if (!normalizedFilePath || !normalizedDirectoryPath) {
    return false;
  }
  const relativePath = path.relative(
    path.resolve(normalizedDirectoryPath),
    path.resolve(normalizedFilePath),
  );
  return Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function isPathInsideOrEqualDirectory(filePath, directoryPath) {
  const normalizedFilePath = normalizeText(filePath);
  const normalizedDirectoryPath = normalizeText(directoryPath);
  if (!normalizedFilePath || !normalizedDirectoryPath) {
    return false;
  }
  const relativePath = path.relative(
    path.resolve(normalizedDirectoryPath),
    path.resolve(normalizedFilePath),
  );
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function resolveManagedPackagePath(packageName, managedPrefix) {
  const normalizedPackageName = normalizeText(packageName);
  const normalizedManagedPrefix = normalizeText(managedPrefix);
  if (!normalizedPackageName || !normalizedManagedPrefix) {
    return "";
  }
  const nodeModulesPath = path.resolve(normalizedManagedPrefix, "lib", "node_modules");
  if (normalizedPackageName.startsWith("@")) {
    const [scope, name] = normalizedPackageName.split("/");
    if (!scope || !name) {
      return "";
    }
    return path.join(nodeModulesPath, scope, name);
  }
  return path.join(nodeModulesPath, normalizedPackageName);
}

async function checkToolCapability({
  tool,
  binaryPath,
  env = process.env,
  cwd = process.cwd(),
}) {
  const args = Array.isArray(tool?.capabilityCheckArgs)
    ? tool.capabilityCheckArgs.map((arg) => normalizeText(arg)).filter(Boolean)
    : [];
  if (args.length === 0) {
    return { ok: true, reason: "" };
  }
  const normalizedBinaryPath = normalizeText(binaryPath);
  if (!normalizedBinaryPath) {
    return { ok: false, reason: "missing_binary" };
  }
  const result = await runProcessCapture(normalizedBinaryPath, args, { cwd, env });
  return {
    ok: result.ok,
    reason: result.ok
      ? ""
      : normalizeText(result.stderr) || normalizeText(result.stdout) || result.reason,
  };
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

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed;
}

async function readDesiredToolVersion(tool, cwd = process.cwd()) {
  const relativePath = normalizeText(tool?.desiredVersionPath);
  if (!relativePath) {
    return "";
  }
  try {
    const packageJsonPath = path.resolve(cwd, relativePath);
    const parsed = await readJsonFile(packageJsonPath);
    return normalizeText(parsed?.version);
  } catch {
    return "";
  }
}

async function listFingerprintFiles(rootPath, relativePath = "") {
  const absolutePath = path.join(rootPath, relativePath);
  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch {
    return [];
  }

  if (stats.isFile()) {
    return [relativePath];
  }
  if (!stats.isDirectory()) {
    return [];
  }

  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const childRelativePath = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFingerprintFiles(rootPath, childRelativePath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(childRelativePath);
    }
  }
  return files.sort();
}

async function readLocalPackageFingerprint(tool, cwd = process.cwd()) {
  const localPackagePath = normalizeText(tool?.localPackagePath);
  if (!localPackagePath) {
    return "";
  }

  const packagePath = path.resolve(cwd, localPackagePath);
  const files = await listFingerprintFiles(packagePath);
  if (files.length === 0) {
    return "";
  }

  const hash = crypto.createHash("sha256");
  for (const relativePath of files) {
    const absolutePath = path.join(packagePath, relativePath);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await fs.readFile(absolutePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function prepareLocalPackageInstallTarget({
  tool,
  npmPath,
  env = process.env,
  cwd = process.cwd(),
}) {
  const localPackagePath = normalizeText(tool?.localPackagePath);
  if (!localPackagePath) {
    return "";
  }

  const packagePath = path.resolve(cwd, localPackagePath);
  const packageJsonPath = path.join(packagePath, "package.json");
  try {
    await fs.access(packageJsonPath);
  } catch {
    throw new Error(`Local package target is missing package.json: ${packageJsonPath}`);
  }

  const install = await runProcessCapture(
    npmPath,
    ["install", "--no-audit", "--no-fund"],
    {
      cwd: packagePath,
      env: {
        ...env,
        npm_config_update_notifier: "false",
      },
    },
  );
  if (!install.ok) {
    throw new Error(
      `Unable to install ${tool.packageName} local package dependencies (${install.reason || `exit_code=${install.code}`}). ${
        normalizeText(install.stderr) || normalizeText(install.stdout) || "No install output."
      }`,
    );
  }

  const build = await runProcessCapture(npmPath, ["run", "build"], {
    cwd: packagePath,
    env: {
      ...env,
      npm_config_update_notifier: "false",
    },
  });
  if (!build.ok) {
    throw new Error(
      `Unable to build ${tool.packageName} local package (${build.reason || `exit_code=${build.code}`}). ${
        normalizeText(build.stderr) || normalizeText(build.stdout) || "No build output."
      }`,
    );
  }

  return packagePath;
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function resolveLocalPackageBinarySourcePath({ tool, cwd = process.cwd() }) {
  const localPackagePath = normalizeText(tool?.localPackagePath);
  const binaryName = normalizeText(tool?.binaryName);
  if (!localPackagePath || !binaryName) {
    return "";
  }

  const packagePath = path.resolve(cwd, localPackagePath);
  const packageJson = await readJsonFile(path.join(packagePath, "package.json"));
  const bin = packageJson.bin;
  const relativeBinPath =
    typeof bin === "string"
      ? bin
      : bin && typeof bin === "object" && !Array.isArray(bin)
        ? normalizeText(bin[binaryName])
        : "";
  if (!relativeBinPath) {
    return "";
  }

  const sourcePath = path.resolve(packagePath, relativeBinPath);
  if (!(await isExecutableFile(sourcePath))) {
    throw new Error(`Local package binary is not executable: ${sourcePath}`);
  }
  return sourcePath;
}

async function repairLocalPackageBinaryShims({
  tools = GLOBAL_CLI_TOOLS,
  force = false,
  env = process.env,
  cwd = process.cwd(),
  logger = () => {},
} = {}) {
  const managedNpmBinPath = resolveManagedNpmBinPath(env);
  if (!managedNpmBinPath) {
    return;
  }

  await ensureDirectory(managedNpmBinPath);
  for (const tool of tools) {
    if (!tool.localPackagePath || !tool.requireManagedPrefix) {
      continue;
    }

    const sourcePath = await resolveLocalPackageBinarySourcePath({ tool, cwd });
    if (!sourcePath) {
      continue;
    }

    const sourceCapability = await checkToolCapability({
      tool,
      binaryPath: sourcePath,
      env,
      cwd,
    });
    if (!sourceCapability.ok) {
      throw new Error(
        `Local package binary failed capability check: ${tool.binaryName} source=${sourcePath} capability=${
          sourceCapability.reason || "failed"
        }`,
      );
    }

    const targetPath = path.join(managedNpmBinPath, tool.binaryName);
    if (!force) {
      const existingCapability = await checkToolCapability({
        tool,
        binaryPath: targetPath,
        env,
        cwd,
      });
      if (existingCapability.ok) {
        continue;
      }
    }

    const shimSource = `#!/bin/sh\nexec node ${shellSingleQuote(sourcePath)} "$@"\n`;
    await fs.rm(targetPath, { force: true });
    const handle = await fs.open(targetPath, "wx", 0o755);
    try {
      await handle.writeFile(shimSource, "utf8");
    } finally {
      await handle.close();
    }
    const targetCapability = await checkToolCapability({
      tool,
      binaryPath: targetPath,
      env,
      cwd,
    });
    if (!targetCapability.ok) {
      throw new Error(
        `Managed local package shim failed capability check: ${tool.binaryName} target=${targetPath} source=${sourcePath} capability=${
          targetCapability.reason || "failed"
        }`,
      );
    }
    logger(
      "Repaired local package CLI shim",
      `${tool.binaryName} target=${targetPath} source=${sourcePath}`,
    );
  }
}

async function buildInstallTargets({
  toolSnapshot,
  npmPath,
  env = process.env,
  cwd = process.cwd(),
}) {
  const targets = [];
  for (const tool of GLOBAL_CLI_TOOLS) {
    const desiredVersion = normalizeText(
      toolSnapshot.find((entry) => entry.packageName === tool.packageName)?.desiredVersion,
    );
    const localTarget = await prepareLocalPackageInstallTarget({
      tool,
      npmPath,
      env,
      cwd,
    });
    if (localTarget) {
      targets.push(localTarget);
      continue;
    }
    targets.push(desiredVersion ? `${tool.packageName}@${desiredVersion}` : tool.packageName);
  }
  return targets;
}

async function removeStaleManagedTools({
  tools,
  npmPath,
  env = process.env,
  cwd = process.cwd(),
  logger = () => {},
}) {
  const staleTools = tools
    .map((tool) => ({
      packageName: normalizeText(tool.packageName),
      binaryName: normalizeText(tool.binaryName),
    }))
    .filter((tool) => tool.packageName || tool.binaryName);
  const packageNames = [...new Set(staleTools.map((tool) => tool.packageName).filter(Boolean))];
  if (packageNames.length === 0) {
    return;
  }

  const uninstall = await runProcessCapture(
    npmPath,
    ["uninstall", "--global", "--no-audit", "--no-fund", ...packageNames],
    {
      cwd,
      env: {
        ...env,
        npm_config_update_notifier: "false",
      },
    },
  );
  if (!uninstall.ok) {
    logger(
      "Stale runner global CLI uninstall failed; continuing with install",
      normalizeText(uninstall.stderr) || normalizeText(uninstall.stdout) || uninstall.reason,
    );
  }

  const managedPrefix = normalizeText(env.NPM_CONFIG_PREFIX);
  if (!managedPrefix) {
    return;
  }
  const managedBinPath = resolveManagedNpmBinPath(env);
  const managedNodeModulesPath = path.resolve(managedPrefix, "lib", "node_modules");
  for (const tool of staleTools) {
    const packagePath = resolveManagedPackagePath(tool.packageName, managedPrefix);
    const binaryPath =
      tool.binaryName && managedBinPath ? path.join(managedBinPath, tool.binaryName) : "";
    const removalTargets = [
      { targetPath: packagePath, rootPath: managedNodeModulesPath },
      { targetPath: binaryPath, rootPath: managedBinPath },
    ];
    for (const { targetPath, rootPath } of removalTargets) {
      if (!targetPath || !rootPath || !isPathInsideOrEqualDirectory(targetPath, rootPath)) {
        continue;
      }
      await fs.rm(targetPath, { recursive: true, force: true });
    }
  }
}

async function removeManagedBinaryFiles({ tools, env = process.env } = {}) {
  const managedNpmBinPath = resolveManagedNpmBinPath(env);
  if (!managedNpmBinPath) {
    return;
  }

  const binaryNames = [
    ...new Set(
      tools
        .map((tool) => normalizeText(tool.binaryName))
        .filter(Boolean),
    ),
  ];
  for (const binaryName of binaryNames) {
    await fs.rm(path.join(managedNpmBinPath, binaryName), { force: true });
  }
}

async function resolveToolSnapshot({ env = process.env, cwd = process.cwd() } = {}) {
  const snapshot = [];
  const managedNpmBinPath = resolveManagedNpmBinPath(env);
  for (const tool of GLOBAL_CLI_TOOLS) {
    const requiresManagedPrefix = Boolean(tool.requireManagedPrefix && managedNpmBinPath);
    const managedBinaryPath = requiresManagedPrefix
      ? await resolveManagedBinaryPath(tool.binaryName, managedNpmBinPath)
      : "";
    const discoveredBinaryPath =
      managedBinaryPath ||
      (await resolveBinaryPath({
        binaryName: tool.binaryName,
        env,
        cwd,
      }));
    const prefixScopedBinaryPath =
      requiresManagedPrefix && !isPathInsideDirectory(discoveredBinaryPath, managedNpmBinPath)
        ? ""
        : discoveredBinaryPath;
    const capability = await checkToolCapability({
      tool,
      binaryPath: prefixScopedBinaryPath,
      env,
      cwd,
    });
    const binaryPath = capability.ok ? prefixScopedBinaryPath : "";
    snapshot.push({
      ...tool,
      desiredVersion: await readDesiredToolVersion(tool, cwd),
      localPackageFingerprint: await readLocalPackageFingerprint(tool, cwd),
      binaryPath,
      discoveredBinaryPath,
      managedNpmBinPath,
      capabilityOk: capability.ok,
      capabilityFailure: capability.reason,
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
  const previousLocalPackageFingerprints =
    previousState.local_package_fingerprints &&
    typeof previousState.local_package_fingerprints === "object" &&
    !Array.isArray(previousState.local_package_fingerprints)
      ? previousState.local_package_fingerprints
      : {};
  const localPackageMismatchTools = toolSnapshot.filter((tool) => {
    if (!normalizeText(tool.localPackageFingerprint)) {
      return false;
    }
    return (
      normalizeText(previousLocalPackageFingerprints[tool.packageName]) !==
      normalizeText(tool.localPackageFingerprint)
    );
  });
  const lastSuccessAt = parsePositiveInteger(previousState.last_success_at, 0);

  if (
    !force &&
    missingTools.length === 0 &&
    versionMismatchTools.length === 0 &&
    localPackageMismatchTools.length === 0
  ) {
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
    `force=${force ? "yes" : "no"} missing=${missingTools.map((tool) => tool.label).join(",") || "none"} version_mismatch=${versionMismatchTools.map((tool) => tool.label).join(",") || "none"} local_package_mismatch=${localPackageMismatchTools.map((tool) => tool.label).join(",") || "none"}`,
  );

  await removeStaleManagedTools({
    tools: [...missingTools, ...versionMismatchTools, ...localPackageMismatchTools],
    npmPath: resolvedNpmPath,
    env,
    cwd,
    logger,
  });
  await removeManagedBinaryFiles({
    tools: [...missingTools, ...versionMismatchTools, ...localPackageMismatchTools],
    env,
  });

  const installTargets = await buildInstallTargets({
    toolSnapshot,
    npmPath: resolvedNpmPath,
    env,
    cwd,
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

  await repairLocalPackageBinaryShims({ force: true, env, cwd, logger });

  let nextSnapshot = await resolveToolSnapshot({ env, cwd });
  let stillMissing = nextSnapshot.filter((tool) => !tool.binaryPath);
  const missingLocalPackageTools = stillMissing.filter((tool) => tool.localPackagePath);
  if (missingLocalPackageTools.length > 0) {
    await repairLocalPackageBinaryShims({
      tools: missingLocalPackageTools,
      force: true,
      env,
      cwd,
      logger,
    });
    nextSnapshot = await resolveToolSnapshot({ env, cwd });
    stillMissing = nextSnapshot.filter((tool) => !tool.binaryPath);
  }
  if (stillMissing.length > 0) {
    const missingDetails = stillMissing
      .map((tool) => {
        const discovered = normalizeText(tool.discoveredBinaryPath) || "<none>";
        const capabilityFailure = normalizeText(tool.capabilityFailure);
        return `${tool.binaryName} discovered=${discovered}${
          capabilityFailure ? ` capability=${capabilityFailure}` : ""
        }`;
      })
      .join("; ");
    throw new Error(
      `Global CLI refresh completed but these binaries are still missing: ${stillMissing
        .map((tool) => tool.binaryName)
        .join(", ")}.${missingDetails ? ` ${missingDetails}` : ""}`,
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
    local_package_fingerprints: Object.fromEntries(
      nextSnapshot
        .map((tool) => [tool.packageName, normalizeText(tool.localPackageFingerprint)])
        .filter((entry) => entry[1]),
    ),
    tools: nextSnapshot.map((tool) => ({
      label: tool.label,
      package_name: tool.packageName,
      binary_name: tool.binaryName,
      binary_path: tool.binaryPath,
      desired_version: normalizeText(tool.desiredVersion),
      local_package_fingerprint: normalizeText(tool.localPackageFingerprint),
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
