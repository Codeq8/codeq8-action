import assert from "node:assert/strict";
import test from "node:test";

import { buildCodexPrompt, buildResumePrompt } from "./web-chat-runner.mjs";

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
