#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  readRequiredActionNodeMajor,
  resolveActionRuntimeConfigPath,
} from "./action-runtime-config.mjs";

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeNodeMajor(value) {
  const match = normalizeText(value).match(/^v?(\d{1,3})/);
  return match ? match[1] : "";
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, `'\"'\"'`)}'`;
}

function isTruthyFlag(value) {
  return ["1", "true", "yes", "on"].includes(normalizeText(value).toLowerCase());
}

async function ensureDirectory(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

async function pathIsExecutable(targetPath) {
  const normalized = normalizeText(targetPath);
  if (!normalized) {
    return false;
  }
  try {
    await fs.access(normalized, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function listNodeBins(baseDirectory) {
  const normalizedBaseDirectory = normalizeText(baseDirectory);
  if (!normalizedBaseDirectory) {
    return [];
  }
  let entries = [];
  try {
    entries = await fs.readdir(normalizedBaseDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(normalizedBaseDirectory, entry.name, "bin", "node");
    if (await pathIsExecutable(candidate)) {
      matches.push(candidate);
    }
  }
  return matches;
}

async function listHomebrewNodeBins(cellarDirectory) {
  const normalizedCellarDirectory = normalizeText(cellarDirectory);
  if (!normalizedCellarDirectory) {
    return [];
  }
  let entries = [];
  try {
    entries = await fs.readdir(normalizedCellarDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!(entry.name === "node" || entry.name.startsWith("node@"))) {
      continue;
    }
    matches.push(...(await listNodeBins(path.join(normalizedCellarDirectory, entry.name))));
  }
  return matches;
}

async function readCommandOutput(command, args, env = process.env) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.on("close", () => resolve(normalizeText(stdout)));
    child.on("error", () => resolve(""));
  });
}

function readPathEntries(env = process.env) {
  return normalizeText(env.PATH || process.env.PATH || "")
    .split(path.delimiter)
    .map((entry) => normalizeText(entry))
    .filter(Boolean);
}

async function resolveCommandPaths(commandName, env = process.env) {
  const normalizedCommandName = normalizeText(commandName);
  if (!normalizedCommandName) {
    return [];
  }
  const matches = [];
  for (const directory of readPathEntries(env)) {
    const candidatePath = path.join(directory, normalizedCommandName);
    if (await pathIsExecutable(candidatePath)) {
      matches.push(candidatePath);
    }
  }
  return matches;
}

async function readNodeMajorVersion(nodePath) {
  const normalizedNodePath = normalizeText(nodePath);
  if (!normalizedNodePath) {
    return "";
  }
  return normalizeNodeMajor(
    await readCommandOutput(normalizedNodePath, ["-p", "process.versions.node.split('.')[0]"]),
  );
}

function readNodeRuntimeCacheDirectory(env = process.env) {
  const explicit = normalizeText(env.CODEQ8_NODE_RUNTIME_DIR || "");
  if (explicit) {
    return path.resolve(explicit);
  }
  const homeDirectory = normalizeText(env.HOME);
  if (homeDirectory) {
    return path.join(homeDirectory, ".codeq8", "tooling", "node");
  }
  return path.join(os.tmpdir(), "codeq8-tooling-node");
}

function resolveNodeArtifactPlatform(env = process.env) {
  const platform = normalizeText(env.CODEQ8_NODE_RUNTIME_PLATFORM || process.platform);
  const arch = normalizeText(env.CODEQ8_NODE_RUNTIME_ARCH || process.arch);
  if (platform === "darwin") {
    if (arch === "arm64") {
      return "darwin-arm64";
    }
    if (arch === "x64") {
      return "darwin-x64";
    }
  }
  if (platform === "linux") {
    if (arch === "arm64") {
      return "linux-arm64";
    }
    if (arch === "x64") {
      return "linux-x64";
    }
  }
  return "";
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unable to fetch ${url} (${response.status}).`);
  }
  return await response.json();
}

async function downloadFile(url, targetPath) {
  const response = await fetch(url, { cache: "no-store", redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download ${url} (${response.status}).`);
  }
  await ensureDirectory(path.dirname(targetPath));
  const readable = Readable.fromWeb(response.body);
  const writable = await fs.open(targetPath, "w");
  try {
    await pipeline(readable, writable.createWriteStream());
  } finally {
    await writable.close();
  }
}

