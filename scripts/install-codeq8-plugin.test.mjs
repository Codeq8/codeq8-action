import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEQ8_PLUGIN_CAPABILITY,
  CODEQ8_PLUGIN_MARKER_FILE,
  CODEQ8_PLUGIN_NAME,
  CODEQ8_PLUGIN_PLAYWRIGHT_MCP_CAPABILITY,
  CODEQ8_PLUGIN_PUBLIC_SKILLS,
  CODEQ8_PLUGIN_RUN_BEHAVIOR_SKILLS_CAPABILITY,
  CODEQ8_PLUGIN_SOURCE_RELATIVE_PATH,
  OBSOLETE_CODEQ8_PLUGIN_SKILLS,
  CODEQ8_PLUGIN_MARKETPLACE_ENTRY_MARKER_FILE,
  buildMarketplaceSourcePath,
  hashDirectory,
  resolveCodeq8PluginInstallPaths,
  syncCodeq8PluginInstall,
} from "./install-codeq8-plugin.mjs";

const FIXED_NOW = () => new Date("2026-06-15T00:00:00.000Z");
const CODEQ8_PLUGIN_CAPABILITIES = [
  CODEQ8_PLUGIN_CAPABILITY,
  CODEQ8_PLUGIN_RUN_BEHAVIOR_SKILLS_CAPABILITY,
  CODEQ8_PLUGIN_PLAYWRIGHT_MCP_CAPABILITY,
];

