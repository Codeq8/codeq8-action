import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findBrokenRemoteTrackingRefs,
  isRecoverableWorkspaceRefRefreshFailure,
  refreshWorkspaceRemoteRefs,
} from "./web-chat-runner.mjs";

test("isRecoverableWorkspaceRefRefreshFailure only degrades local ref corruption failures", () => {
  assert.equal(
    isRecoverableWorkspaceRefRefreshFailure(
      "error: Could not read 3395730721d58f2bd30c4e7b7639f32ed39e2b51\nerror: could not parse commit 3395730721d58f2bd30c4e7b7639f32ed39e2b51",
    ),
    true,
  );
  assert.equal(
    isRecoverableWorkspaceRefRefreshFailure(
      "fatal: bad object refs/remotes/origin/main\nerror: origin did not send all necessary objects",
    ),
    true,
  );
  assert.equal(
    isRecoverableWorkspaceRefRefreshFailure("fatal: Authentication failed for https://github.com"),
    false,
  );
});

test("findBrokenRemoteTrackingRefs lists remote refs whose objects are missing locally", async () => {
  const missingObjectId = "a".repeat(40);
  const healthyObjectId = "b".repeat(40);
  const commands = [];
  const brokenRefs = await findBrokenRemoteTrackingRefs({
    workspacePath: "/tmp/workspace",
    commandEnv: {},
    runProcessCaptureImpl: async (_command, args) => {
      commands.push(args);
      if (args[0] === "for-each-ref") {
        return {
          ok: true,
          stdout: [
            `refs/remotes/origin/main ${missingObjectId}`,
            `refs/remotes/origin/feature ${healthyObjectId}`,
          ].join("\n"),
          stderr: "",
        };
      }
      if (args[0] === "cat-file" && args[2] === missingObjectId) {
        return { ok: false, stdout: "", stderr: "missing" };
      }
      if (args[0] === "cat-file" && args[2] === healthyObjectId) {
        return { ok: true, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git invocation: ${args.join(" ")}`);
    },
  });

  assert.deepEqual(brokenRefs, [
    {
      refName: "refs/remotes/origin/main",
      objectId: missingObjectId,
    },
  ]);
  assert.deepEqual(
    commands.map((args) => args.join(" ")),
    [
      "for-each-ref --format=%(refname) %(objectname) refs/remotes/origin",
      `cat-file -e ${missingObjectId}`,
      `cat-file -e ${healthyObjectId}`,
    ],
  );
});

test("refreshWorkspaceRemoteRefs deletes broken origin refs and retries the fetch once", async () => {
  const missingObjectId = "a".repeat(40);
  const healthyObjectId = "b".repeat(40);
  const invocations = [];
  let fetchAttempts = 0;

  const refreshed = await refreshWorkspaceRemoteRefs({
    workspacePath: "/tmp/workspace",
    commandEnv: {},
    runProcessCaptureImpl: async (_command, args) => {
      invocations.push(args);
      if (args[0] === "fetch") {
        fetchAttempts += 1;
        if (fetchAttempts === 1) {
          return {
            ok: false,
            stdout: "",
            stderr: [
              `error: Could not read ${missingObjectId}`,
              `error: could not parse commit ${missingObjectId}`,
            ].join("\n"),
          };
        }
        return { ok: true, stdout: "", stderr: "" };
      }
      if (args[0] === "for-each-ref") {
        return {
          ok: true,
          stdout: [
            `refs/remotes/origin/main ${missingObjectId}`,
            `refs/remotes/origin/feature ${healthyObjectId}`,
          ].join("\n"),
          stderr: "",
        };
      }
      if (args[0] === "cat-file" && args[2] === missingObjectId) {
        return { ok: false, stdout: "", stderr: "missing" };
      }
      if (args[0] === "cat-file" && args[2] === healthyObjectId) {
        return { ok: true, stdout: "", stderr: "" };
      }
      if (args[0] === "update-ref") {
        return { ok: true, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git invocation: ${args.join(" ")}`);
    },
  });

  assert.deepEqual(refreshed, {
    ok: true,
    recovered: true,
    degraded: false,
    brokenRefsRemoved: ["refs/remotes/origin/main"],
    shallowBoundaryCommitsAdded: [],
    error: "",
  });
  assert.deepEqual(
    invocations.map((args) => args.join(" ")),
    [
      "fetch --prune origin",
      "for-each-ref --format=%(refname) %(objectname) refs/remotes/origin",
      `cat-file -e ${missingObjectId}`,
      `cat-file -e ${healthyObjectId}`,
      "update-ref -d refs/remotes/origin/main",
      "fetch --prune origin",
    ],
  );
});

test("refreshWorkspaceRemoteRefs repairs missing shallow boundaries and retries the fetch once", async (t) => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "codeq8-action-refresh-shallow-"));
  const gitDirectoryPath = path.join(workspacePath, ".git");
  const existingBoundaryCommit = "a".repeat(40);
  const missingBoundaryCommit = "b".repeat(40);
  const missingParentCommit = "c".repeat(40);
  const invocations = [];
  let fetchAttempts = 0;

  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  await mkdir(gitDirectoryPath, { recursive: true });
  await writeFile(path.join(gitDirectoryPath, "shallow"), `${existingBoundaryCommit}\n`, "utf8");

  const refreshed = await refreshWorkspaceRemoteRefs({
    workspacePath,
    commandEnv: {},
    runProcessCaptureImpl: async (_command, args) => {
      invocations.push(args);
      if (args[0] === "fetch") {
        fetchAttempts += 1;
        if (fetchAttempts === 1) {
          return {
            ok: false,
            stdout: "",
            stderr: [
              `error: Could not read ${missingBoundaryCommit}`,
              `error: could not parse commit ${missingBoundaryCommit}`,
            ].join("\n"),
          };
        }
        return { ok: true, stdout: "", stderr: "" };
      }
      if (args[0] === "fsck") {
        return {
          ok: false,
          stdout: "",
          stderr: [
            `broken link from  commit ${missingBoundaryCommit}`,
            `              to  commit ${missingParentCommit}`,
            `missing commit ${missingParentCommit}`,
          ].join("\n"),
        };
      }
      if (args[0] === "cat-file" && args[1] === "-t" && args[2] === missingBoundaryCommit) {
        return { ok: true, stdout: "commit\n", stderr: "" };
      }
      throw new Error(`Unexpected git invocation: ${args.join(" ")}`);
    },
  });

  assert.deepEqual(refreshed, {
    ok: true,
    recovered: true,
    degraded: false,
    brokenRefsRemoved: [],
    shallowBoundaryCommitsAdded: [missingBoundaryCommit],
    error: "",
  });
  assert.equal(
    await readFile(path.join(gitDirectoryPath, "shallow"), "utf8"),
    `${existingBoundaryCommit}\n${missingBoundaryCommit}\n`,
  );
  assert.deepEqual(
    invocations.map((args) => args.join(" ")),
    [
      "fetch --prune origin",
      "fsck --full --no-dangling",
      `cat-file -t ${missingBoundaryCommit}`,
      "fetch --prune origin",
    ],
  );
});

