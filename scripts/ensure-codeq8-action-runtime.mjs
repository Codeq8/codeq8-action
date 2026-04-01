#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_LOCK_POLL_INTERVAL_MS = 250;
const DEFAULT_STALE_LOCK_MS = 30 * 60 * 1000;

function normalizeText(value) {
  return String(value ?? "").trim();
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function parseArgs(argv = process.argv.slice(2)) {
  const result = {
    repoRoot: "",
    nodePath: "",
    npmPath: "",
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
    if (key === "node-path") {
      result.nodePath = nextValue;
      index += 1;
      continue;
    }
    if (key === "npm-path") {
      result.npmPath = nextValue;
      index += 1;
    }
  }
  return result;
}

async function pathExists(targetPath) {
  const normalizedTargetPath = normalizeText(targetPath);
  if (!normalizedTargetPath) {
    return false;
  }
  try {
    await fs.access(normalizedTargetPath);
    return true;
  } catch {
    return false;
  }
}

function resolveRuntimeMetadataDirectory(repoRoot) {
  return path.join(repoRoot, ".codeq8-action-runtime");
}

function resolveRuntimeStampFile(repoRoot) {
  return path.join(resolveRuntimeMetadataDirectory(repoRoot), "stamp");
}

function resolveRuntimeLockDirectory(repoRoot) {
  return path.join(resolveRuntimeMetadataDirectory(repoRoot), "install.lock");
}

async function readFileHash(targetPath) {
  const contents = await fs.readFile(targetPath);
  return crypto.createHash("sha256").update(contents).digest("hex");
}

async function readCommandOutput(command, args, env = process.env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(normalizeText(stdout));
        return;
      }
      reject(
        new Error(
          normalizeText(stderr) ||
            `${command} ${args.join(" ")} failed with code ${Number(code ?? -1)}.`,
        ),
      );
    });
  });
}

async function readNodeVersion(nodePath) {
  const normalizedNodePath = path.resolve(normalizeText(nodePath));
  if (!normalizedNodePath) {
    throw new Error("nodePath is required.");
  }
  return await readCommandOutput(normalizedNodePath, ["-p", "process.versions.node"]);
}

async function readNpmVersion(npmPath) {
  const normalizedNpmPath = path.resolve(normalizeText(npmPath));
  if (!normalizedNpmPath) {
    throw new Error("npmPath is required.");
  }
  return await readCommandOutput(normalizedNpmPath, ["--version"]);
}

/**
 * @param {{
 *   repoRoot: string;
 *   nodePath: string;
 *   npmPath: string;
 * }} options
 */
export async function buildCodeq8ActionRuntimeStamp({ repoRoot, nodePath, npmPath }) {
  const normalizedRepoRootText = normalizeText(repoRoot);
  const normalizedNodePathText = normalizeText(nodePath);
  const normalizedNpmPathText = normalizeText(npmPath);
  if (!normalizedRepoRootText || !normalizedNodePathText || !normalizedNpmPathText) {
    throw new Error("repoRoot, nodePath, and npmPath are required.");
  }
  const normalizedRepoRoot = path.resolve(normalizedRepoRootText);
  const normalizedNodePath = path.resolve(normalizedNodePathText);
  const normalizedNpmPath = path.resolve(normalizedNpmPathText);

  const packageJsonPath = path.join(normalizedRepoRoot, "package.json");
  const packageLockPath = path.join(normalizedRepoRoot, "package-lock.json");
  const [packageJsonHash, packageLockHash, nodeVersion, npmVersion] = await Promise.all([
    readFileHash(packageJsonPath),
    readFileHash(packageLockPath),
    readNodeVersion(normalizedNodePath),
    readNpmVersion(normalizedNpmPath),
  ]);
  return `${nodeVersion}:${npmVersion}:${packageJsonHash}:${packageLockHash}`;
}

/**
 * @param {{
 *   repoRoot: string;
 *   expectedStamp: string;
 * }} options
 */
export async function codeq8ActionRuntimeNeedsInstall({ repoRoot, expectedStamp }) {
  const normalizedRepoRootText = normalizeText(repoRoot);
  const normalizedExpectedStamp = normalizeText(expectedStamp);
  if (!normalizedRepoRootText || !normalizedExpectedStamp) {
    return true;
  }
  const normalizedRepoRoot = path.resolve(normalizedRepoRootText);

  const nodeModulesPath = path.join(normalizedRepoRoot, "node_modules");
  const stampFilePath = resolveRuntimeStampFile(normalizedRepoRoot);
  if (!(await pathExists(nodeModulesPath)) || !(await pathExists(stampFilePath))) {
    return true;
  }

  let existingStamp = "";
  try {
    existingStamp = normalizeText(await fs.readFile(stampFilePath, "utf8"));
  } catch {
    return true;
  }
  return existingStamp !== normalizedExpectedStamp;
}

async function writeRuntimeStamp(repoRoot, expectedStamp) {
  const stampFilePath = resolveRuntimeStampFile(repoRoot);
  await fs.mkdir(path.dirname(stampFilePath), { recursive: true });
  await fs.writeFile(stampFilePath, `${expectedStamp}\n`, "utf8");
}

