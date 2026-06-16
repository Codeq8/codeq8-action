import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureRunnerGlobalCliTools } from "./runner-global-cli-tools.mjs";

const TOOL_VERSIONS = {
  "@openai/codex": "0.140.0",
  "@codeq8/codeq8": "0.2.1",
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
    for (const binaryName of ["codex", "codeq8", "playwright-mcp"]) {
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
        PATH: `${binPath}:${process.env.PATH || ""}`,
      },
    });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function writeState(stateFile, toolVersions = TOOL_VERSIONS) {
  await fs.writeFile(
    stateFile,
    `${JSON.stringify(
      {
        last_success_at: 1,
        tool_versions: toolVersions,
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
      /Unable to install required global CLI tools.*registry unavailable/,
    );
  });
});
