import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEQ8_PLUGIN_CAPABILITY,
  CODEQ8_PLUGIN_MARKER_FILE,
  CODEQ8_PLUGIN_NAME,
  CODEQ8_PLUGIN_SOURCE_RELATIVE_PATH,
  CODEQ8_PLUGIN_MARKETPLACE_ENTRY_MARKER_FILE,
  hashDirectory,
  syncCodeq8PluginInstall,
} from "./install-codeq8-plugin.mjs";

const FIXED_NOW = () => new Date("2026-06-15T00:00:00.000Z");

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(targetPath) {
  return JSON.parse(await fs.readFile(targetPath, "utf8"));
}

async function withTempInstallRoot(fn) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-plugin-install-"));
  try {
    const homePath = path.join(tempRoot, "home");
    const codexHome = path.join(tempRoot, "codex-home");
    await fs.mkdir(homePath, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    await fn({
      tempRoot,
      homePath,
      codexHome,
      env: {
        HOME: homePath,
        CODEX_HOME: codexHome,
      },
    });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test("Codeq8 plugin install syncs marked plugin, skill, and marketplace state", async () => {
  await withTempInstallRoot(async ({ homePath, codexHome, env }) => {
    const originalEnv = { ...env };
    const expectedArtifactHash = await hashDirectory(
      path.join(process.cwd(), CODEQ8_PLUGIN_SOURCE_RELATIVE_PATH),
    );

    const result = await syncCodeq8PluginInstall({
      repoRoot: process.cwd(),
      env,
      sourceRef: "public-action-sha-1",
      now: FIXED_NOW,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "installed");
    assert.equal(result.plugin, CODEQ8_PLUGIN_NAME);
    assert.equal(result.artifactHash, expectedArtifactHash);
    assert.deepEqual(result.capabilities, [CODEQ8_PLUGIN_CAPABILITY]);
    assert.deepEqual(env, originalEnv);

    const pluginMarker = await readJson(
      path.join(homePath, "plugins", "codeq8", CODEQ8_PLUGIN_MARKER_FILE),
    );
    assert.equal(pluginMarker.managed_by, "codeq8-plugin-installer");
    assert.equal(pluginMarker.plugin_name, "codeq8");
    assert.equal(pluginMarker.source_ref, "public-action-sha-1");
    assert.equal(pluginMarker.artifact_hash, expectedArtifactHash);
    assert.equal(pluginMarker.target_kind, "plugin");

    const skillPath = path.join(codexHome, "skills", "codeq8-plugin");
    const skillMarker = await readJson(path.join(skillPath, CODEQ8_PLUGIN_MARKER_FILE));
    assert.equal(skillMarker.target_kind, "skill");
    assert.equal(skillMarker.target_name, "codeq8-plugin");
    assert.equal(await pathExists(path.join(skillPath, "SKILL.md")), true);

    const marketplace = await readJson(
      path.join(homePath, ".agents", "plugins", "marketplace.json"),
    );
    assert.deepEqual(marketplace.plugins, [
      {
        name: "codeq8",
        source: {
          source: "local",
          path: "./plugins/codeq8",
        },
        policy: {
          installation: "INSTALLED_BY_DEFAULT",
          authentication: "ON_INSTALL",
        },
        category: "Developer Tools",
      },
    ]);
    const marketplaceMarker = await readJson(
      path.join(homePath, ".agents", "plugins", CODEQ8_PLUGIN_MARKETPLACE_ENTRY_MARKER_FILE),
    );
    assert.equal(marketplaceMarker.target_kind, "marketplace_entry");
    assert.equal(marketplaceMarker.source_ref, "public-action-sha-1");

    assert.equal(await pathExists(path.join(codexHome, "auth.json")), false);
    assert.equal(await pathExists(path.join(codexHome, "config.toml")), false);
    assert.equal(await pathExists(path.join(codexHome, "sessions")), false);
  });
});

test("Codeq8 plugin install updates marked marker source fields idempotently", async () => {
  await withTempInstallRoot(async ({ homePath, codexHome, env }) => {
    await syncCodeq8PluginInstall({
      repoRoot: process.cwd(),
      env,
      sourceRef: "public-action-sha-old",
      now: FIXED_NOW,
    });
    await syncCodeq8PluginInstall({
      repoRoot: process.cwd(),
      env,
      sourceRef: "public-action-sha-new",
      now: FIXED_NOW,
    });

    const pluginMarker = await readJson(
      path.join(homePath, "plugins", "codeq8", CODEQ8_PLUGIN_MARKER_FILE),
    );
    const skillMarker = await readJson(
      path.join(codexHome, "skills", "codeq8-plugin", CODEQ8_PLUGIN_MARKER_FILE),
    );
    const marketplaceMarker = await readJson(
      path.join(homePath, ".agents", "plugins", CODEQ8_PLUGIN_MARKETPLACE_ENTRY_MARKER_FILE),
    );

    assert.equal(pluginMarker.source_ref, "public-action-sha-new");
    assert.equal(skillMarker.source_ref, "public-action-sha-new");
    assert.equal(marketplaceMarker.source_ref, "public-action-sha-new");
  });
});

test("Codeq8 plugin install rejects an unmarked plugin directory collision", async () => {
  await withTempInstallRoot(async ({ homePath, codexHome, env }) => {
    const collisionPath = path.join(homePath, "plugins", "codeq8");
    await fs.mkdir(collisionPath, { recursive: true });
    await fs.writeFile(path.join(collisionPath, "README.md"), "user-owned\n", "utf8");

    const result = await syncCodeq8PluginInstall({
      repoRoot: process.cwd(),
      env,
      sourceRef: "public-action-sha",
      now: FIXED_NOW,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "collision");
    assert.match(result.reason, /plugin:codeq8 exists without a Codeq8 ownership marker/);
    assert.deepEqual(result.capabilities, [CODEQ8_PLUGIN_CAPABILITY]);
    assert.equal(
      await fs.readFile(path.join(collisionPath, "README.md"), "utf8"),
      "user-owned\n",
    );
    assert.equal(await pathExists(path.join(codexHome, "skills", "codeq8-plugin")), false);
    assert.equal(
      await pathExists(path.join(homePath, ".agents", "plugins", "marketplace.json")),
      false,
    );
  });
});

test("Codeq8 plugin install rejects an unmarked skill collision", async () => {
  await withTempInstallRoot(async ({ homePath, codexHome, env }) => {
    const skillPath = path.join(codexHome, "skills", "codeq8-plugin");
    await fs.mkdir(skillPath, { recursive: true });
    await fs.writeFile(path.join(skillPath, "SKILL.md"), "# User skill\n", "utf8");

    const result = await syncCodeq8PluginInstall({
      repoRoot: process.cwd(),
      env,
      sourceRef: "public-action-sha",
      now: FIXED_NOW,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "collision");
    assert.match(result.reason, /skill:codeq8-plugin exists without a Codeq8 ownership marker/);
    assert.equal(await fs.readFile(path.join(skillPath, "SKILL.md"), "utf8"), "# User skill\n");
    assert.equal(await pathExists(path.join(homePath, "plugins", "codeq8")), false);
  });
});

test("Codeq8 plugin install rejects an unmarked marketplace entry collision", async () => {
  await withTempInstallRoot(async ({ homePath, codexHome, env }) => {
    const marketplacePath = path.join(homePath, ".agents", "plugins", "marketplace.json");
    await fs.mkdir(path.dirname(marketplacePath), { recursive: true });
    await fs.writeFile(
      marketplacePath,
      `${JSON.stringify(
        {
          name: "personal",
          plugins: [
            {
              name: "codeq8",
              source: {
                source: "local",
                path: "./plugins/user-codeq8",
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await syncCodeq8PluginInstall({
      repoRoot: process.cwd(),
      env,
      sourceRef: "public-action-sha",
      now: FIXED_NOW,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "collision");
    assert.match(result.reason, /unmarked Codeq8 plugin entry/);
    assert.equal(await pathExists(path.join(homePath, "plugins", "codeq8")), false);
    assert.equal(await pathExists(path.join(codexHome, "skills", "codeq8-plugin")), false);
  });
});

test("Codeq8 plugin install skips optional capability when source package is absent", async () => {
  await withTempInstallRoot(async ({ tempRoot, env }) => {
    const emptyRepoRoot = path.join(tempRoot, "empty-repo");
    await fs.mkdir(emptyRepoRoot, { recursive: true });

    const result = await syncCodeq8PluginInstall({
      repoRoot: emptyRepoRoot,
      env,
      sourceRef: "public-action-sha",
      now: FIXED_NOW,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "skipped");
    assert.equal(result.code, "source_missing");
    assert.deepEqual(result.capabilities, [CODEQ8_PLUGIN_CAPABILITY]);
  });
});

test("Codeq8 plugin install source does not mutate CODEX_HOME or Codex auth state", async () => {
  const actionSource = await fs.readFile(path.join(process.cwd(), "action.yml"), "utf8");
  const installerSource = await fs.readFile(
    path.join(process.cwd(), "scripts", "install-codeq8-plugin.mjs"),
    "utf8",
  );

  assert.doesNotMatch(actionSource, /CODEX_HOME=/);
  assert.doesNotMatch(installerSource, /process\.env\.CODEX_HOME\s*=/);
  assert.doesNotMatch(installerSource, /auth\.json|config\.toml|sessions/);
});
