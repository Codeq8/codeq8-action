import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCodexPrompt,
  buildPullRequestPresentation,
  buildResumePrompt,
  buildUploadedCodexSessionStoredValue,
  extractUserVisibleFailureHeadline,
  isRecoverableCodexSessionErrorState,
  prepareWebChatCodexSessionUpload,
  toUserVisibleRunnerFailureMessage,
  uploadPreparedWebChatCodexSessionBundle,
  discardPreparedWebChatCodexSessionBundle,
} from "./web-chat-runner.mjs";

const CONTRACT_VERSION = "web_chat_runner_runtime_v1";

function git(workspacePath, args) {
  execFileSync("git", args, { cwd: workspacePath, env: process.env });
}

test("buildCodexPrompt fetches the server-owned fresh prompt", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method || "GET",
      headers: new Headers(init?.headers || {}),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({
      ok: true,
      contract_version: CONTRACT_VERSION,
      prompt: "server-owned fresh prompt",
    });
  };

  try {
    const prompt = await buildCodexPrompt({
      publicBaseUrl: "https://codeq8.example.com",
      webChatRunToken: "header.payload.signature",
      repository: "Codeq8/Codeq8",
      threadTitle: "Fix the runner",
      threadId: "wct_123",
      runId: "wcr_123",
      messageId: "wcm_123",
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
      threadSpecText: "Prefer the smallest viable diff.",
      promptText: "fix it",
      recentChecksPromptText: "Checks: green",
      codeq8Cli: { available: true },
      attachments: [{ attachment_id: "att_123", name: "log.txt", local_path: "/tmp/log.txt" }],
      referencedThreads: [{ thread_id: "wct_other" }],
    });

    assert.equal(prompt, "server-owned fresh prompt");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://codeq8.example.com/api/chat/runs/prompt");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer header.payload.signature");
    assert.equal(calls[0]?.body?.mode, "fresh");
    assert.equal(calls[0]?.body?.workspace_repository, "Codeq8/Codeq8");
    assert.equal(calls[0]?.body?.thread_id, "wct_123");
    assert.equal(calls[0]?.body?.run_id, "wcr_123");
    assert.equal(calls[0]?.body?.message_id, "wcm_123");
    assert.equal(calls[0]?.body?.codeq8_cli_available, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buildResumePrompt fetches the server-owned resume prompt", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({
      ok: true,
      contract_version: CONTRACT_VERSION,
      prompt: "server-owned resume prompt",
    });
  };

  try {
    const prompt = await buildResumePrompt({
      publicBaseUrl: "https://codeq8.example.com",
      webChatRunToken: "header.payload.signature",
      repository: "Codeq8/Codeq8",
      threadId: "wct_123",
      runId: "wcr_123",
      messageId: "wcm_123",
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
      threadSpecText: "Use the existing thread branch.",
      promptText: "keep going",
      recentUserMessagesPromptText: "Recent user context",
      recentChecksPromptText: "Checks: green",
      attachments: [],
      referencedThreads: [],
      targetShift: true,
    });

    assert.equal(prompt, "server-owned resume prompt");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://codeq8.example.com/api/chat/runs/prompt");
    assert.equal(calls[0]?.body?.mode, "resume");
    assert.equal(calls[0]?.body?.target_shift, true);
    assert.equal(calls[0]?.body?.recent_user_messages_prompt_text, "Recent user context");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buildPullRequestPresentation sends local git commit facts to the server-owned PR presentation route", async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-pr-presentation-"));
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({
      ok: true,
      contract_version: CONTRACT_VERSION,
      title: "Preserve loop state in thread registry",
      body: "Implemented the thread-registry persistence fix.\n\nAdded tests too.",
    });
  };

  try {
    await fs.writeFile(path.join(workspacePath, "README.md"), "test\n");
    git(workspacePath, ["init", "-b", "main"]);
    git(workspacePath, ["config", "user.name", "Codeq8 Test"]);
    git(workspacePath, ["config", "user.email", "codeq8@example.com"]);
    git(workspacePath, ["add", "README.md"]);
    git(workspacePath, ["commit", "-m", "Initial real subject", "-m", "Useful body"]);
    git(workspacePath, ["remote", "add", "origin", workspacePath]);
    git(workspacePath, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(workspacePath, ["checkout", "-b", "feature/thread-title"]);
    git(workspacePath, ["update-ref", "refs/remotes/origin/feature/thread-title", "HEAD"]);
    await fs.writeFile(path.join(workspacePath, "README.md"), "updated\n");
    git(workspacePath, ["add", "README.md"]);
    git(workspacePath, ["commit", "-m", "Second real subject", "-m", "Second body"]);

    const presentation = await buildPullRequestPresentation({
      publicBaseUrl: "https://codeq8.example.com",
      webChatRunToken: "header.payload.signature",
      workspaceRepository: "Codeq8/Codeq8",
      threadId: "wct_123",
      runId: "wcr_123",
      workspacePath,
      commandEnv: process.env,
      branch: "feature/thread-title",
      baseBranch: "main",
      threadTitle: "Preserve loop state in thread registry",
      assistantMessage: "Implemented the thread-registry persistence fix.\n\nAdded tests too.",
    });

    assert.deepEqual(presentation, {
      title: "Preserve loop state in thread registry",
      body: "Implemented the thread-registry persistence fix.\n\nAdded tests too.",
    });
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      "https://codeq8.example.com/api/chat/runs/pull-request-presentation",
    );
    assert.equal(calls[0]?.body?.workspace_repository, "Codeq8/Codeq8");
    assert.equal(calls[0]?.body?.thread_id, "wct_123");
    assert.equal(calls[0]?.body?.run_id, "wcr_123");
    assert.equal(calls[0]?.body?.head_commit?.subject, "Second real subject");
    assert.equal(calls[0]?.body?.head_commit?.body, "Second body");
    assert.equal(calls[0]?.body?.first_commit?.subject, "Second real subject");
    assert.equal(calls[0]?.body?.first_commit?.body, "Second body");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test("prepare/upload/discard codex session bundle calls the staged worker routes", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (String(url).endsWith("/upload-prepare")) {
      return Response.json({
        ok: true,
        upload_preparation: {
          storage_key: "web_chat_codex_session_blob:wct_123:1:nonce",
          storage_bucket: "bucket",
          storage_backend: "firebase_storage",
          upload_key: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          wrapped_key: "bbbb",
          wrapped_key_iv: "cccc",
          expected_bundle_revision: 0,
          next_bundle_revision: 1,
        },
      });
    }
    return Response.json({ ok: true });
  };

  try {
    const prepared = await prepareWebChatCodexSessionUpload({
      workerUrl: "https://worker.example.com",
      adminToken: "secret",
      threadId: "wct_123",
      expectedBundleRevision: 0,
    });
    assert.equal(prepared.uploadPreparation.storageKey, "web_chat_codex_session_blob:wct_123:1:nonce");

    await uploadPreparedWebChatCodexSessionBundle({
      workerUrl: "https://worker.example.com",
      adminToken: "secret",
      threadId: "wct_123",
      storageKey: "web_chat_codex_session_blob:wct_123:1:nonce",
      storageBucket: "bucket",
      storageBackend: "firebase_storage",
      storedValue: "{\"version\":3}",
    });
    await discardPreparedWebChatCodexSessionBundle({
      workerUrl: "https://worker.example.com",
      adminToken: "secret",
      threadId: "wct_123",
      storageKey: "web_chat_codex_session_blob:wct_123:1:nonce",
      storageBucket: "bucket",
      storageBackend: "firebase_storage",
    });

    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.url, "https://worker.example.com/web-chat/codex-session/upload-prepare");
    assert.equal(calls[1]?.url, "https://worker.example.com/web-chat/codex-session/upload");
    assert.equal(calls[2]?.url, "https://worker.example.com/web-chat/codex-session/upload-discard");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("isRecoverableCodexSessionErrorState treats token path mismatches as recoverable stale session state", () => {
  assert.equal(
    isRecoverableCodexSessionErrorState("Authorization token path mismatch."),
    true,
  );
  assert.equal(
    isRecoverableCodexSessionErrorState("Codex session state is in error status: Authorization token path mismatch."),
    true,
  );
});

test("extractUserVisibleFailureHeadline drops terminal log tails from failure blobs", () => {
  const headline = extractUserVisibleFailureHeadline(`
    Codex exited with code=1 signal=none.

    OpenAI Codex v0.115.0 (research preview)
    workdir: /Users/example/actions-runner/_work/Codeq8/Codeq8
    Thread spec:
    1. Example
  `);

  assert.equal(headline, "Codex exited with code=1 signal=none.");
});

test("toUserVisibleRunnerFailureMessage keeps generic exit failures concise", () => {
  const message = toUserVisibleRunnerFailureMessage(`
    Codex exited with code=1 signal=none.

    Runner workspace state before this turn:
    - Checked-out branch: codeq8/example
  `);

  assert.equal(message, "Codex exited with code=1 signal=none.");
});

test("buildUploadedCodexSessionStoredValue builds a wrapped version 3 envelope", async () => {
  const uploadKeyBytes = new Uint8Array(32);
  uploadKeyBytes.fill(7);

  const built = await buildUploadedCodexSessionStoredValue({
    threadId: "wct_123",
    storageKey: "web_chat_codex_session_blob:wct_123:1:nonce",
    uploadKey: Buffer.from(uploadKeyBytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, ""),
    wrappedKey: "wrapped-key",
    wrappedKeyIv: "wrapped-key-iv",
    sessionFileContents: "{\"hello\":\"world\"}",
  });

  const envelope = JSON.parse(built.storedValue);
  assert.equal(envelope.version, 3);
  assert.equal(envelope.scope, "web_chat_codex_session_bundle");
  assert.equal(envelope.content_encoding, "gzip");
  assert.equal(envelope.wrapped_key, "wrapped-key");
  assert.equal(envelope.wrapped_key_iv, "wrapped-key-iv");
  assert.ok(built.bundleSizeBytes > 0);
  assert.ok(built.bundleCompressedSizeBytes > 0);
});