async function runNpmInstall({ repoRoot, npmPath, env = process.env }) {
  await new Promise((resolve, reject) => {
    const child = spawn(npmPath, ["ci", "--no-audit", "--no-fund"], {
      cwd: repoRoot,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(`npm ci failed in ${repoRoot} with code ${Number(code ?? -1)}.`));
    });
  });
}

async function withRuntimeInstallLock(
  {
    repoRoot,
    staleLockMs = DEFAULT_STALE_LOCK_MS,
    pollIntervalMs = DEFAULT_LOCK_POLL_INTERVAL_MS,
  },
  fn,
) {
  const normalizedRepoRootText = normalizeText(repoRoot);
  if (!normalizedRepoRootText) {
    throw new Error("repoRoot is required.");
  }
  const normalizedRepoRoot = path.resolve(normalizedRepoRootText);

  const metadataDirectory = resolveRuntimeMetadataDirectory(normalizedRepoRoot);
  const lockDirectory = resolveRuntimeLockDirectory(normalizedRepoRoot);
  await fs.mkdir(metadataDirectory, { recursive: true });

  while (true) {
    try {
      await fs.mkdir(lockDirectory);
      await fs.writeFile(
        path.join(lockDirectory, "owner.json"),
        JSON.stringify(
          {
            pid: process.pid,
            acquired_at: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      let isStale = false;
      try {
        const lockStats = await fs.stat(lockDirectory);
        isStale = Date.now() - Number(lockStats.mtimeMs || 0) > staleLockMs;
      } catch {
        isStale = false;
      }

      if (isStale) {
        await fs.rm(lockDirectory, { recursive: true, force: true });
        continue;
      }
      await sleep(pollIntervalMs);
    }
  }

  try {
    return await fn();
  } finally {
    await fs.rm(lockDirectory, { recursive: true, force: true });
  }
}

/**
 * @param {{
 *   repoRoot: string;
 *   nodePath: string;
 *   npmPath: string;
 *   env?: NodeJS.ProcessEnv;
 *   runInstallImpl?: null | ((args: {
 *     repoRoot: string;
 *     npmPath: string;
 *     env: NodeJS.ProcessEnv;
 *   }) => Promise<void>);
 *   staleLockMs?: number;
 *   pollIntervalMs?: number;
 * }} options
 */
export async function ensureCodeq8ActionRuntime({
  repoRoot,
  nodePath,
  npmPath,
  env = process.env,
  runInstallImpl = null,
  staleLockMs = DEFAULT_STALE_LOCK_MS,
  pollIntervalMs = DEFAULT_LOCK_POLL_INTERVAL_MS,
}) {
  const normalizedRepoRootText = normalizeText(repoRoot);
  const normalizedNodePathText = normalizeText(nodePath);
  const normalizedNpmPathText = normalizeText(npmPath);
  if (!normalizedRepoRootText || !normalizedNodePathText || !normalizedNpmPathText) {
    throw new Error("repoRoot, nodePath, and npmPath are required.");
  }
  const normalizedRepoRoot = path.resolve(normalizedRepoRootText);
  const normalizedNodePath = path.resolve(normalizedNodePathText);
  const normalizedNpmPath = path.resolve(normalizedNpmPathText);

  const stamp = await buildCodeq8ActionRuntimeStamp({
    repoRoot: normalizedRepoRoot,
    nodePath: normalizedNodePath,
    npmPath: normalizedNpmPath,
  });

  if (
    !(await codeq8ActionRuntimeNeedsInstall({
      repoRoot: normalizedRepoRoot,
      expectedStamp: stamp,
    }))
  ) {
    return {
      installed: false,
      stamp,
      stampFilePath: resolveRuntimeStampFile(normalizedRepoRoot),
    };
  }

  return await withRuntimeInstallLock(
    {
      repoRoot: normalizedRepoRoot,
      staleLockMs,
      pollIntervalMs,
    },
    async () => {
      if (
        !(await codeq8ActionRuntimeNeedsInstall({
          repoRoot: normalizedRepoRoot,
          expectedStamp: stamp,
        }))
      ) {
        return {
          installed: false,
          stamp,
          stampFilePath: resolveRuntimeStampFile(normalizedRepoRoot),
        };
      }

      if (typeof runInstallImpl === "function") {
        await runInstallImpl({
          repoRoot: normalizedRepoRoot,
          npmPath: normalizedNpmPath,
          env,
        });
      } else {
        await runNpmInstall({
          repoRoot: normalizedRepoRoot,
          npmPath: normalizedNpmPath,
          env,
        });
      }

      await writeRuntimeStamp(normalizedRepoRoot, stamp);
      return {
        installed: true,
        stamp,
        stampFilePath: resolveRuntimeStampFile(normalizedRepoRoot),
      };
    },
  );
}

async function main() {
  const { repoRoot, nodePath, npmPath } = parseArgs();
  const result = await ensureCodeq8ActionRuntime({
    repoRoot,
    nodePath,
    npmPath,
  });
  const normalizedRepoRoot = path.resolve(normalizeText(repoRoot));
  if (result.installed) {
    console.log(
      `[codeq8-action-runtime] installed dependencies in ${normalizedRepoRoot}`,
    );
    return;
  }
  console.log(
    `[codeq8-action-runtime] dependencies already prepared in ${normalizedRepoRoot}`,
  );
}

const executedAsScript = path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);

if (executedAsScript) {
  await main();
}
