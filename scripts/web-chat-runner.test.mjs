import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCodexPrompt,
  buildPullRequestPresentation,
  buildResumePrompt,
} from "./web-chat-runner.mjs";

function git(workspacePath, args) {
  execFileSync("git", args, { cwd: workspacePath, env: process.env });
}

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
});

test("buildResumePrompt carries loop-style guidance into resumed runs", () => {
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
    /Do not treat requested loop-style work as permission to create a background or automatically resumed workflow across turns; keep the work bounded to this run unless the user asks again later\./,
  );
  assert.match(
    prompt,
    /If you make repo changes that should be kept, you are responsible for committing and pushing them at the checkpoints that make sense for the user's request, and before you finish\./,
  );
});

test("buildCodexPrompt renders thread specs above workspace state and out of the user message", () => {
  const threadSpecText = "1. Clean code\n2. Reduce complexity\n3. Reduce future bugs";
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
    threadSpecText,
    promptText: `Thread spec:\n${threadSpecText}\n\nhi`,
    codeq8Cli: { available: false },
  });

  assert.ok(prompt.indexOf("Thread spec:") < prompt.indexOf("Runner workspace state before this turn:"));
  assert.match(prompt, /Thread spec:\n1\. Clean code\n2\. Reduce complexity\n3\. Reduce future bugs/);
  assert.match(prompt, /User message:\nhi/);
  assert.doesNotMatch(prompt, /User message:\nThread spec:/);
});

test("buildResumePrompt renders thread specs above workspace state and out of the user message", () => {
  const threadSpecText = "Prefer the smallest viable diff.\nExplain tradeoffs briefly.";
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
    threadSpecText,
    promptText: `Thread spec:\n${threadSpecText}\n\nkeep going`,
  });

  assert.ok(prompt.indexOf("Thread spec:") < prompt.indexOf("Runner workspace state before this turn:"));
  assert.match(prompt, /User message:\nkeep going/);
  assert.doesNotMatch(prompt, /User message:\nThread spec:/);
});

test("buildPullRequestPresentation prefers the thread title and assistant summary", async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-pr-presentation-"));
  try {
    await fs.writeFile(path.join(workspacePath, "README.md"), "test\n");
    git(workspacePath, ["init", "-b", "main"]);
    git(workspacePath, ["config", "user.name", "Codeq8 Test"]);
    git(workspacePath, ["config", "user.email", "codeq8@example.com"]);
    git(workspacePath, ["add", "README.md"]);
    git(workspacePath, ["commit", "-m", "first commit"]);
    git(workspacePath, ["remote", "add", "origin", workspacePath]);
    git(workspacePath, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(workspacePath, ["checkout", "-b", "feature/thread-title"]);
    git(workspacePath, ["update-ref", "refs/remotes/origin/feature/thread-title", "HEAD"]);
    await fs.writeFile(path.join(workspacePath, "README.md"), "updated\n");
    git(workspacePath, ["add", "README.md"]);
    git(workspacePath, ["commit", "-m", "second commit", "-m", "commit body"]);

    const presentation = await buildPullRequestPresentation({
      workspacePath,
      commandEnv: process.env,
      branch: "feature/thread-title",
      baseBranch: "main",
      threadTitle: "Preserve loop state in thread registry",
      assistantMessage: "Implemented the thread-registry persistence fix.\n\nAdded tests too.",
    });

    assert.equal(presentation.title, "Preserve loop state in thread registry");
    assert.equal(
      presentation.body,
      "Implemented the thread-registry persistence fix.\n\nAdded tests too.",
    );
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test("buildPullRequestPresentation falls back to commit presentation when thread summary is blank", async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-pr-presentation-fallback-"));
  try {
    await fs.writeFile(path.join(workspacePath, "README.md"), "test\n");
    git(workspacePath, ["init", "-b", "main"]);
    git(workspacePath, ["config", "user.name", "Codeq8 Test"]);
    git(workspacePath, ["config", "user.email", "codeq8@example.com"]);
    git(workspacePath, ["add", "README.md"]);
    git(workspacePath, ["commit", "-m", "Initial real subject", "-m", "Useful body"]);
    git(workspacePath, ["remote", "add", "origin", workspacePath]);
    git(workspacePath, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(workspacePath, ["checkout", "-b", "feature/fallback"]);
    git(workspacePath, ["update-ref", "refs/remotes/origin/feature/fallback", "HEAD"]);

    const presentation = await buildPullRequestPresentation({
      workspacePath,
      commandEnv: process.env,
      branch: "feature/fallback",
      baseBranch: "main",
      threadTitle: "New thread",
      assistantMessage: "",
    });

    assert.equal(presentation.title, "Initial real subject");
    assert.equal(presentation.body, "Useful body");
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});
