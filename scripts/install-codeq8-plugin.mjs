#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CODEQ8_PLUGIN_NAME = "codeq8";
export const CODEQ8_PLUGIN_CAPABILITY = "codeq8_plugin";
export const CODEQ8_PLUGIN_RUN_BEHAVIOR_SKILLS_CAPABILITY =
  "codeq8_plugin_run_behavior_skills";
export const CODEQ8_PLUGIN_PLAYWRIGHT_MCP_CAPABILITY =
  "codeq8_plugin_playwright_mcp";
export const CODEQ8_PLUGIN_MARKER_FILE = ".codeq8-managed.json";
export const CODEQ8_PLUGIN_MANAGED_BY = "codeq8-plugin-installer";
export const CODEQ8_PLUGIN_SOURCE_REPOSITORY = "Codeq8/codeq8-action";
export const CODEQ8_PLUGIN_SOURCE_RELATIVE_PATH = "plugins/codeq8";
export const CODEQ8_PLUGIN_MARKETPLACE_ENTRY_MARKER_FILE =
  "codeq8.marketplace-entry.codeq8-managed.json";
export const CODEQ8_PLUGIN_RUN_BEHAVIOR_SKILLS = [
  "codeq8-coordinator",
  "codeq8-mcp",
  "codeq8-onboarding",
];
export const CODEQ8_PLUGIN_PUBLIC_SKILLS = [
  ...CODEQ8_PLUGIN_RUN_BEHAVIOR_SKILLS,
  "codeq8-plugin",
];
export const OBSOLETE_CODEQ8_PLUGIN_SKILLS = [
  "codeq8-child-threads",
  "codeq8-learn",
  "codeq8-lessons",
  "codeq8-skill-stewardship",
];

const MARKER_SCHEMA_VERSION = 1;
const OPTIONAL_SKIP_STATUSES = new Set(["source_missing", "collision", "invalid_source"]);

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

function normalizeJsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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

async function readJsonFile(targetPath) {
  const contents = await fs.readFile(targetPath, "utf8");
  return JSON.parse(contents);
}

