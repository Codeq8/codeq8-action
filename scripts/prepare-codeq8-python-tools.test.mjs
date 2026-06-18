import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEQ8_PYTHON_TOOLS_CAPABILITY,
  prepareCodeq8PythonTools,
} from "./prepare-codeq8-python-tools.mjs";

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function writeFixtureFile(filePath, contents = "") {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

async function writeExecutable(filePath, contents = "#!/bin/sh\nexit 0\n") {
  await writeFixtureFile(filePath, contents);
  await fs.chmod(filePath, 0o755);
}

async function withPythonToolsFixture(fn) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-python-tools-"));
  try {
    const repoRoot = path.join(tempRoot, "repo");
    const requirementsPath = path.join(repoRoot, "requirements", "codeq8-python-tools.txt");
    const homePath = path.join(tempRoot, "home");
    const markerFile = path.join(tempRoot, "python-tools.json");
    const githubPathFile = path.join(tempRoot, "github-path");
    const githubEnvFile = path.join(tempRoot, "github-env");
    const pythonPath = path.join(tempRoot, "bin", "python3");
    const venvDirectory = path.join(tempRoot, "venv");
    await writeFixtureFile(requirementsPath, "PyYAML==6.0.3\n");
    await fs.mkdir(homePath, { recursive: true });
    await writeExecutable(pythonPath);

    const calls = [];
    const runCommandImpl = async ({ command, args }) => {
      calls.push({ command, args: [...args] });
      if (command === "/bin/bash" && args.join(" ") === "-lc command -v python3") {
        return { ok: true, code: 0, stdout: `${pythonPath}\n`, stderr: "" };
      }
      if (command === pythonPath && args[0] === "-c") {
        return { ok: true, code: 0, stdout: "3.12.1\n", stderr: "" };
      }
      if (command === pythonPath && args.join(" ") === `-m venv ${venvDirectory}`) {
        await writeExecutable(path.join(venvDirectory, "bin", "python3"));
        return { ok: true, code: 0, stdout: "", stderr: "" };
      }
      if (command === path.join(venvDirectory, "bin", "python3")) {
        if (!(await pathExists(command))) {
          return { ok: false, code: 1, stdout: "", stderr: "missing venv" };
        }
        if (args[0] === "-c" && args[1]?.includes("import yaml")) {
          return { ok: true, code: 0, stdout: "6.0.3\n", stderr: "" };
        }
        if (args.slice(0, 3).join(" ") === "-m pip install") {
          return { ok: true, code: 0, stdout: "installed\n", stderr: "" };
        }
      }
      return { ok: false, code: 1, stdout: "", stderr: "unexpected command" };
    };

    await fn({
      tempRoot,
      repoRoot,
      requirementsPath,
      requirementsHash: crypto
        .createHash("sha256")
        .update(await fs.readFile(requirementsPath))
        .digest("hex"),
      homePath,
      markerFile,
      githubPathFile,
      githubEnvFile,
      pythonPath,
      venvDirectory,
      calls,
      runCommandImpl,
      env: {
        ...process.env,
        HOME: homePath,
        GITHUB_PATH: githubPathFile,
        GITHUB_ENV: githubEnvFile,
      },
    });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test("prepareCodeq8PythonTools creates an isolated venv and exposes it to GitHub PATH", async () => {
  await withPythonToolsFixture(async ({
    repoRoot,
    markerFile,
    requirementsPath,
    githubPathFile,
    githubEnvFile,
    pythonPath,
    venvDirectory,
    calls,
    runCommandImpl,
    env,
  }) => {
    const result = await prepareCodeq8PythonTools({
      repoRoot,
      markerFile,
      requirementsPath,
      venvDirectory,
      env,
      runCommandImpl,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "prepared");
    assert.equal(result.capability, CODEQ8_PYTHON_TOOLS_CAPABILITY);
    assert.equal(result.yamlVersion, "6.0.3");
    assert.equal(
      calls.some((call) => call.command === pythonPath && call.args.includes("pip")),
      false,
    );
    assert.equal(
      calls.some(
        (call) =>
          call.command === path.join(venvDirectory, "bin", "python3") &&
          call.args.join(" ").includes("-m pip install"),
      ),
      true,
    );
    assert.match(await fs.readFile(githubPathFile, "utf8"), new RegExp(`${venvDirectory}/bin`));
    assert.match(await fs.readFile(githubEnvFile, "utf8"), /CODEQ8_PYTHON_TOOLS_BIN=/);
  });
});

test("prepareCodeq8PythonTools reuses a valid stamped venv", async () => {
  await withPythonToolsFixture(async ({
    repoRoot,
    markerFile,
    requirementsPath,
    requirementsHash,
    githubPathFile,
    venvDirectory,
    calls,
    runCommandImpl,
    env,
  }) => {
    await writeExecutable(path.join(venvDirectory, "bin", "python3"));
    await writeFixtureFile(
      markerFile,
      `${JSON.stringify(
        {
          managed_by: "codeq8-python-tools-prep",
          capability: CODEQ8_PYTHON_TOOLS_CAPABILITY,
          python_version: "3.12.1",
          requirements_hash: requirementsHash,
          venv_directory: venvDirectory,
        },
        null,
        2,
      )}\n`,
    );

    const result = await prepareCodeq8PythonTools({
      repoRoot,
      markerFile,
      requirementsPath,
      venvDirectory,
      env,
      runCommandImpl,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "already-prepared");
    assert.equal(
      calls.some((call) => call.args.join(" ").includes("-m pip install")),
      false,
    );
    assert.match(await fs.readFile(githubPathFile, "utf8"), new RegExp(`${venvDirectory}/bin`));
  });
});

test("prepareCodeq8PythonTools degrades when python3 is unavailable", async () => {
  await withPythonToolsFixture(async ({
    repoRoot,
    markerFile,
    requirementsPath,
    githubPathFile,
    githubEnvFile,
    venvDirectory,
    env,
  }) => {
    const result = await prepareCodeq8PythonTools({
      repoRoot,
      markerFile,
      requirementsPath,
      venvDirectory,
      env,
      runCommandImpl: async () => ({
        ok: false,
        code: 1,
        stdout: "",
        stderr: "python missing",
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "unavailable");
    assert.equal(result.code, "python3_missing");
    assert.equal(await pathExists(githubPathFile), false);
    assert.equal(await pathExists(githubEnvFile), false);
  });
});

test("action bootstrap prepares Python tools before starting Codex", async () => {
  const actionSource = await fs.readFile(path.join(process.cwd(), "action.yml"), "utf8");
  const pythonPrepIndex = actionSource.indexOf("scripts/prepare-codeq8-python-tools.mjs");
  const bridgeIndex = actionSource.indexOf("scripts/github-actions-web-chat-runner-bridge.mjs");

  assert.notEqual(pythonPrepIndex, -1);
  assert.notEqual(bridgeIndex, -1);
  assert.equal(pythonPrepIndex < bridgeIndex, true);
});
