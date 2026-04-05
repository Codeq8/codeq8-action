import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCodexPrompt,
  buildResumePrompt,
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

test("buildCodexPrompt keeps single-pass work as the default but allows explicit loop-style runs", () => {
  const prompt = buildCodexPrompt({
    repository: "Codeq8/Codeq8",
    threadTitle: "Fix the runner",
    threadId: "wct_123",
    sourceType: "default_branch",
    branchContext: {
      context_branch: "main",
      write_mode: "branch_and_pr",
      write_branch: "",
      base_branch: "main",
      default_branch: "main",
      protected_branches: ["main"],
    },
    workspacePersistenceState: {
      branch: "main",
      hasWorkingTreeChanges: false,
      hasRemoteBranch: true,
      aheadCount: 0,
    },
    priorMessages: [],
    promptText: "fix it",
    codeq8Cli: { available: false },
  });

  assert.match(
    prompt,
    /By default, handle the current user request as a normal single-pass run; do not turn it into open-ended loop-style work unless the user clearly asks for that\./,
  );
  assert.match(
    prompt,
    /If the user clearly asks for loop-style or iterative work, you may stay in this run and work through multiple cycles of changes, commits, pushes, checks, and follow-up fixes when that matches the request\./,
  );
  assert.match(
    prompt,
    /Do the work on that branch and push it at the checkpoints that make sense for the user's request, and before you finish, so the runner can remember it for this thread and open or update the PR\./,
  );
  assert.match(
    prompt,
    /create normal git commits with concise human-readable subjects at the checkpoints that make sense for the user's request, and make sure kept work is committed before you finish\./,
  );
});

test("buildResumePrompt carries the loop-style guidance into resumed runs", () => {
  const prompt = buildResumePrompt({
    repository: "Codeq8/Codeq8",
    sourceType: "pull_request",
    branchContext: {
      context_branch: "feature/test",
      write_mode: "direct_push",
      write_branch: "feature/test",
      base_branch: "main",
      default_branch: "main",
      pull_request_number: 42,
      pull_request_head_branch: "feature/test",
      pull_request_base_branch: "main",
    },
    workspacePersistenceState: {
      branch: "feature/test",
      hasWorkingTreeChanges: false,
      hasRemoteBranch: true,
      aheadCount: 0,
    },
    promptText: "keep going",
  });

  assert.match(
    prompt,
    /By default, handle the current user request as a normal single-pass run; do not turn it into open-ended loop-style work unless the user clearly asks for that\./,
  );
  assert.match(
    prompt,
    /Do not treat requested loop-style work as permission to create a background or automatically resumed workflow across turns; keep the work bounded to this run unless the user asks again later\./,
  );
  assert.match(
    prompt,
    /If you make repo changes that should be kept, you are responsible for committing and pushing them at the checkpoints that make sense for the user's request, and before you finish\./,
  );
});