test("Codeq8 plugin skill documents public runtime ownership for bundled skills", async () => {
  const skillSource = await fs.readFile(
    path.join(
      process.cwd(),
      CODEQ8_PLUGIN_SOURCE_RELATIVE_PATH,
      "skills",
      "codeq8-plugin",
      "SKILL.md",
    ),
    "utf8",
  );

  assert.match(
    skillSource,
    /Codeq8-owned skills or skill-maintenance behavior meant to affect normal\s+Codeq8 runs across repositories must live in the Codeq8 plugin/,
  );
  assert.match(
    skillSource,
    /A private app-repo `\.codex\/skills` change can\s+guide internal development, but it is not a shipped runner capability/,
  );
});

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
    const codexHome = path.join(homePath, ".codex-runner");
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
    assert.deepEqual(result.capabilities, CODEQ8_PLUGIN_CAPABILITIES);
    assert.deepEqual(result.targets.slice(0, 2), ["plugin", "mcp:playwright"]);
    assert.deepEqual(env, originalEnv);

    const pluginMarker = await readJson(
      path.join(codexHome, "plugins", "codeq8", CODEQ8_PLUGIN_MARKER_FILE),
    );
    assert.equal(pluginMarker.managed_by, "codeq8-plugin-installer");
    assert.equal(pluginMarker.plugin_name, "codeq8");
    assert.equal(pluginMarker.source_ref, "public-action-sha-1");
    assert.equal(pluginMarker.artifact_hash, expectedArtifactHash);
    assert.equal(pluginMarker.target_kind, "plugin");

    for (const skillName of CODEQ8_PLUGIN_PUBLIC_SKILLS) {
      const skillPath = path.join(codexHome, "skills", skillName);
      const skillMarker = await readJson(path.join(skillPath, CODEQ8_PLUGIN_MARKER_FILE));
      assert.equal(skillMarker.target_kind, "skill");
      assert.equal(skillMarker.target_name, skillName);
      assert.equal(skillMarker.plugin_version, "0.5.3");
      assert.equal(await pathExists(path.join(skillPath, "SKILL.md")), true);
    }

    const installedMcpConfig = await readJson(
      path.join(codexHome, "plugins", "codeq8", ".mcp.json"),
    );
    assert.equal(installedMcpConfig.playwright.command, "playwright-mcp");
    assert.deepEqual(installedMcpConfig.playwright.args, [
      "--browser=chromium",
      "--headless",
      "--isolated",
      "--init-page",
      "./playwright-mcp-auth-init.ts",
    ]);
    assert.deepEqual(installedMcpConfig.playwright.env_vars, [
      "CODEQ8_E2E_GITHUB_WEB_SESSION_COOKIE",
      "CODEQ8_GITHUB_WEB_SESSION_COOKIE",
      "CODEQ8_TRIGGERING_GITHUB_WEB_SESSION_COOKIE",
      "CODE_WEB_CHAT_RUN_TOKEN",
      "CODE_WORKSPACE_REPOSITORY",
      "CODE_CHAT_THREAD_ID",
      "CODE_CHAT_RUN_ID",
      "CODEQ8_MCP_AUTH_HOSTS",
      "PLAYWRIGHT_MCP_AUTH_HOSTS",
      "CODEQ8_MCP_AUTH_URLS",
      "PLAYWRIGHT_MCP_AUTH_URLS",
      "CODE_DEPLOYED_PUBLIC_URL",
      "CODE_PUBLIC_BASE_URL",
      "PLAYWRIGHT_TEST_BASE_URL",
      "PLAYWRIGHT_BROWSERS_PATH",
    ]);
    assert.equal(
      await pathExists(
        path.join(codexHome, "plugins", "codeq8", "playwright-mcp-auth-init.ts"),
      ),
      true,
    );

    const marketplace = await readJson(
      path.join(homePath, ".agents", "plugins", "marketplace.json"),
    );
    assert.deepEqual(marketplace.plugins, [
      {
        name: "codeq8",
        source: {
          source: "local",
          path: "./.codex-runner/plugins/codeq8",
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

test("Codeq8 plugin install rejects non-public bundled skills before syncing", async () => {
  await withTempInstallRoot(async ({ tempRoot, codexHome, env }) => {
    const tempRepoRoot = path.join(tempRoot, "repo");
    const sourcePluginPath = path.join(
      tempRepoRoot,
      CODEQ8_PLUGIN_SOURCE_RELATIVE_PATH,
    );
    await fs.mkdir(path.dirname(sourcePluginPath), { recursive: true });
    await fs.cp(
      path.join(process.cwd(), CODEQ8_PLUGIN_SOURCE_RELATIVE_PATH),
      sourcePluginPath,
      { recursive: true },
    );
    const unexpectedSkillPath = path.join(
      sourcePluginPath,
      "skills",
      "codeq8-internal-product",
    );
    await fs.mkdir(unexpectedSkillPath, { recursive: true });
    await fs.writeFile(
      path.join(unexpectedSkillPath, "SKILL.md"),
      [
        "---",
        "name: codeq8-internal-product",
        "description: Internal product planning guidance.",
        "---",
        "",
        "# Internal Product",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await syncCodeq8PluginInstall({
      repoRoot: tempRepoRoot,
      env,
      sourceRef: "public-action-sha",
      now: FIXED_NOW,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "skipped");
    assert.equal(result.code, "invalid_source");
    assert.match(result.reason, /non-public bundled skills: codeq8-internal-product/);
    assert.deepEqual(result.capabilities, [CODEQ8_PLUGIN_CAPABILITY]);
    assert.equal(await pathExists(path.join(codexHome, "plugins", "codeq8")), false);
    for (const skillName of CODEQ8_PLUGIN_PUBLIC_SKILLS) {
      assert.equal(await pathExists(path.join(codexHome, "skills", skillName)), false);
    }
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
      path.join(codexHome, "plugins", "codeq8", CODEQ8_PLUGIN_MARKER_FILE),
    );
    const pluginSkillMarker = await readJson(
      path.join(codexHome, "skills", "codeq8-plugin", CODEQ8_PLUGIN_MARKER_FILE),
    );
    const coordinatorSkillMarker = await readJson(
      path.join(codexHome, "skills", "codeq8-coordinator", CODEQ8_PLUGIN_MARKER_FILE),
    );
    const onboardingSkillMarker = await readJson(
      path.join(codexHome, "skills", "codeq8-onboarding", CODEQ8_PLUGIN_MARKER_FILE),
    );
    const marketplaceMarker = await readJson(
      path.join(homePath, ".agents", "plugins", CODEQ8_PLUGIN_MARKETPLACE_ENTRY_MARKER_FILE),
    );

    assert.equal(pluginMarker.source_ref, "public-action-sha-new");
    assert.equal(pluginSkillMarker.source_ref, "public-action-sha-new");
    assert.equal(coordinatorSkillMarker.source_ref, "public-action-sha-new");
    assert.equal(onboardingSkillMarker.source_ref, "public-action-sha-new");
    assert.equal(marketplaceMarker.source_ref, "public-action-sha-new");
  });
});

test("Codeq8 plugin install removes obsolete marked skills without touching user-owned skills", async () => {
  await withTempInstallRoot(async ({ codexHome, env }) => {
    const obsoleteSkillPaths = [];
    for (const obsoleteSkillName of OBSOLETE_CODEQ8_PLUGIN_SKILLS) {
      const obsoleteSkillPath = path.join(codexHome, "skills", obsoleteSkillName);
      obsoleteSkillPaths.push(obsoleteSkillPath);
      await fs.mkdir(obsoleteSkillPath, { recursive: true });
      await fs.writeFile(
        path.join(obsoleteSkillPath, "SKILL.md"),
        `# Old ${obsoleteSkillName} skill\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(obsoleteSkillPath, CODEQ8_PLUGIN_MARKER_FILE),
        `${JSON.stringify(
          {
            schema_version: 1,
            managed_by: "codeq8-plugin-installer",
            plugin_name: "codeq8",
            target_kind: "skill",
            target_name: obsoleteSkillName,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    }

    const userSkillPath = path.join(codexHome, "skills", "user-owned-skill");
    await fs.mkdir(userSkillPath, { recursive: true });
    await fs.writeFile(path.join(userSkillPath, "SKILL.md"), "# User skill\n", "utf8");

    const result = await syncCodeq8PluginInstall({
      repoRoot: process.cwd(),
      env,
      sourceRef: "public-action-sha",
      now: FIXED_NOW,
    });

    assert.equal(result.ok, true);
    for (const obsoleteSkillPath of obsoleteSkillPaths) {
      assert.equal(await pathExists(obsoleteSkillPath), false);
    }
    assert.equal(await fs.readFile(path.join(userSkillPath, "SKILL.md"), "utf8"), "# User skill\n");
    for (const obsoleteSkillName of OBSOLETE_CODEQ8_PLUGIN_SKILLS) {
      assert.equal(result.targets.includes(`removed-skill:${obsoleteSkillName}`), true);
    }
    assert.deepEqual(OBSOLETE_CODEQ8_PLUGIN_SKILLS, [
      "codeq8-child-threads",
      "codeq8-learn",
      "codeq8-lessons",
      "codeq8-skill-stewardship",
    ]);
  });
});

test("Codeq8 plugin install rejects an unmarked plugin directory collision", async () => {
  await withTempInstallRoot(async ({ homePath, codexHome, env }) => {
    const collisionPath = path.join(codexHome, "plugins", "codeq8");
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
    assert.deepEqual(result.capabilities, CODEQ8_PLUGIN_CAPABILITIES);
    assert.equal(
      await fs.readFile(path.join(collisionPath, "README.md"), "utf8"),
      "user-owned\n",
    );
    assert.equal(await pathExists(path.join(collisionPath, CODEQ8_PLUGIN_MARKER_FILE)), false);
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
    assert.equal(await pathExists(path.join(codexHome, "plugins", "codeq8")), false);
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
    assert.equal(await pathExists(path.join(codexHome, "plugins", "codeq8")), false);
    assert.equal(await pathExists(path.join(codexHome, "skills", "codeq8-plugin")), false);
  });
});

test("Codeq8 plugin install roots package metadata under resolved Codex home", async () => {
  await withTempInstallRoot(async ({ homePath, codexHome, env }) => {
    const paths = resolveCodeq8PluginInstallPaths({
      repoRoot: process.cwd(),
      env,
    });

    assert.equal(paths.pluginInstallPath, path.join(codexHome, "plugins", "codeq8"));
    assert.equal(
      buildMarketplaceSourcePath({
        marketplaceRootPath: homePath,
        pluginInstallPath: paths.pluginInstallPath,
      }),
      "./.codex-runner/plugins/codeq8",
    );
  });
});

test("Codeq8 plugin install defaults package metadata to HOME .codex plugins", async () => {
  await withTempInstallRoot(async ({ homePath }) => {
    const paths = resolveCodeq8PluginInstallPaths({
      repoRoot: process.cwd(),
      env: {
        HOME: homePath,
      },
    });

    assert.equal(paths.codexHome, path.join(homePath, ".codex"));
    assert.equal(paths.pluginInstallPath, path.join(homePath, ".codex", "plugins", "codeq8"));
    assert.equal(
      buildMarketplaceSourcePath({
        marketplaceRootPath: homePath,
        pluginInstallPath: paths.pluginInstallPath,
      }),
      "./.codex/plugins/codeq8",
    );
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

test("Codeq8 plugin manifest bundles Playwright MCP without raw secrets", async () => {
  const pluginRoot = path.join(process.cwd(), CODEQ8_PLUGIN_SOURCE_RELATIVE_PATH);
  const manifest = await readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
  const mcpConfig = await readJson(path.join(pluginRoot, ".mcp.json"));
  const mcpConfigSource = await fs.readFile(path.join(pluginRoot, ".mcp.json"), "utf8");

  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(mcpConfig.playwright.command, "playwright-mcp");
  assert.doesNotMatch(JSON.stringify(mcpConfig.playwright.args), /@playwright\/mcp|npx|latest/);
  assert.match(JSON.stringify(mcpConfig.playwright.args), /playwright-mcp-auth-init\.ts/);
  assert.match(JSON.stringify(mcpConfig.playwright.args), /--headless/);
  assert.match(JSON.stringify(mcpConfig.playwright.args), /--isolated/);
  assert.equal(Array.isArray(mcpConfig.playwright.env_vars), true);
  assert.equal(
    mcpConfig.playwright.env_vars.includes("CODEQ8_TRIGGERING_GITHUB_WEB_SESSION_COOKIE"),
    true,
  );
  assert.equal(mcpConfig.playwright.env_vars.includes("CODE_WEB_CHAT_RUN_TOKEN"), true);
  assert.equal(mcpConfig.playwright.env_vars.includes("CODE_WORKSPACE_REPOSITORY"), true);
  assert.equal(mcpConfig.playwright.env_vars.includes("CODE_CHAT_THREAD_ID"), true);
  assert.equal(mcpConfig.playwright.env_vars.includes("CODE_CHAT_RUN_ID"), true);
  assert.equal(mcpConfig.playwright.env_vars.includes("PLAYWRIGHT_BROWSERS_PATH"), true);
  assert.equal(mcpConfigSource.includes("code_github_session="), false);
  assert.doesNotMatch(mcpConfigSource, /^\s*"env"\s*:/m);
  assert.doesNotMatch(mcpConfigSource, /^\s*"CODEQ8_TRIGGERING_GITHUB_WEB_SESSION_COOKIE"\s*:/m);
  assert.doesNotMatch(mcpConfigSource, /^\s*"CODE_WEB_CHAT_RUN_TOKEN"\s*:/m);
});

test("Codeq8 plugin install source does not mutate CODEX_HOME or Codex auth state", async () => {
  const actionSource = await fs.readFile(path.join(process.cwd(), "action.yml"), "utf8");
  const installerSource = await fs.readFile(
    path.join(process.cwd(), "scripts", "install-codeq8-plugin.mjs"),
    "utf8",
  );

  assert.doesNotMatch(actionSource, /CODEX_HOME=/);
  assert.doesNotMatch(installerSource, /process\.env\.CODEX_HOME\s*=/);
  assert.doesNotMatch(installerSource, /path\.join\(homePath,\s*"plugins"/);
  assert.doesNotMatch(installerSource, /\.\/plugins\/codeq8/);
  assert.doesNotMatch(installerSource, /auth\.json|config\.toml|sessions/);
});

test("Codeq8 plugin bundles onboarding and coordinator runtime skills", async () => {
  const skillsRoot = path.join(process.cwd(), "plugins", "codeq8", "skills");
  const bundledSkillNames = (
    await fs.readdir(skillsRoot, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(bundledSkillNames, CODEQ8_PLUGIN_PUBLIC_SKILLS);
  assert.equal(bundledSkillNames.includes("codeq8-learn"), false);
});

test("Codeq8 plugin run-behavior skills preserve the migration contract", async () => {
  const pluginRoot = path.join(process.cwd(), "plugins", "codeq8");
  const readSkill = (skillName) =>
    fs.readFile(path.join(pluginRoot, "skills", skillName, "SKILL.md"), "utf8");
  const onboardingSource = await readSkill("codeq8-onboarding");
  const coordinatorSource = await readSkill("codeq8-coordinator");
  const pluginSource = await readSkill("codeq8-plugin");
  const readmeSource = await fs.readFile(path.join(pluginRoot, "README.md"), "utf8");

  assert.match(onboardingSource, /^name: codeq8-onboarding$/m);
  assert.match(onboardingSource, /first-pass router/);
  assert.match(onboardingSource, /runner\s+prompt owns runtime facts and safety policy/);
  assert.match(onboardingSource, /Maintain durable thread goals/);
  assert.match(onboardingSource, /set, update, or\s+clear the thread goal/);
  assert.match(onboardingSource, /individual commands, checklists, PR mechanics, or transient status/);
  assert.match(onboardingSource, /Carry a goal-linked owner skill/);
  assert.match(onboardingSource, /identify the repo skill that should guide future runs before\s+answering or implementing/);
  assert.match(onboardingSource, /If it exists, read and use it/);
  assert.match(onboardingSource, /create a focused owner skill in\s+the same branch/);
  assert.match(onboardingSource, /Anchor the durable goal to the relevant skill name or path/);
  assert.match(onboardingSource, /treating skills as optional/);
  assert.match(onboardingSource, /Keep owner skills current/);
  assert.match(onboardingSource, /repo-owned `\.codex\/skills` as durable\s+operating context that Codex owns/);
  assert.match(onboardingSource, /not as a user-facing\s+feature the user must ask about/);
  assert.match(onboardingSource, /During analysis, implementation,\s+validation, and handoff/);
  assert.match(onboardingSource, /update, split, retire, or validate skills/);
  assert.match(onboardingSource, /reusable debugging fields, project procedures, stale\s+guidance, user corrections, repeated failures, CI\/staging\/runtime lessons,\s+or recurring workflows/);
  assert.match(onboardingSource, /request to diagnose, explain, or avoid product\s+code does not by itself forbid skill upkeep/);
  assert.match(onboardingSource, /forbid all file changes, PRs, or skill updates/);
  assert.match(onboardingSource, /Prefer\s+updating an\s+existing owner skill before creating a new one/);
  assert.match(onboardingSource, /executable checklist, routing rule,\s+validation\s+pattern, or reusable boundary/);
  assert.match(onboardingSource, /deterministic validator, test, source contract, operator guard, or docs\s+update/);
  assert.match(onboardingSource, /hidden branch or\s+standalone skill-management PR/);
  assert.doesNotMatch(onboardingSource, /route to\s+`codeq8-learn`/);
  assert.doesNotMatch(onboardingSource, /Run the active learning pass/);
  assert.doesNotMatch(onboardingSource, /Codeq8 Repo Learning Sweep/);
  assert.match(onboardingSource, /Do not turn onboarding into a second harness/);
  assert.match(onboardingSource, /Do not use goals or skills as blind memory/);
  assert.match(onboardingSource, /Do not create low-quality skills for one-off facts/);

  assert.match(coordinatorSource, /^name: codeq8-coordinator$/m);
  assert.match(coordinatorSource, /normal managed threads/);
  assert.match(coordinatorSource, /Handoff artifact:/);
  assert.match(coordinatorSource, /Archive only exact implementation, verification, or smoke threads/);
  assert.match(coordinatorSource, /Do not introduce a parent\/child\s+conversation hierarchy/);

  assert.doesNotMatch(pluginSource, /Child Threads runtime coordination skill/);
  assert.doesNotMatch(readmeSource, /codeq8-skill-stewardship|codeq8-learn|Child Threads runtime/i);
  assert.match(readmeSource, /durable goal\s+maintenance/);
  assert.match(readmeSource, /goal-like repo skill\s+management/);

  for (const source of [onboardingSource, coordinatorSource, pluginSource, readmeSource]) {
    assert.doesNotMatch(source, /Abdul|aalzanki/i);
    assert.doesNotMatch(source, /Codeq8\/Codeq8/);
    assert.doesNotMatch(source, /codeq8-learn|learning loop|learning sweep/i);
  }
});
