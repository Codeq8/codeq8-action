import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  codeq8ActionRuntimeNeedsInstall,
  ensureCodeq8ActionRuntime,
} from "./ensure-codeq8-action-runtime.mjs";

function resolveNpmPath() {
  const result = spawnSync("sh", ["-lc", "command -v npm"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const npmPath = String(result.stdout || "").trim();
  assert.ok(npmPath, "Expected npm to be available for action-runtime tests.");
  return npmPath;
}

async function createActionRuntimeFixture() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-action-runtime-"));
  await fs.writeFile(
    path.join(repoRoot, "package.json"),
    JSON.stringify(
      {
        name: "codeq8-action-runtime-fixture",
        private: true,
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(repoRoot, "package-lock.json"),
    JSON.stringify(
      {
        name: "codeq8-action-runtime-fixture",
        lockfileVersion: 3,
      },
      null,
      2,
    ),
    "utf8",
  );
  return repoRoot;
}

test("ensureCodeq8ActionRuntime installs and stamps the action runtime once", async () => {
  const repoRoot = await createActionRuntimeFixture();
  let installCalls = 0;

  const firstResult = await ensureCodeq8ActionRuntime({
    repoRoot,
    nodePath: process.execPath,
    npmPath: resolveNpmPath(),
    runInstallImpl: async ({ repoRoot: installRepoRoot }) => {
      installCalls += 1;
      await fs.mkdir(path.join(installRepoRoot, "node_modules"), { recursive: true });
      await fs.writeFile(
        path.join(installRepoRoot, "node_modules", ".prepared"),
        "ok\n",
        "utf8",
      );
    },
  });

  assert.equal(firstResult.installed, true);
  assert.equal(installCalls, 1);
  assert.match(firstResult.stamp, /^\d+\.\d+\.\d+:/);
  assert.equal(
    await codeq8ActionRuntimeNeedsInstall({
      repoRoot,
      expectedStamp: firstResult.stamp,
    }),
    false,
  );

  const secondResult = await ensureCodeq8ActionRuntime({
    repoRoot,
    nodePath: process.execPath,
    npmPath: resolveNpmPath(),
    runInstallImpl: async () => {
      installCalls += 1;
    },
  });

  assert.equal(secondResult.installed, false);
  assert.equal(installCalls, 1);
});

test("ensureCodeq8ActionRuntime reinstalls when the action lockfile changes", async () => {
  const repoRoot = await createActionRuntimeFixture();
  let installCalls = 0;

  await ensureCodeq8ActionRuntime({
    repoRoot,
    nodePath: process.execPath,
    npmPath: resolveNpmPath(),
    runInstallImpl: async ({ repoRoot: installRepoRoot }) => {
      installCalls += 1;
      await fs.mkdir(path.join(installRepoRoot, "node_modules"), { recursive: true });
      await fs.writeFile(
        path.join(installRepoRoot, "node_modules", ".prepared"),
        "ok\n",
        "utf8",
      );
    },
  });

  await fs.writeFile(
    path.join(repoRoot, "package-lock.json"),
    JSON.stringify(
      {
        name: "codeq8-action-runtime-fixture",
        lockfileVersion: 3,
        packages: {
          "": {
            dependencies: {
              zod: "^4.3.6",
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const result = await ensureCodeq8ActionRuntime({
    repoRoot,
    nodePath: process.execPath,
    npmPath: resolveNpmPath(),
    runInstallImpl: async ({ repoRoot: installRepoRoot }) => {
      installCalls += 1;
      await fs.mkdir(path.join(installRepoRoot, "node_modules"), { recursive: true });
      await fs.writeFile(
        path.join(installRepoRoot, "node_modules", ".prepared"),
        "updated\n",
        "utf8",
      );
    },
  });

  assert.equal(result.installed, true);
  assert.equal(installCalls, 2);
});