test("refreshWorkspaceRemoteRefs degrades recoverable ref corruption when broad fetch still fails", async () => {
  const missingObjectId = "a".repeat(40);
  let fetchAttempts = 0;

  const refreshed = await refreshWorkspaceRemoteRefs({
    workspacePath: "/tmp/workspace",
    commandEnv: {},
    runProcessCaptureImpl: async (_command, args) => {
      if (args[0] === "fetch") {
        fetchAttempts += 1;
        return {
          ok: false,
          stdout: "",
          stderr:
            fetchAttempts === 1
              ? `error: Could not read ${missingObjectId}\nerror: could not parse commit ${missingObjectId}`
              : `fatal: bad object refs/remotes/origin/main\nerror: origin did not send all necessary objects`,
        };
      }
      if (args[0] === "for-each-ref") {
        return {
          ok: true,
          stdout: `refs/remotes/origin/main ${missingObjectId}`,
          stderr: "",
        };
      }
      if (args[0] === "cat-file") {
        return { ok: false, stdout: "", stderr: "missing" };
      }
      if (args[0] === "update-ref") {
        return { ok: true, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git invocation: ${args.join(" ")}`);
    },
  });

  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.recovered, false);
  assert.equal(refreshed.degraded, true);
  assert.deepEqual(refreshed.brokenRefsRemoved, ["refs/remotes/origin/main"]);
  assert.deepEqual(refreshed.shallowBoundaryCommitsAdded, []);
  assert.match(refreshed.error, /did not send all necessary objects/i);
});
