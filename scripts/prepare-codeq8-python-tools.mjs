#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CODEQ8_PYTHON_TOOLS_CAPABILITY = "codeq8_python_tools";
export const DEFAULT_REQUIREMENTS_RELATIVE_PATH = "requirements/codeq8-python-tools.txt";
export const DEFAULT_MARKER_FILE = "~/.cache/codeq8/python-tools.json";
export const DEFAULT_VENV_DIRECTORY = "~/.cache/codeq8/python-tools";

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
    markerFile: DEFAULT_MARKER_FILE,
    requirementsPath: "",
    venvDirectory: DEFAULT_VENV_DIRECTORY,
    pythonPath: "",
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
    if (key === "marker-file") {
      result.markerFile = nextValue;
      index += 1;
      continue;
    }
    if (key === "requirements-path") {
      result.requirementsPath = nextValue;
      index += 1;
      continue;
    }
    if (key === "venv-directory") {
      result.venvDirectory = nextValue;
      index += 1;
      continue;
    }
    if (key === "python-path") {
      result.pythonPath = nextValue;
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

function summarizeFirstLine(value) {
  return normalizeText(value).split("\n")[0] || "unknown error";
}

async function resolvePythonPath({
  pythonPath = "",
  env = process.env,
  cwd = process.cwd(),
  runCommandImpl = runCommand,
}) {
  const explicit = normalizeText(pythonPath) || normalizeText(env.CODEQ8_PYTHON3);
  if (explicit) {
    return path.resolve(explicit);
  }

  const whichResult = await runCommandImpl({
    command: "/bin/bash",
    args: ["-lc", "command -v python3"],
    cwd,
    env,
  });
  const resolved = normalizeText(whichResult.stdout);
  return whichResult.ok && resolved ? resolved : "";
}

function resolveVenvPythonPath(venvDirectory) {
  return process.platform === "win32"
    ? path.join(venvDirectory, "Scripts", "python.exe")
    : path.join(venvDirectory, "bin", "python3");
}

function resolveVenvBinDirectory(venvDirectory) {
  return process.platform === "win32"
    ? path.join(venvDirectory, "Scripts")
    : path.join(venvDirectory, "bin");
}

async function hashFile(filePath) {
  const contents = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(contents).digest("hex");
}

async function readPythonVersion({ pythonPath, cwd, env, runCommandImpl }) {
  const result = await runCommandImpl({
    command: pythonPath,
    args: ["-c", "import sys; print(sys.version)"],
    cwd,
    env,
  });
  if (!result?.ok) {
    throw new Error(`Unable to inspect python3 version (${summarizeFirstLine(result?.stderr || result?.stdout)}).`);
  }
  return summarizeFirstLine(result.stdout);
}

async function verifyYamlImport({ pythonPath, cwd, env, runCommandImpl }) {
  const result = await runCommandImpl({
    command: pythonPath,
    args: ["-c", "import yaml; print(yaml.__version__)"],
    cwd,
    env,
  });
  return result?.ok ? summarizeFirstLine(result.stdout) : "";
}

function markerMatches({ marker, pythonVersion, requirementsHash, venvDirectory }) {
  return (
    normalizeText(marker?.managed_by) === "codeq8-python-tools-prep" &&
    normalizeText(marker?.capability) === CODEQ8_PYTHON_TOOLS_CAPABILITY &&
    normalizeText(marker?.python_version) === normalizeText(pythonVersion) &&
    normalizeText(marker?.requirements_hash) === normalizeText(requirementsHash) &&
    normalizeText(marker?.venv_directory) === normalizeText(venvDirectory)
  );
}

async function appendLineIfConfigured(filePath, value) {
  const normalizedFilePath = normalizeText(filePath);
  const normalizedValue = normalizeText(value);
  if (!normalizedFilePath || !normalizedValue) {
    return;
  }
  await fs.appendFile(normalizedFilePath, `${normalizedValue}\n`, "utf8");
}

async function exposePythonToolsToGithubEnv({ env, binDirectory, venvDirectory }) {
  await appendLineIfConfigured(env.GITHUB_PATH, binDirectory);
  await appendLineIfConfigured(env.GITHUB_ENV, `CODEQ8_PYTHON_TOOLS_BIN=${binDirectory}`);
  await appendLineIfConfigured(env.GITHUB_ENV, `CODEQ8_PYTHON_TOOLS_VENV=${venvDirectory}`);
}

export async function prepareCodeq8PythonTools({
  repoRoot = process.cwd(),
  markerFile = DEFAULT_MARKER_FILE,
  requirementsPath = "",
  venvDirectory = DEFAULT_VENV_DIRECTORY,
  pythonPath = "",
  env = process.env,
  runCommandImpl = runCommand,
  logger = null,
} = {}) {
  const normalizedRepoRoot = path.resolve(normalizeText(repoRoot) || process.cwd());
  const homeDirectory = normalizeText(env?.HOME) || normalizeText(process.env.HOME) || os.homedir();
  const markerFilePath = path.resolve(
    expandHomePath(normalizeText(markerFile) || DEFAULT_MARKER_FILE, homeDirectory),
  );
  const resolvedVenvDirectory = path.resolve(
    expandHomePath(normalizeText(venvDirectory) || DEFAULT_VENV_DIRECTORY, homeDirectory),
  );
  const resolvedRequirementsPath = path.resolve(
    normalizeText(requirementsPath) ||
      path.join(normalizedRepoRoot, DEFAULT_REQUIREMENTS_RELATIVE_PATH),
  );
  const resolvedPythonPath = await resolvePythonPath({
    pythonPath,
    env,
    cwd: normalizedRepoRoot,
    runCommandImpl,
  });
  if (!resolvedPythonPath) {
    const result = {
      ok: false,
      status: "unavailable",
      code: "python3_missing",
      reason: "python3 executable was not found.",
      capability: CODEQ8_PYTHON_TOOLS_CAPABILITY,
      markerFilePath,
      venvDirectory: resolvedVenvDirectory,
      binDirectory: resolveVenvBinDirectory(resolvedVenvDirectory),
    };
    logger?.warn?.(
      `[codeq8-python-tools] status=unavailable capability=${CODEQ8_PYTHON_TOOLS_CAPABILITY} reason=${result.reason}`,
    );
    return result;
  }

  const pythonVersion = await readPythonVersion({
    pythonPath: resolvedPythonPath,
    cwd: normalizedRepoRoot,
    env,
    runCommandImpl,
  });
  const requirementsHash = await hashFile(resolvedRequirementsPath);
  const venvPythonPath = resolveVenvPythonPath(resolvedVenvDirectory);
  const binDirectory = resolveVenvBinDirectory(resolvedVenvDirectory);
  const marker = await readJsonFile(markerFilePath);
  const existingYamlVersion = await verifyYamlImport({
    pythonPath: venvPythonPath,
    cwd: normalizedRepoRoot,
    env,
    runCommandImpl,
  });

  if (
    markerMatches({
      marker,
      pythonVersion,
      requirementsHash,
      venvDirectory: resolvedVenvDirectory,
    }) &&
    existingYamlVersion
  ) {
    await exposePythonToolsToGithubEnv({
      env,
      binDirectory,
      venvDirectory: resolvedVenvDirectory,
    });
    logger?.log?.(
      `[codeq8-python-tools] status=already-prepared ` +
        `capability=${CODEQ8_PYTHON_TOOLS_CAPABILITY} yaml=${existingYamlVersion}`,
    );
    return {
      ok: true,
      status: "already-prepared",
      capability: CODEQ8_PYTHON_TOOLS_CAPABILITY,
      pythonPath: resolvedPythonPath,
      pythonVersion,
      yamlVersion: existingYamlVersion,
      requirementsHash,
      markerFilePath,
      venvDirectory: resolvedVenvDirectory,
      binDirectory,
    };
  }

  await fs.rm(resolvedVenvDirectory, { recursive: true, force: true });
  await fs.mkdir(path.dirname(resolvedVenvDirectory), { recursive: true });
  const venvCreate = await runCommandImpl({
    command: resolvedPythonPath,
    args: ["-m", "venv", resolvedVenvDirectory],
    cwd: normalizedRepoRoot,
    env,
  });
  if (!venvCreate?.ok) {
    throw new Error(
      `Unable to create Codeq8 Python tools venv ` +
        `(${summarizeFirstLine(venvCreate?.stderr || venvCreate?.stdout)}).`,
    );
  }

  const install = await runCommandImpl({
    command: venvPythonPath,
    args: [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--no-input",
      "-r",
      resolvedRequirementsPath,
    ],
    cwd: normalizedRepoRoot,
    env: {
      ...env,
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
    },
  });
  if (!install?.ok) {
    throw new Error(
      `Unable to install Codeq8 Python tools requirements ` +
        `(${summarizeFirstLine(install?.stderr || install?.stdout)}).`,
    );
  }

  const yamlVersion = await verifyYamlImport({
    pythonPath: venvPythonPath,
    cwd: normalizedRepoRoot,
    env,
    runCommandImpl,
  });
  if (!yamlVersion) {
    throw new Error("Codeq8 Python tools venv was prepared, but PyYAML could not be imported.");
  }

  await writeJsonFile(markerFilePath, {
    managed_by: "codeq8-python-tools-prep",
    capability: CODEQ8_PYTHON_TOOLS_CAPABILITY,
    python_path: resolvedPythonPath,
    python_version: pythonVersion,
    yaml_version: yamlVersion,
    requirements_path: resolvedRequirementsPath,
    requirements_hash: requirementsHash,
    venv_directory: resolvedVenvDirectory,
    prepared_at: new Date().toISOString(),
  });
  await exposePythonToolsToGithubEnv({
    env,
    binDirectory,
    venvDirectory: resolvedVenvDirectory,
  });

  logger?.log?.(
    `[codeq8-python-tools] status=prepared capability=${CODEQ8_PYTHON_TOOLS_CAPABILITY} yaml=${yamlVersion}`,
  );
  return {
    ok: true,
    status: "prepared",
    capability: CODEQ8_PYTHON_TOOLS_CAPABILITY,
    pythonPath: resolvedPythonPath,
    pythonVersion,
    yamlVersion,
    requirementsHash,
    markerFilePath,
    venvDirectory: resolvedVenvDirectory,
    binDirectory,
  };
}

async function main() {
  const args = parseArgs();
  await prepareCodeq8PythonTools({
    repoRoot: args.repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    markerFile: args.markerFile,
    requirementsPath: args.requirementsPath,
    venvDirectory: args.venvDirectory,
    pythonPath: args.pythonPath,
    logger: console,
  });
}

const executedAsScript = path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);

if (executedAsScript) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `::warning::[codeq8-python-tools] status=unavailable ` +
        `capability=${CODEQ8_PYTHON_TOOLS_CAPABILITY} reason=${message}`,
    );
  }
}
