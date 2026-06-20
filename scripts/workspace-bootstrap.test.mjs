import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadWorkspaceCodeq8Config,
  readBootstrapInstallCommands,
} from "../lib/workspace-bootstrap.mjs";

test("workspace bootstrap treats missing codeq8.json as empty config", async () => {
  const workspacePath = await fs.mkdtemp(
    path.join(os.tmpdir(), "codeq8-action-bootstrap-missing-config-"),
  );
  try {
    const config = await loadWorkspaceCodeq8Config(workspacePath);
    assert.equal(config.version, 1);
    assert.deepEqual(readBootstrapInstallCommands(config), []);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test("workspace bootstrap still rejects invalid present codeq8.json", async () => {
  const workspacePath = await fs.mkdtemp(
    path.join(os.tmpdir(), "codeq8-action-bootstrap-invalid-config-"),
  );
  try {
    await fs.writeFile(path.join(workspacePath, "codeq8.json"), "{ nope\n");
    await assert.rejects(
      () => loadWorkspaceCodeq8Config(workspacePath),
      /Invalid codeq8\.json:/,
    );
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});