async function writeJsonFile(targetPath, value) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function listFilesRecursive(rootPath) {
  const normalizedRootPath = path.resolve(rootPath);
  const entries = [];

  async function visit(currentPath) {
    const children = await fs.readdir(currentPath, { withFileTypes: true });
    for (const child of children) {
      const childPath = path.join(currentPath, child.name);
      if (child.isDirectory()) {
        await visit(childPath);
        continue;
      }
      if (!child.isFile()) {
        continue;
      }
      const relativePath = path
        .relative(normalizedRootPath, childPath)
        .split(path.sep)
        .join("/");
      entries.push({
        path: childPath,
        relativePath,
      });
    }
  }

  await visit(normalizedRootPath);
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function hashDirectory(rootPath) {
  const hash = crypto.createHash("sha256");
  const files = await listFilesRecursive(rootPath);
  for (const file of files) {
    hash.update(`${file.relativePath}\0`);
    hash.update(await fs.readFile(file.path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function resolveCodeq8PluginInstallPaths({
  repoRoot,
  env = process.env,
  pluginSourceRelativePath = CODEQ8_PLUGIN_SOURCE_RELATIVE_PATH,
}) {
  const normalizedRepoRoot = path.resolve(normalizeText(repoRoot) || process.cwd());
  const homePath = normalizeText(env.HOME) || os.homedir();
  const codexHome = normalizeText(env.CODEX_HOME)
    ? path.resolve(normalizeText(env.CODEX_HOME))
    : homePath
      ? path.join(homePath, ".codex")
      : "";

  return {
    repoRoot: normalizedRepoRoot,
    homePath,
    codexHome,
    sourcePluginPath: path.join(normalizedRepoRoot, pluginSourceRelativePath),
    pluginInstallPath: codexHome ? path.join(codexHome, "plugins", CODEQ8_PLUGIN_NAME) : "",
    marketplacePath: homePath
      ? path.join(homePath, ".agents", "plugins", "marketplace.json")
      : "",
    marketplaceMarkerPath: homePath
      ? path.join(homePath, ".agents", "plugins", CODEQ8_PLUGIN_MARKETPLACE_ENTRY_MARKER_FILE)
      : "",
    skillInstallRoot: codexHome ? path.join(codexHome, "skills") : "",
  };
}

async function readPluginManifest(sourcePluginPath) {
  const manifestPath = path.join(sourcePluginPath, ".codex-plugin", "plugin.json");
  const manifest = normalizeJsonObject(await readJsonFile(manifestPath));
  const pluginName = normalizeText(manifest.name);
  const pluginVersion = normalizeText(manifest.version);
  if (pluginName !== CODEQ8_PLUGIN_NAME) {
    throw new Error(`Codeq8 plugin manifest name must be ${CODEQ8_PLUGIN_NAME}.`);
  }
  if (!pluginVersion) {
    throw new Error("Codeq8 plugin manifest version is required.");
  }
  return {
    manifest,
    manifestPath,
    pluginVersion,
  };
}

async function listBundledSkills(sourcePluginPath, manifest) {
  const skillsRelativePath = normalizeText(manifest.skills) || "./skills/";
  const normalizedSkillsRelativePath = skillsRelativePath.replace(/^\.\//, "");
  const skillsRoot = path.join(sourcePluginPath, normalizedSkillsRelativePath);
  if (!(await pathExists(skillsRoot))) {
    return [];
  }

  const children = await fs.readdir(skillsRoot, { withFileTypes: true });
  const skills = [];
  for (const child of children) {
    if (!child.isDirectory()) {
      continue;
    }
    const sourcePath = path.join(skillsRoot, child.name);
    if (!(await pathExists(path.join(sourcePath, "SKILL.md")))) {
      continue;
    }
    skills.push({
      name: child.name,
      sourcePath,
    });
  }
  const sortedSkills = skills.sort((left, right) => left.name.localeCompare(right.name));
  const allowedSkillNames = new Set(CODEQ8_PLUGIN_PUBLIC_SKILLS);
  const unexpectedSkillNames = sortedSkills
    .map((skill) => skill.name)
    .filter((skillName) => !allowedSkillNames.has(skillName));
  if (unexpectedSkillNames.length > 0) {
    throw new Error(
      `Codeq8 plugin source contains non-public bundled skills: ${unexpectedSkillNames.join(
        ", ",
      )}. Add public plugin skills to CODEQ8_PLUGIN_PUBLIC_SKILLS only after a reviewed public-action rollout decision.`,
    );
  }
  return sortedSkills;
}

async function listBundledMcpServerNames(sourcePluginPath, manifest) {
  const mcpServersRelativePath = normalizeText(manifest.mcpServers);
  if (!mcpServersRelativePath) {
    return [];
  }
  const normalizedMcpServersRelativePath = mcpServersRelativePath.replace(/^\.\//, "");
  const mcpServersPath = path.join(sourcePluginPath, normalizedMcpServersRelativePath);
  if (!(await pathExists(mcpServersPath))) {
    throw new Error("Codeq8 plugin manifest references missing MCP server config.");
  }
  const mcpServers = normalizeJsonObject(await readJsonFile(mcpServersPath));
  return Object.keys(mcpServers)
    .map((entry) => normalizeText(entry))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function buildPluginCapabilities({ mcpServerNames = [], skillNames = [] } = {}) {
  const capabilities = [CODEQ8_PLUGIN_CAPABILITY];
  const skillNameSet = new Set(normalizeList(skillNames));
  if (CODEQ8_PLUGIN_RUN_BEHAVIOR_SKILLS.every((skillName) => skillNameSet.has(skillName))) {
    capabilities.push(CODEQ8_PLUGIN_RUN_BEHAVIOR_SKILLS_CAPABILITY);
  }
  if (normalizeList(mcpServerNames).includes("playwright")) {
    capabilities.push(CODEQ8_PLUGIN_PLAYWRIGHT_MCP_CAPABILITY);
  }
  return capabilities;
}

async function readManagedMarker(targetPath) {
  try {
    const marker = normalizeJsonObject(
      await readJsonFile(path.join(targetPath, CODEQ8_PLUGIN_MARKER_FILE)),
    );
    if (
      Number(marker.schema_version) === MARKER_SCHEMA_VERSION &&
      normalizeText(marker.managed_by) === CODEQ8_PLUGIN_MANAGED_BY &&
      normalizeText(marker.plugin_name) === CODEQ8_PLUGIN_NAME
    ) {
      return marker;
    }
  } catch {
    return null;
  }
  return null;
}

async function assertManagedDirectoryOrAbsent(targetPath, collisionTarget) {
  if (!(await pathExists(targetPath))) {
    return;
  }
  const stat = await fs.lstat(targetPath);
  if (!stat.isDirectory()) {
    throw new Error(`${collisionTarget} exists but is not a Codeq8-managed directory.`);
  }
  const marker = await readManagedMarker(targetPath);
  if (!marker) {
    throw new Error(`${collisionTarget} exists without a Codeq8 ownership marker.`);
  }
}

async function readMarketplaceState(marketplacePath, markerPath) {
  if (!(await pathExists(marketplacePath))) {
    return {
      marketplace: {
        name: "personal",
        interface: {
          displayName: "Personal",
        },
        plugins: [],
      },
      marker: null,
      entryIndex: -1,
      exists: false,
    };
  }

  const marketplace = normalizeJsonObject(await readJsonFile(marketplacePath));
  if (!Array.isArray(marketplace.plugins)) {
    throw new Error("marketplace exists with an unsupported plugins shape.");
  }

  let marker = null;
  try {
    marker = normalizeJsonObject(await readJsonFile(markerPath));
  } catch {
    marker = null;
  }

  const entryIndex = marketplace.plugins.findIndex(
    (entry) => normalizeText(normalizeJsonObject(entry).name) === CODEQ8_PLUGIN_NAME,
  );
  if (entryIndex >= 0) {
    if (
      Number(marker?.schema_version) !== MARKER_SCHEMA_VERSION ||
      normalizeText(marker?.managed_by) !== CODEQ8_PLUGIN_MANAGED_BY ||
      normalizeText(marker?.plugin_name) !== CODEQ8_PLUGIN_NAME
    ) {
      throw new Error("marketplace already has an unmarked Codeq8 plugin entry.");
    }
  }

  return {
    marketplace,
    marker,
    entryIndex,
    exists: true,
  };
}

function buildManagedMarker({
  targetKind,
  targetName,
  pluginVersion,
  sourceRef,
  artifactHash,
  installedAt,
}) {
  return {
    schema_version: MARKER_SCHEMA_VERSION,
    managed_by: CODEQ8_PLUGIN_MANAGED_BY,
    product: "Codeq8 plugin",
    plugin_name: CODEQ8_PLUGIN_NAME,
    plugin_version: pluginVersion,
    source_repository: CODEQ8_PLUGIN_SOURCE_REPOSITORY,
    source_ref: normalizeText(sourceRef) || "unknown",
    artifact_hash: artifactHash,
    target_kind: targetKind,
    target_name: targetName,
    installed_at: installedAt,
  };
}

export function buildMarketplaceSourcePath({ marketplaceRootPath, pluginInstallPath }) {
  const normalizedMarketplaceRootPath = path.resolve(marketplaceRootPath);
  const normalizedPluginInstallPath = path.resolve(pluginInstallPath);
  const relativePath = path
    .relative(normalizedMarketplaceRootPath, normalizedPluginInstallPath)
    .split(path.sep)
    .join("/");
  return `./${relativePath.replace(/^\.\//, "")}`;
}

function buildMarketplaceEntry({ sourcePath }) {
  return {
    name: CODEQ8_PLUGIN_NAME,
    source: {
      source: "local",
      path: sourcePath,
    },
    policy: {
      installation: "INSTALLED_BY_DEFAULT",
      authentication: "ON_INSTALL",
    },
    category: "Developer Tools",
  };
}

async function replaceManagedDirectory({ sourcePath, targetPath, marker }) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(targetPath),
    `.codeq8-plugin-${path.basename(targetPath)}-${process.pid}-${Date.now()}.tmp`,
  );
  await fs.rm(tempPath, { recursive: true, force: true });
  await fs.cp(sourcePath, tempPath, { recursive: true, force: false, errorOnExist: true });
  await writeJsonFile(path.join(tempPath, CODEQ8_PLUGIN_MARKER_FILE), marker);
  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.rename(tempPath, targetPath);
}

async function removeObsoleteManagedSkills({ skillInstallRoot, activeSkills }) {
  const activeSkillNames = new Set(activeSkills.map((skill) => skill.name));
  const removed = [];
  for (const skillName of OBSOLETE_CODEQ8_PLUGIN_SKILLS) {
    if (activeSkillNames.has(skillName)) {
      continue;
    }
    const targetPath = path.join(skillInstallRoot, skillName);
    if (!(await pathExists(targetPath))) {
      continue;
    }
    const marker = await readManagedMarker(targetPath);
    if (!marker) {
      continue;
    }
    await fs.rm(targetPath, { recursive: true, force: true });
    removed.push(skillName);
  }
  return removed;
}

async function updateMarketplaceEntry({ marketplacePath, markerPath, state, marker, sourcePath }) {
  const marketplace = {
    ...state.marketplace,
    interface: normalizeJsonObject(state.marketplace.interface),
    plugins: [...state.marketplace.plugins],
  };
  const entry = buildMarketplaceEntry({ sourcePath });
  if (state.entryIndex >= 0) {
    marketplace.plugins[state.entryIndex] = entry;
  } else {
    marketplace.plugins.push(entry);
  }
  await writeJsonFile(marketplacePath, marketplace);
  await writeJsonFile(markerPath, {
    ...marker,
    target_kind: "marketplace_entry",
    target_name: CODEQ8_PLUGIN_NAME,
    marketplace_entry: entry,
  });
}

async function readLocalGitSha(repoRoot) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      timeout: 3000,
      maxBuffer: 64 * 1024,
    });
    return normalizeText(stdout);
  } catch {
    return "";
  }
}

function summarizeResult(result) {
  const base = [
    `status=${result.status}`,
    `plugin=${result.plugin}`,
    `version=${result.version || "unknown"}`,
    `source_ref=${result.sourceRef || "unknown"}`,
    `artifact_hash=${result.artifactHash ? result.artifactHash.slice(0, 16) : "unknown"}`,
    `capabilities=${normalizeList(result.capabilities).join(",") || "none"}`,
  ];
  if (result.reason) {
    base.push(`reason=${result.reason}`);
  }
  if (Array.isArray(result.targets) && result.targets.length > 0) {
    base.push(`targets=${result.targets.join(",")}`);
  }
  return base.join(" ");
}

export async function syncCodeq8PluginInstall({
  repoRoot,
  env = process.env,
  sourceRef = "",
  now = () => new Date(),
  logger = null,
} = {}) {
  const paths = resolveCodeq8PluginInstallPaths({ repoRoot, env });
  let capabilities = buildPluginCapabilities();
  const startedAt = now().toISOString();

  if (!paths.homePath || !paths.codexHome) {
    return {
      ok: false,
      status: "skipped",
      code: "missing_home",
      reason: "HOME or Codex home could not be resolved.",
      plugin: CODEQ8_PLUGIN_NAME,
      version: "",
      sourceRef: "",
      artifactHash: "",
      capabilities,
      targets: [],
    };
  }

  if (!(await pathExists(paths.sourcePluginPath))) {
    return {
      ok: false,
      status: "skipped",
      code: "source_missing",
      reason: "Codeq8 plugin source package is not present.",
      plugin: CODEQ8_PLUGIN_NAME,
      version: "",
      sourceRef: "",
      artifactHash: "",
      capabilities,
      targets: [],
    };
  }

  let pluginVersion = "";
  let artifactHash = "";
  let skills = [];
  let mcpServerNames = [];
  try {
    const source = await readPluginManifest(paths.sourcePluginPath);
    pluginVersion = source.pluginVersion;
    artifactHash = await hashDirectory(paths.sourcePluginPath);
    skills = await listBundledSkills(paths.sourcePluginPath, source.manifest);
    mcpServerNames = await listBundledMcpServerNames(
      paths.sourcePluginPath,
      source.manifest,
    );
    capabilities = buildPluginCapabilities({
      mcpServerNames,
      skillNames: skills.map((skill) => skill.name),
    });
  } catch (error) {
    return {
      ok: false,
      status: "skipped",
      code: "invalid_source",
      reason: error instanceof Error ? error.message : String(error),
      plugin: CODEQ8_PLUGIN_NAME,
      version: pluginVersion,
      sourceRef: "",
      artifactHash,
      capabilities,
      targets: [],
    };
  }

  const resolvedSourceRef =
    normalizeText(sourceRef) ||
    normalizeText(env.CODEQ8_ACTION_SOURCE_SHA) ||
    (await readLocalGitSha(paths.repoRoot)) ||
    "unknown";

  let marketplaceState = null;
  try {
    await assertManagedDirectoryOrAbsent(
      paths.pluginInstallPath,
      `plugin:${CODEQ8_PLUGIN_NAME}`,
    );
    for (const skill of skills) {
      await assertManagedDirectoryOrAbsent(
        path.join(paths.skillInstallRoot, skill.name),
        `skill:${skill.name}`,
      );
    }
    marketplaceState = await readMarketplaceState(
      paths.marketplacePath,
      paths.marketplaceMarkerPath,
    );
  } catch (error) {
    return {
      ok: false,
      status: "skipped",
      code: "collision",
      reason: error instanceof Error ? error.message : String(error),
      plugin: CODEQ8_PLUGIN_NAME,
      version: pluginVersion,
      sourceRef: resolvedSourceRef,
      artifactHash,
      capabilities,
      targets: [],
    };
  }

  const baseMarker = buildManagedMarker({
    targetKind: "plugin",
    targetName: CODEQ8_PLUGIN_NAME,
    pluginVersion,
    sourceRef: resolvedSourceRef,
    artifactHash,
    installedAt: startedAt,
  });
  const marketplaceSourcePath = buildMarketplaceSourcePath({
    marketplaceRootPath: paths.homePath,
    pluginInstallPath: paths.pluginInstallPath,
  });

  await replaceManagedDirectory({
    sourcePath: paths.sourcePluginPath,
    targetPath: paths.pluginInstallPath,
    marker: baseMarker,
  });

  const targets = [
    "plugin",
    ...mcpServerNames.map((serverName) => `mcp:${serverName}`),
  ];
  for (const skill of skills) {
    await replaceManagedDirectory({
      sourcePath: skill.sourcePath,
      targetPath: path.join(paths.skillInstallRoot, skill.name),
      marker: buildManagedMarker({
        targetKind: "skill",
        targetName: skill.name,
        pluginVersion,
        sourceRef: resolvedSourceRef,
        artifactHash,
        installedAt: startedAt,
      }),
    });
    targets.push(`skill:${skill.name}`);
  }

  const removedObsoleteSkills = await removeObsoleteManagedSkills({
    skillInstallRoot: paths.skillInstallRoot,
    activeSkills: skills,
  });
  for (const skillName of removedObsoleteSkills) {
    targets.push(`removed-skill:${skillName}`);
  }

  await updateMarketplaceEntry({
    marketplacePath: paths.marketplacePath,
    markerPath: paths.marketplaceMarkerPath,
    state: marketplaceState,
    marker: baseMarker,
    sourcePath: marketplaceSourcePath,
  });
  targets.push("marketplace");

  const result = {
    ok: true,
    status: "installed",
    code: "installed",
    reason: "",
    plugin: CODEQ8_PLUGIN_NAME,
    version: pluginVersion,
    sourceRef: resolvedSourceRef,
    artifactHash,
    capabilities,
    targets,
  };
  logger?.log?.(`[codeq8-plugin] ${summarizeResult(result)}`);
  return result;
}

function parseArgs(argv = process.argv.slice(2)) {
  const result = {
    repoRoot: "",
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
    }
  }
  return result;
}

async function main() {
  const { repoRoot } = parseArgs();
  const result = await syncCodeq8PluginInstall({
    repoRoot: repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    logger: console,
  });
  if (result.ok) {
    return;
  }
  const summary = summarizeResult(result);
  if (OPTIONAL_SKIP_STATUSES.has(result.code)) {
    console.warn(`::warning::[codeq8-plugin] ${summary}`);
    return;
  }
  console.warn(`::warning::[codeq8-plugin] ${summary}`);
}

const executedAsScript = path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);

if (executedAsScript) {
  await main();
}
