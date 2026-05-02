import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGitHubActionsRunUrl,
  buildWebChatRunnerEnv,
  normalizeGitHubActionsChatRunPayload,
  readGitHubActionsChatRunPayload,
} from "./github-actions-web-chat-runner-bridge.mjs";

test("readGitHubActionsChatRunPayload reads workflow_dispatch JSON input", async () => {
  const payload = await readGitHubActionsChatRunPayload({
    eventPayload: {
      inputs: {
        run_payload_json: JSON.stringify({
          run_id: "wcr_123",
          thread_id: "wct_123",
        }),
      },
    },
  });

  assert.deepEqual(payload, {
    run_id: "wcr_123",
    thread_id: "wct_123",
  });
});

test("normalizeGitHubActionsChatRunPayload preserves referenced threads", () => {
  const payload = normalizeGitHubActionsChatRunPayload({
    run_id: "wcr_123",
    thread_id: "wct_123",
    message_id: "wcm_123",
    workspace_repository: "Codeq8/Codeq8",
    worker_url: "main-codeq8.bojamal7.workers.dev/",
    prompt_text: "Fix it",
    branch_context: {
      default_branch: "main",
      context_branch: "main",
      write_mode: "branch_and_pr",
      base_branch: "main",
    },
    referenced_threads: [{ thread_id: "wct_other" }],
  });

  assert.equal(payload.worker_url, "https://main-codeq8.bojamal7.workers.dev");
  assert.equal(payload.referenced_threads_json, '[{"thread_id":"wct_other"}]');
});

test("normalizeGitHubActionsChatRunPayload preserves attachment storage metadata", () => {
  const payload = normalizeGitHubActionsChatRunPayload({
    run_id: "wcr_123",
    thread_id: "wct_123",
    message_id: "wcm_123",
    workspace_repository: "Codeq8/Codeq8",
    worker_url: "main-codeq8.bojamal7.workers.dev/",
    prompt_text: "Fix it",
    branch_context: {
      default_branch: "main",
      context_branch: "main",
      write_mode: "branch_and_pr",
      base_branch: "main",
    },
    attachments: [
      {
        attachment_id: "wca_screenshot",
        name: "screenshot.png",
        content_type: "image/png",
        size_bytes: 1234,
        storage_backend: "firebase_storage",
        storage_bucket: "codeq8.appspot.com",
        storage_key:
          "chat_attachments/github:abdul/wct_123/wcm_123/wca_screenshot/screenshot.png",
      },
    ],
  });

  assert.equal(
    payload.attachments_json,
    '[{"attachment_id":"wca_screenshot","name":"screenshot.png","content_type":"image/png","size_bytes":1234,"storage_backend":"firebase_storage","storage_bucket":"codeq8.appspot.com","storage_key":"chat_attachments/github:abdul/wct_123/wcm_123/wca_screenshot/screenshot.png"}]',
  );
});

test("buildWebChatRunnerEnv maps referenced threads into the runner env", () => {
  const env = buildWebChatRunnerEnv({
    env: {
      GITHUB_WORKSPACE: "/tmp/codeq8",
      GITHUB_REPOSITORY: "Codeq8/Codeq8",
      GITHUB_RUN_ID: "987654321",
      GITHUB_RUN_ATTEMPT: "3",
      GITHUB_WORKFLOW: "Codeq8 chat run",
      GITHUB_JOB: "chat_run",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_TOKEN: "ghs_test_token",
    },
    payload: {
      run_id: "wcr_123",
      thread_id: "wct_123",
      message_id: "wcm_123",
      workspace_repository: "Codeq8/Codeq8",
      worker_url: "https://main-codeq8.bojamal7.workers.dev",
      thread_spec: "Keep diffs narrow.",
      prompt_text: "Fix the failing run",
      branch_context: {
        default_branch: "main",
        protected_branches: ["main", "production"],
        context_branch: "main",
        write_mode: "branch_and_pr",
        base_branch: "main",
      },
      referenced_threads: [{ thread_id: "wct_other" }],
    },
  });

  assert.equal(
    buildGitHubActionsRunUrl({
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "Codeq8/Codeq8",
      GITHUB_RUN_ID: "987654321",
    }),
    "https://github.com/Codeq8/Codeq8/actions/runs/987654321",
  );
  assert.equal(env.CODE_CHAT_REFERENCED_THREADS_JSON, '[{"thread_id":"wct_other"}]');
  assert.equal(env.CODE_CHAT_THREAD_SPEC_TEXT, "Keep diffs narrow.");
});
