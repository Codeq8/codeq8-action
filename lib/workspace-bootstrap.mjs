import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { normalizeChatPolicyConfig } from "./web-chat-policy-config.mjs";

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

export function parseCodeq8CommandList(rawValue, fieldName) {
  if (rawValue === null || rawValue === undefined) {
    return [];
  }
  if (typeof rawValue === "string") {
    const command = normalizeText(rawValue);
    if (!command) {
      throw new Error(`Invalid workspace settings: '${fieldName}' cannot be empty.`);
    }
    return [command];
  }
  if (!Array.isArray(rawValue)) {
    throw new Error(`Invalid workspace settings: '${fieldName}' must be a string or an array.`);
  }
  const commands = rawValue.map((entry, index) => {
    const command = normalizeText(entry);
    if (!command) {
      throw new Error(
        `Invalid workspace settings: '${fieldName}[${index + 1}]' cannot be empty.`,
      );
    }
    return command;
  });
  return commands;
}

export async function loadWorkspaceCodeq8Config(workspacePath) {
  const configPath = path.join(workspacePath, "codeq8.json");
  let raw = "";
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    throw new Error(`Missing codeq8.json in workspace: ${workspacePath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid codeq8.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  const normalized = normalizeChatPolicyConfig(parsed);
  if (normalized === "invalid") {
    throw new Error("Invalid codeq8.json: 'version' must be 1.");
  }
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new Error("Invalid codeq8.json: expected a JSON object.");
  }
  return normalized;
}

function stripMatchingQuotes(value) {
  const normalized = String(value || "");
  if (normalized.length < 2) {
    return normalized;
  }
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function tokenizeSimpleShellCommand(command) {
  const normalized = normalizeText(command);
  if (!normalized) {
    return [];
  }
  if (/[|&;<>()`]/.test(normalized)) {
    return [];
  }
  const tokens = normalized.match(/(?:[^\s"'\\]+|"[^"]*"|'[^']*')+/g) || [];
  return tokens.map((token) => stripMatchingQuotes(token));
}

function parseFastNpmCiCommand(command) {
  const tokens = tokenizeSimpleShellCommand(command);
  if (tokens.length === 0 || tokens[0] !== "npm") {
    return null;
  }

  let prefix = "";
  const filteredTokens = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--prefix") {
      prefix = normalizeText(tokens[index + 1]);
      index += 1;
      continue;
    }
    if (token.startsWith("--prefix=")) {
      prefix = normalizeText(token.slice("--prefix=".length));
      continue;
    }
    filteredTokens.push(token);
  }

  if (filteredTokens[0] !== "ci") {
    return null;
  }

  return {
    prefix,
  };
}

async function fileSha256(targetPath) {
  const buffer = await fs.readFile(targetPath);
  return createHash("sha256").update(buffer).digest("hex");
}

function stateLabelForDirectory(workspacePath, targetDirectory) {
  const relativePath = path.relative(workspacePath, targetDirectory) || "root";
  return relativePath.replace(/[^A-Za-z0-9._-]+/g, "-");
}

async function defaultShellCommandRunner(command, { cwd, env }) {
  await new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `/bin/bash -lc ${command} failed (code=${code ?? "null"} signal=${signal || "none"}).`,
        ),
      );
    });
  });
}

async function maybeFastInstallNpmCi({
  workspacePath,
  command,
  commandEnv,
  shellCommandRunner,
  stateDirName,
  log,
}) {
  const parsedCommand = parseFastNpmCiCommand(command);
  if (!parsedCommand) {
    return false;
  }

  const targetDirectory = parsedCommand.prefix
    ? path.resolve(workspacePath, parsedCommand.prefix)
    : workspacePath;
  const lockfilePath = path.join(targetDirectory, "package-lock.json");
  try {
    await fs.access(lockfilePath);
  } catch {
    return false;
  }

  const nodeModulesPath = path.join(targetDirectory, "node_modules");
  const stateDir = path.join(workspacePath, ".git", stateDirName);
  const stampPath = path.join(
    stateDir,
    `${stateLabelForDirectory(workspacePath, targetDirectory)}-package-lock.sha256`,
  );
  const currentHash = await fileSha256(lockfilePath);
  let previousHash = "";
  try {
    previousHash = normalizeText(await fs.readFile(stampPath, "utf8"));
  } catch {
    previousHash = "";
  }

  let hasNodeModules = false;
  try {
    const nodeModulesStat = await fs.stat(nodeModulesPath);
    hasNodeModules = nodeModulesStat.isDirectory();
  } catch {
    hasNodeModules = false;
  }

  const relativePath = path.relative(workspacePath, targetDirectory) || ".";
  if (hasNodeModules && previousHash === currentHash) {
    log("Using cached npm dependencies for bootstrap", `path=${relativePath}`);
    return true;
  }

  log("Installing npm dependencies for bootstrap", `path=${relativePath}`);
  await shellCommandRunner(command, {
    cwd: workspacePath,
    env: commandEnv,
  });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(stampPath, currentHash, "utf8");
  return true;
}

export async function executeWorkspaceBootstrapCommands({
  workspacePath,
  commands,
  commandEnv,
  log = () => {},
  shellCommandRunner = defaultShellCommandRunner,
  stateDirName = "codeq8-bootstrap",
}) {
  const normalizedCommands = parseCodeq8CommandList(commands, "bootstrap.install");
  for (let index = 0; index < normalizedCommands.length; index += 1) {
    const command = normalizedCommands[index];
    const handledFastPath = await maybeFastInstallNpmCi({
      workspacePath,
      command,
      commandEnv,
      shellCommandRunner,
      stateDirName,
      log,
    });
    if (handledFastPath) {
      continue;
    }
    log(`Running bootstrap command ${index + 1}/${normalizedCommands.length}`, command);
    await shellCommandRunner(command, {
      cwd: workspacePath,
      env: commandEnv,
    });
  }
}

export function readBootstrapInstallCommands(config) {
  return parseCodeq8CommandList(
    normalizeObject(config).bootstrap?.install,
    "bootstrap.install",
  );
}