async function spawnAndWait(command, args, { cwd } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed (code=${code ?? "null"} signal=${signal || "none"}).`,
        ),
      );
    });
  });
}

async function resolveProvisionedNodeBinary({ requiredMajor, env = process.env }) {
  const normalizedRequiredMajor = normalizeNodeMajor(requiredMajor);
  if (!normalizedRequiredMajor) {
    return "";
  }

  const artifactPlatform = resolveNodeArtifactPlatform(env);
  if (!artifactPlatform) {
    throw new Error(
      `Automatic Node provisioning is not supported on ${
        normalizeText(env.CODEQ8_NODE_RUNTIME_PLATFORM || process.platform)
      }/${normalizeText(env.CODEQ8_NODE_RUNTIME_ARCH || process.arch)}.`,
    );
  }

  const tarBinary = normalizeText((await resolveCommandPaths("tar", env))[0] || "");
  if (!tarBinary) {
    throw new Error("tar is required to provision the requested Node runtime.");
  }

  const fetchedReleaseIndex = await fetchJson("https://nodejs.org/dist/index.json");
  const releaseIndex = Array.isArray(fetchedReleaseIndex) ? fetchedReleaseIndex : [];
  const matchingRelease = releaseIndex.find((entry) => {
    const version = normalizeText(entry?.version || "");
    return normalizeNodeMajor(version) === normalizedRequiredMajor;
  });
  if (!matchingRelease) {
    throw new Error(`Unable to find a downloadable Node ${normalizedRequiredMajor} release.`);
  }

  const version = normalizeText(matchingRelease.version);
  const cacheDirectory = readNodeRuntimeCacheDirectory(env);
  const installDirectory = path.join(cacheDirectory, `${version}-${artifactPlatform}`);
  const nodeBinaryPath = path.join(installDirectory, "bin", "node");
  if (await pathIsExecutable(nodeBinaryPath)) {
    return nodeBinaryPath;
  }

  const archiveName = `node-${version}-${artifactPlatform}.tar.gz`;
  const archiveUrl = `https://nodejs.org/dist/${version}/${archiveName}`;
  await ensureDirectory(cacheDirectory);
  const tempRoot = await fs.mkdtemp(path.join(cacheDirectory, "install-"));
  const archivePath = path.join(tempRoot, archiveName);
  const extractDirectory = path.join(tempRoot, "extract");
  const strippedDirectory = path.join(tempRoot, "runtime");

  try {
    await downloadFile(archiveUrl, archivePath);
    await ensureDirectory(extractDirectory);
    await ensureDirectory(strippedDirectory);
    await spawnAndWait(tarBinary, ["-xzf", archivePath, "-C", extractDirectory]);

    const extractedEntries = await fs.readdir(extractDirectory, { withFileTypes: true });
    const extractedRoot = extractedEntries.find((entry) => entry.isDirectory());
    if (!extractedRoot) {
      throw new Error(`Unable to extract ${archiveName}.`);
    }

    await fs.rename(path.join(extractDirectory, extractedRoot.name), strippedDirectory);
    await ensureDirectory(path.dirname(installDirectory));
    await fs.rm(installDirectory, { recursive: true, force: true });
    await fs.rename(strippedDirectory, installDirectory);
  } catch (error) {
    throw new Error(
      `Unable to provision Node ${normalizedRequiredMajor}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  if (!(await pathIsExecutable(nodeBinaryPath))) {
    throw new Error(`Provisioned Node ${normalizedRequiredMajor} but no executable was found.`);
  }
  return nodeBinaryPath;
}

async function buildNodeCandidatePaths(env = process.env) {
  const homeDirectory = normalizeText(env.HOME);
  const skipGlobalDiscovery = isTruthyFlag(env.CODEQ8_NODE_SKIP_GLOBAL_DISCOVERY);
  const candidates = [
    normalizeText(env.CODEQ8_NODE_BIN || ""),
    normalizeText(env.NODE || ""),
    normalizeText(process.execPath || ""),
    ...(skipGlobalDiscovery
      ? []
      : [
          ...(await resolveCommandPaths("node", env)),
        ]),
    homeDirectory ? path.join(homeDirectory, ".volta", "bin", "node") : "",
    homeDirectory ? path.join(homeDirectory, ".local", "bin", "node") : "",
    ...(skipGlobalDiscovery
      ? []
      : [
          "/opt/homebrew/bin/node",
          "/opt/homebrew/opt/node@20/bin/node",
          "/opt/homebrew/opt/node@22/bin/node",
          "/opt/homebrew/opt/node@24/bin/node",
          "/usr/local/bin/node",
          "/usr/local/opt/node@20/bin/node",
          "/usr/local/opt/node@22/bin/node",
          "/usr/local/opt/node@24/bin/node",
          "/usr/bin/node",
        ]),
    ...(homeDirectory
      ? await listNodeBins(path.join(homeDirectory, ".nvm", "versions", "node"))
      : []),
    ...(homeDirectory
      ? await listNodeBins(path.join(homeDirectory, ".asdf", "installs", "nodejs"))
      : []),
    ...(homeDirectory ? await listNodeBins(path.join(homeDirectory, ".asdf", "installs", "node")) : []),
    ...(skipGlobalDiscovery ? [] : await listHomebrewNodeBins("/opt/homebrew/Cellar")),
    ...(skipGlobalDiscovery ? [] : await listHomebrewNodeBins("/usr/local/Cellar")),
  ];

  const seen = new Set();
  const uniqueCandidates = [];
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeText(candidate);
    if (!normalizedCandidate || seen.has(normalizedCandidate)) {
      continue;
    }
    seen.add(normalizedCandidate);
    uniqueCandidates.push(normalizedCandidate);
  }
  return uniqueCandidates;
}

export async function resolveActionNodeRuntime({
  actionRoot = process.cwd(),
  env = process.env,
} = {}) {
  const normalizedActionRoot = path.resolve(actionRoot);
  const requiredMajor = await readRequiredActionNodeMajor({ actionRoot: normalizedActionRoot });
  const candidatePaths = await buildNodeCandidatePaths(env);
  const inspected = [];

  for (const candidatePath of candidatePaths) {
    if (!(await pathIsExecutable(candidatePath))) {
      continue;
    }
    const major = await readNodeMajorVersion(candidatePath);
    if (!major) {
      continue;
    }
    inspected.push({ nodePath: candidatePath, major });
  }

  const fallback = inspected[0] || null;
  if (!requiredMajor) {
    if (!fallback) {
      throw new Error("node is required on the self-hosted runner.");
    }
    return {
      nodePath: fallback.nodePath,
      requiredMajor: "",
      resolvedMajor: fallback.major,
      inspected,
    };
  }

  const matchingCandidate = inspected.find((candidate) => candidate.major === requiredMajor);
  if (matchingCandidate) {
    return {
      nodePath: matchingCandidate.nodePath,
      requiredMajor,
      resolvedMajor: matchingCandidate.major,
      inspected,
    };
  }

  const inspectedSummary = inspected
    .map((candidate) => `${candidate.nodePath} (v${candidate.major})`)
    .join(", ");
  const requiredMajorSource = resolveActionRuntimeConfigPath(normalizedActionRoot);
  try {
    const provisionedNodePath = await resolveProvisionedNodeBinary({
      requiredMajor,
      env,
    });
    const provisionedMajor = await readNodeMajorVersion(provisionedNodePath);
    if (provisionedMajor === requiredMajor) {
      return {
        nodePath: provisionedNodePath,
        requiredMajor,
        resolvedMajor: provisionedMajor,
        inspected: [...inspected, { nodePath: provisionedNodePath, major: provisionedMajor }],
      };
    }
  } catch (error) {
    throw new Error(
      `Node ${requiredMajor} is required by ${requiredMajorSource}. ` +
        `Current runner node is ${process.version}. ` +
        `${error instanceof Error ? error.message : String(error)}` +
        `${inspectedSummary ? `; inspected: ${inspectedSummary}` : ""}.`,
    );
  }

  throw new Error(
    `Node ${requiredMajor} is required by ${requiredMajorSource}. ` +
      `Current runner node is ${process.version}. ` +
      `Matching node binary not found${inspectedSummary ? `; inspected: ${inspectedSummary}` : ""}.`,
  );
}

function readArgumentValue(argumentsList, flagName) {
  const index = argumentsList.indexOf(flagName);
  if (index === -1) {
    return "";
  }
  return normalizeText(argumentsList[index + 1] || "");
}

function formatShellAssignments(resolution) {
  return [
    `CODEQ8_RESOLVED_NODE_BIN=${shellQuote(resolution.nodePath)}`,
    `CODEQ8_REQUIRED_NODE_MAJOR=${shellQuote(resolution.requiredMajor)}`,
    `CODEQ8_RESOLVED_NODE_MAJOR=${shellQuote(resolution.resolvedMajor)}`,
  ].join("\n");
}

async function main() {
  const actionRoot = readArgumentValue(process.argv, "--action-root") || process.cwd();
  const format = readArgumentValue(process.argv, "--format") || "json";
  const resolution = await resolveActionNodeRuntime({ actionRoot });
  if (format === "shell") {
    process.stdout.write(`${formatShellAssignments(resolution)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(resolution)}\n`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
