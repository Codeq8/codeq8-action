import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureRunnerGlobalCliTools } from "./runner-global-cli-tools.mjs";

const TOOL_VERSIONS = {
  "@codeq8/codeq8": "0.2.6",
  "@playwright/mcp": "0.0.76",
};

async function writeExecutable(filePath, source) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, source, "utf8");
  await fs.chmod(filePath, 0o755);
}

async function withGlobalToolFixture(fn) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-global-tools-"));
  try {
    const binPath = path.join(tempRoot, "bin");
    const homePath = path.join(tempRoot, "home");
    const stateFile = path.join(tempRoot, "state.json");
    const npmPath = path.join(tempRoot, "npm");
    for (const binaryName of ["codeq8", "playwright-mcp"]) {
      await writeExecutable(path.join(binPath, binaryName), "#!/bin/sh\nexit 0\n");
    }
    await fs.mkdir(homePath, { recursive: true });
    await fn({
      tempRoot,
      binPath,
      homePath,
      stateFile,
      npmPath,
      env: {
        ...process.env,
        HOME: homePath,
        NPM_CONFIG_PREFIX: tempRoot,
        PATH: `${binPath}:${process.env.PATH || ""}`,
      },
    });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
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

async function readLocalPackageFingerprint(cwd = process.cwd()) {
  const packagePath = path.join(cwd, "codeq8-cli");
  const files = await listFingerprintFiles(packagePath);
  const hash = crypto.createHash("sha256");
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await fs.readFile(path.join(packagePath, relativePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function writeState(stateFile, toolVersions = TOOL_VERSIONS, { cwd = process.cwd() } = {}) {
  await fs.writeFile(
    stateFile,
    `${JSON.stringify(
      {
        last_success_at: 1,
        tool_versions: toolVersions,
        local_package_fingerprints: {
          "@codeq8/codeq8": await readLocalPackageFingerprint(cwd),
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function writeMinimalActionPackages(rootPath) {
  const codeq8PackagePath = path.join(rootPath, "codeq8-cli");
  const playwrightPackagePath = path.join(rootPath, "playwright-mcp");
  await fs.mkdir(path.join(codeq8PackagePath, "bin"), { recursive: true });
  await fs.writeFile(
    path.join(codeq8PackagePath, "package.json"),
    `${JSON.stringify(
      {
        name: "@codeq8/codeq8",
        version: TOOL_VERSIONS["@codeq8/codeq8"],
        type: "module",
        bin: {
          codeq8: "bin/codeq8.js",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeExecutable(
    path.join(codeq8PackagePath, "bin", "codeq8.js"),
    [
      "#!/usr/bin/env node",
      "if (process.argv.slice(2).join(' ') === 'threads --help') {",
      "  process.stdout.write('Usage: codeq8 threads\\n');",
      "  process.exit(0);",
      "}",
      "process.stderr.write('unexpected args\\n');",
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  await fs.mkdir(playwrightPackagePath, { recursive: true });
  await fs.writeFile(
    path.join(playwrightPackagePath, "package.json"),
    `${JSON.stringify(
      {
        name: "@playwright/mcp",
        version: TOOL_VERSIONS["@playwright/mcp"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

test("runner global tools include the pinned Playwright MCP package", async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(process.cwd(), "playwright-mcp", "package.json"), "utf8"),
  );

  assert.equal(manifest.name, "@playwright/mcp");
  assert.equal(manifest.version, TOOL_VERSIONS["@playwright/mcp"]);
});

test("ensureRunnerGlobalCliTools refreshes when codeq8 resolves outside the managed npm prefix", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-global-tools-prefix-"));
  try {
    const managedPrefix = path.join(tempRoot, "managed");
    const managedBinPath = path.join(managedPrefix, "bin");
    const machineBinPath = path.join(tempRoot, "machine-bin");
    const homePath = path.join(tempRoot, "home");
    const stateFile = path.join(tempRoot, "state.json");
    const npmPath = path.join(tempRoot, "npm");
    const npmArgsFile = path.join(tempRoot, "npm-args");
    await fs.mkdir(homePath, { recursive: true });
    await writeExecutable(path.join(machineBinPath, "codeq8"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(path.join(managedBinPath, "playwright-mcp"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(
      npmPath,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" >> ${JSON.stringify(npmArgsFile)}`,
        "if [ \"$1\" = \"install\" ] && [ \"$2\" = \"--global\" ]; then",
        `  mkdir -p ${JSON.stringify(managedBinPath)}`,
        `  printf '#!/bin/sh\\nexit 0\\n' > ${JSON.stringify(path.join(managedBinPath, "codeq8"))}`,
        `  chmod +x ${JSON.stringify(path.join(managedBinPath, "codeq8"))}`,
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    await writeState(stateFile);

    const result = await ensureRunnerGlobalCliTools({
      stateFile,
      npmPath,
      env: {
        ...process.env,
        HOME: homePath,
        NPM_CONFIG_PREFIX: managedPrefix,
        PATH: `${managedBinPath}:${machineBinPath}:${process.env.PATH || ""}`,
      },
      cwd: process.cwd(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.refreshed, true);
    const codeq8Tool = result.tools.find((tool) => tool.packageName === "@codeq8/codeq8");
    assert.equal(codeq8Tool?.binaryPath, path.join(managedBinPath, "codeq8"));
    const npmArgs = await fs.readFile(npmArgsFile, "utf8");
    assert.match(npmArgs, /--global/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("ensureRunnerGlobalCliTools refreshes when managed codeq8 lacks threads support", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-global-tools-capability-"));
  try {
    const binPath = path.join(tempRoot, "bin");
    const homePath = path.join(tempRoot, "home");
    const stateFile = path.join(tempRoot, "state.json");
    const npmPath = path.join(tempRoot, "npm");
    const npmArgsFile = path.join(tempRoot, "npm-args");
    await fs.mkdir(homePath, { recursive: true });
    await writeExecutable(
      path.join(binPath, "codeq8"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"threads\" ]; then",
        "  echo 'codeq8: Unknown command: threads' >&2",
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    await writeExecutable(path.join(binPath, "playwright-mcp"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(
      npmPath,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" >> ${JSON.stringify(npmArgsFile)}`,
        "if [ \"$1\" = \"install\" ] && [ \"$2\" = \"--global\" ]; then",
        `  mkdir -p ${JSON.stringify(binPath)}`,
        `  printf '#!/bin/sh\\nexit 0\\n' > ${JSON.stringify(path.join(binPath, "codeq8"))}`,
        `  chmod +x ${JSON.stringify(path.join(binPath, "codeq8"))}`,
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    await writeState(stateFile);

    const result = await ensureRunnerGlobalCliTools({
      stateFile,
      npmPath,
      env: {
        ...process.env,
        HOME: homePath,
        NPM_CONFIG_PREFIX: tempRoot,
        PATH: `${binPath}:${process.env.PATH || ""}`,
      },
      cwd: process.cwd(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.refreshed, true);
    const codeq8Tool = result.tools.find((tool) => tool.packageName === "@codeq8/codeq8");
    assert.equal(codeq8Tool?.binaryPath, path.join(binPath, "codeq8"));
    const npmArgs = await fs.readFile(npmArgsFile, "utf8");
    assert.match(npmArgs, /uninstall/);
    assert.match(npmArgs, /--global/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("ensureRunnerGlobalCliTools repairs local package bins when npm global install omits them", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-global-tools-local-bin-"));
  try {
    const cwd = path.join(tempRoot, "action");
    const managedPrefix = path.join(tempRoot, "managed");
    const managedBinPath = path.join(managedPrefix, "bin");
    const homePath = path.join(tempRoot, "home");
    const stateFile = path.join(tempRoot, "state.json");
    const npmPath = path.join(tempRoot, "npm");
    const npmArgsFile = path.join(tempRoot, "npm-args");
    await fs.mkdir(homePath, { recursive: true });
    await writeMinimalActionPackages(cwd);
    await writeExecutable(
      npmPath,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" >> ${JSON.stringify(npmArgsFile)}`,
        "if [ \"$1\" = \"install\" ] && [ \"$2\" = \"--global\" ]; then",
        `  mkdir -p ${JSON.stringify(managedBinPath)}`,
        `  printf '#!/bin/sh\\nexit 0\\n' > ${JSON.stringify(path.join(managedBinPath, "playwright-mcp"))}`,
        `  chmod +x ${JSON.stringify(path.join(managedBinPath, "playwright-mcp"))}`,
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      stateFile,
      `${JSON.stringify(
        {
          last_success_at: 1,
          tool_versions: TOOL_VERSIONS,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await ensureRunnerGlobalCliTools({
      stateFile,
      npmPath,
      env: {
        ...process.env,
        HOME: homePath,
        NPM_CONFIG_PREFIX: managedPrefix,
        PATH: `${managedBinPath}:${process.env.PATH || ""}`,
      },
      cwd,
    });

    assert.equal(result.ok, true);
    assert.equal(result.refreshed, true);
    const codeq8Tool = result.tools.find((tool) => tool.packageName === "@codeq8/codeq8");
    assert.equal(codeq8Tool?.binaryPath, path.join(managedBinPath, "codeq8"));
    const codeq8Shim = await fs.readFile(path.join(managedBinPath, "codeq8"), "utf8");
    assert.match(codeq8Shim, /exec node /);
    assert.match(codeq8Shim, /codeq8\.js/);
    const nextState = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.equal(
      typeof nextState.local_package_fingerprints["@codeq8/codeq8"],
      "string",
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("runner global tools do not install or pin Codex", async () => {
  await withGlobalToolFixture(async ({ stateFile, npmPath, env }) => {
    const npmArgsFile = path.join(path.dirname(npmPath), "npm-args");
    await writeExecutable(
      npmPath,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(npmArgsFile)}\nexit 0\n`,
    );
    await writeState(stateFile, {
      ...TOOL_VERSIONS,
      "@playwright/mcp": "0.0.1",
    });

    const result = await ensureRunnerGlobalCliTools({
      stateFile,
      npmPath,
      env,
      cwd: process.cwd(),
    });

    assert.equal(result.ok, true);
    assert.equal(
      result.tools.some((tool) => tool.packageName === "@openai/codex"),
      false,
    );
    const npmArgs = await fs.readFile(npmArgsFile, "utf8");
    assert.equal(npmArgs.includes("@openai/codex"), false);
    const nextState = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.equal(Object.hasOwn(nextState.tool_versions, "@openai/codex"), false);
  });
});

test("ensureRunnerGlobalCliTools skips npm install when binaries and pinned versions match", async () => {
  await withGlobalToolFixture(async ({ stateFile, npmPath, env }) => {
    const npmInvocationFile = path.join(path.dirname(npmPath), "npm-invoked");
    await writeExecutable(
      npmPath,
      `#!/bin/sh\ntouch ${JSON.stringify(npmInvocationFile)}\nexit 0\n`,
    );
    await writeState(stateFile);

    const result = await ensureRunnerGlobalCliTools({
      stateFile,
      npmPath,
      env,
      cwd: process.cwd(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.refreshed, false);
    assert.match(result.reason, /pinned versions match/);
    await assert.rejects(fs.access(npmInvocationFile));
    assert.equal(
      result.tools.some((tool) => tool.packageName === "@playwright/mcp"),
      true,
    );
  });
});

test("ensureRunnerGlobalCliTools refreshes when Playwright MCP pinned version changes", async () => {
  await withGlobalToolFixture(async ({ stateFile, npmPath, env }) => {
    const npmInvocationFile = path.join(path.dirname(npmPath), "npm-invoked");
    await writeExecutable(
      npmPath,
      `#!/bin/sh\ntouch ${JSON.stringify(npmInvocationFile)}\nexit 0\n`,
    );
    await writeState(stateFile, {
      ...TOOL_VERSIONS,
      "@playwright/mcp": "0.0.1",
    });

    const result = await ensureRunnerGlobalCliTools({
      stateFile,
      npmPath,
      env,
      cwd: process.cwd(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.refreshed, true);
    await fs.access(npmInvocationFile);
    const nextState = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.equal(nextState.tool_versions["@playwright/mcp"], "0.0.76");
  });
});

test("ensureRunnerGlobalCliTools fails hard when a required refresh fails", async () => {
  await withGlobalToolFixture(async ({ stateFile, npmPath, env }) => {
    await writeExecutable(npmPath, "#!/bin/sh\necho registry unavailable >&2\nexit 1\n");
    await writeState(stateFile, {
      ...TOOL_VERSIONS,
      "@playwright/mcp": "0.0.1",
    });

    await assert.rejects(
      ensureRunnerGlobalCliTools({
        stateFile,
        npmPath,
        env,
        cwd: process.cwd(),
      }),
      /Unable to install @codeq8\/codeq8 local package dependencies.*registry unavailable/,
    );
  });
});
