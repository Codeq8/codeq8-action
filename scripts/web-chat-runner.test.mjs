import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertWebChatRunnerRuntimeCompatibility,
  applyCodexNodeOptions,
  buildFirebaseStorageDownloadUrl,
  buildCodexPrompt,
  buildResumePrompt,
  buildUploadedCodexSessionStoredValue,
  configureWorkspaceGitCredentialHelper,
  configureWorkspacePushPolicy,
  DEFAULT_TIMEOUT_SECONDS,
  findPullRequestForBranch,
  flushServerOwnedCodeq8File,
  hydrateServerOwnedCodeq8File,
  extractUserVisibleFailureHeadline,
  isRecoverableCodexSessionErrorState,
  materializeWebChatAttachments,
  normalizeAttachmentRecord,
  persistCapturedCodexSessionBundleWithRetries,
  persistWorkspaceProgress,
  prepareGitHubCliAuth,
  prepareRunnerDiscordDmCli,
  prepareWebChatCodexSessionUpload,
  readFirebaseStorageAttachment,
  readWebChatAttachment,
  runCodex,
  toUserVisibleRunnerFailureMessage,
  uploadPreparedWebChatCodexSessionBundle,
  discardPreparedWebChatCodexSessionBundle,
} from "./web-chat-runner.mjs";

const CONTRACT_VERSION = "web_chat_runner_runtime_v1";

test("Codex chat runs default to the 72 hour GitHub Actions budget", () => {
  assert.equal(DEFAULT_TIMEOUT_SECONDS, 72 * 60 * 60);
});

test("applyCodexNodeOptions maps dedicated Codex preloads onto the Codex child env", () => {
  const commandEnv = {
    CODEQ8_CODEX_NODE_OPTIONS:
      " --import=/workspace/scripts/register-node-typescript-loader.mjs --import=/workspace/scripts/allow-dirty-branch-worktree-preload.mts ",
    NODE_OPTIONS: "",
  };

  assert.equal(applyCodexNodeOptions(commandEnv), commandEnv);
  assert.equal(
    commandEnv.NODE_OPTIONS,
    "--import=/workspace/scripts/register-node-typescript-loader.mjs --import=/workspace/scripts/allow-dirty-branch-worktree-preload.mts",
  );
});

test("runCodex applies dedicated Node options only to the Codex process env", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-node-options-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.sh");
  const envOutputPath = path.join(workspacePath, "node-options.txt");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/bin/sh",
      `printf '%s' "$NODE_OPTIONS" > ${JSON.stringify(envOutputPath)}`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const commandEnv = {
    ...process.env,
    CODEQ8_CODEX_NODE_OPTIONS: "--no-warnings",
    NODE_OPTIONS: "",
  };
  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "print env",
    workspacePath,
    commandEnv,
    timeoutSeconds: 30,
  });

  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(envOutputPath, "utf8"), "--no-warnings");
  assert.equal(commandEnv.NODE_OPTIONS, "");
});

test("normalizeAttachmentRecord preserves Firebase Storage metadata for direct reads", () => {
  assert.deepEqual(
    normalizeAttachmentRecord({
      attachment_id: "wca_screenshot",
      name: "Screenshot.png",
      content_type: "image/png",
      size_bytes: 123,
      storage_backend: "firebase_storage",
      storage_bucket: "codeq8.appspot.com",
      storage_key:
        "chat_attachments/github:abdul/wct_123/wcm_123/wca_screenshot/Screenshot.png",
    }),
    {
      attachment_id: "wca_screenshot",
      name: "Screenshot.png",
      content_type: "image/png",
      size_bytes: 123,
      storage_backend: "firebase_storage",
      storage_bucket: "codeq8.appspot.com",
      storage_key:
        "chat_attachments/github:abdul/wct_123/wcm_123/wca_screenshot/Screenshot.png",
    },
  );
});

test("buildFirebaseStorageDownloadUrl encodes storage object names for GCS media reads", () => {
  assert.equal(
    buildFirebaseStorageDownloadUrl({
      bucket: "codeq8-cf11c.firebasestorage.app",
      storageKey:
        "chat_attachments/github:abdul/wct_123/wcm_123/wca_123/test file.png",
    }),
    "https://storage.googleapis.com/download/storage/v1/b/codeq8-cf11c.firebasestorage.app/o/chat_attachments%2Fgithub%3Aabdul%2Fwct_123%2Fwcm_123%2Fwca_123%2Ftest%20file.png?alt=media",
  );
});

test("readFirebaseStorageAttachment exchanges the service account key and downloads the object", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const calls = [];

  const loaded = await readFirebaseStorageAttachment({
    attachment: {
      attachment_id: "wca_screenshot",
      name: "Screenshot.png",
      content_type: "image/png",
      size_bytes: 12,
      storage_backend: "firebase_storage",
      storage_bucket: "codeq8.appspot.com",
      storage_key:
        "chat_attachments/github:abdul/wct_123/wcm_123/wca_screenshot/Screenshot.png",
    },
    firebaseJsonKey: JSON.stringify({
      client_email: "runner-direct-read@example.com",
      private_key: privateKeyPem,
      token_uri: "https://oauth2.example/token",
    }),
    retries: 1,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url) === "https://oauth2.example/token") {
        assert.match(String(init.body || ""), /grant_type=urn%3Aietf%3Aparams/);
        assert.match(String(init.body || ""), /assertion=/);
        return new Response(
          JSON.stringify({
            access_token: "ya29.test",
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      }

      assert.equal(init.headers?.Authorization, "Bearer ya29.test");
      return new Response(Buffer.from("image-bytes", "utf8"), { status: 200 });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(
    calls[1]?.url,
    "https://storage.googleapis.com/download/storage/v1/b/codeq8.appspot.com/o/chat_attachments%2Fgithub%3Aabdul%2Fwct_123%2Fwcm_123%2Fwca_screenshot%2FScreenshot.png?alt=media",
  );
  assert.equal(
    Buffer.from(loaded.fileContentsBase64Url, "base64url").toString("utf8"),
    "image-bytes",
  );
});

test("materializeWebChatAttachments reads Firebase Storage attachments directly when credentials are available", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-attachment-test-"));
  const calls = {
    firebaseReads: [],
    workerReads: 0,
  };

  try {
    const materialized = await materializeWebChatAttachments({
      attachments: [
        {
          attachment_id: "wca_screenshot",
          name: "Screenshot.png",
          content_type: "image/png",
          size_bytes: 12,
          storage_backend: "firebase_storage",
          storage_bucket: "codeq8.appspot.com",
          storage_key:
            "chat_attachments/github:abdul/wct_123/wcm_123/wca_screenshot/Screenshot.png",
        },
      ],
      attachmentRootPath: tempRoot,
      workerUrl: "https://worker.example",
      adminToken: "runner_token",
      threadId: "wct_123",
      commandEnv: {
        FIREBASE_JSON_KEY: '{"client_email":"runner@example.com","private_key":"unused"}',
      },
      readFirebaseStorageAttachmentImpl: async ({ attachment, firebaseJsonKey }) => {
        calls.firebaseReads.push({ attachment, firebaseJsonKey });
        return {
          attachment,
          fileContentsBase64Url: Buffer.from("image-bytes", "utf8").toString(
            "base64url",
          ),
        };
      },
      readWebChatAttachmentImpl: async () => {
        calls.workerReads += 1;
        throw new Error("worker fallback should not run");
      },
    });

    assert.equal(calls.workerReads, 0);
    assert.equal(calls.firebaseReads.length, 1);
    assert.equal(calls.firebaseReads[0]?.attachment?.storage_bucket, "codeq8.appspot.com");
    assert.equal(materialized.length, 1);
    assert.equal(
      path.basename(materialized[0]?.local_path || ""),
      "wca_screenshot-Screenshot.png",
    );
    assert.equal(await fs.readFile(materialized[0].local_path, "utf8"), "image-bytes");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("assertWebChatRunnerRuntimeCompatibility accepts the server-owned runtime manifest", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({
      ok: true,
      contract_version: CONTRACT_VERSION,
      capabilities: [
        "server_owned_prompt",
        "server_owned_codeq8_file_sync",
        "staged_codex_session_upload",
        "recoverable_codex_session_errors",
      ],
      authorized_paths: [
        "/api/github/workspace-git-token",
        "/api/chat/runs/callback",
        "/api/chat/runs/runtime-manifest",
        "/api/chat/runs/prompt",
        "/api/chat/runs/codeq8-file",
        "/api/chat/runs/codeq8-file/save",
        "/web-chat/attachments/get",
        "/web-chat/codex-session/get",
        "/web-chat/codex-session/upload-prepare",
        "/web-chat/codex-session/upload-discard",
        "/web-chat/codex-session/upsert",
        "/web-chat/codex-session/invalidate",
        "/web-chat/threads/get",
      ],
      scoped_authorized_paths: [
        "/web-chat/codex-session/upload-direct",
      ],
    });
  };

  try {
    const manifest = await assertWebChatRunnerRuntimeCompatibility({
      publicBaseUrl: "https://codeq8.example.com",
      webChatRunToken: "header.payload.signature",
      workspaceRepository: "Codeq8/Codeq8",
      threadId: "wct_123",
      runId: "wcr_123",
    });

    assert.equal(manifest.contract_version, CONTRACT_VERSION);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://codeq8.example.com/api/chat/runs/runtime-manifest");
    assert.equal(calls[0]?.method, "POST");
    assert.deepEqual(calls[0]?.body, {
      workspace_repository: "Codeq8/Codeq8",
      thread_id: "wct_123",
      run_id: "wcr_123",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("assertWebChatRunnerRuntimeCompatibility fails fast when staged upload routes are missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      ok: true,
      contract_version: CONTRACT_VERSION,
      capabilities: [
        "server_owned_prompt",
        "staged_codex_session_upload",
        "recoverable_codex_session_errors",
      ],
      authorized_paths: [
        "/api/github/workspace-git-token",
        "/api/chat/runs/callback",
        "/api/chat/runs/runtime-manifest",
        "/api/chat/runs/prompt",
        "/web-chat/attachments/get",
        "/web-chat/codex-session/get",
        "/web-chat/codex-session/upsert",
        "/web-chat/codex-session/invalidate",
        "/web-chat/threads/get",
      ],
    });

  try {
    await assert.rejects(
      () =>
        assertWebChatRunnerRuntimeCompatibility({
          publicBaseUrl: "https://codeq8.example.com",
          webChatRunToken: "header.payload.signature",
          workspaceRepository: "Codeq8/Codeq8",
          threadId: "wct_123",
          runId: "wcr_123",
        }),
      /missing authorized paths: \/web-chat\/codex-session\/upload-prepare, \/web-chat\/codex-session\/upload-direct, \/web-chat\/codex-session\/upload-discard/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("readWebChatAttachment retries transient worker failures", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method || "GET",
      headers: new Headers(init?.headers || {}),
    });
    if (calls.length < 3) {
      return Response.json(
        { ok: false, error: "temporary Firebase Storage outage" },
        { status: 503 },
      );
    }
    return Response.json({
      ok: true,
      attachment: {
        attachment_id: "wca_123",
        name: "screenshot.png",
        content_type: "image/png",
        size_bytes: 5,
      },
      file_contents_base64url: Buffer.from("hello").toString("base64url"),
    });
  };

  try {
    const loaded = await readWebChatAttachment({
      workerUrl: "https://worker.example",
      adminToken: "header.payload.signature",
      threadId: "wct_123",
      attachmentId: "wca_123",
      retryDelayMs: 1,
    });

    assert.equal(calls.length, 3);
    assert.equal(
      calls[0]?.url,
      "https://worker.example/web-chat/attachments/get?thread_id=wct_123&attachment_id=wca_123&include_contents=1",
    );
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer header.payload.signature");
    assert.equal(loaded.attachment.attachment_id, "wca_123");
    assert.equal(Buffer.from(loaded.fileContentsBase64Url, "base64url").toString(), "hello");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runCodex treats auth-like repository stdout as normal output", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-stdout-auth-text-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "console.log('cloudflare/control-plane/tests/control-plane-routing.test.mjs: error: \"refresh_token_reused\",');",
      "await new Promise((resolve) => setTimeout(resolve, 100));",
      "process.exit(0);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "inspect auth fixtures",
    workspacePath,
    commandEnv: process.env,
    timeoutSeconds: 30,
  });

  assert.equal(result.ok, true);
});

test("runCodex returns normal diagnostics for auth-like stderr", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-stderr-auth-text-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "console.error('ERROR: failed to refresh token: refresh_token_reused');",
      "await new Promise((resolve) => setTimeout(resolve, 100));",
      "process.exit(1);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "run with stale auth",
    workspacePath,
    commandEnv: process.env,
    timeoutSeconds: 30,
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Codex exited with code=1 signal=none/i);
  assert.match(result.diagnosticOutput, /refresh_token_reused/i);
});

function git(workspacePath, args) {
  execFileSync("git", args, { cwd: workspacePath, env: process.env });
}

function readAheadCount(workspacePath, branch) {
  const output = execFileSync(
    "git",
    ["rev-list", "--left-right", "--count", `origin/${branch}...refs/heads/${branch}`],
    {
      cwd: workspacePath,
      env: process.env,
      encoding: "utf8",
    },
  );
  const [, aheadText = "0"] = String(output || "").trim().split(/\s+/, 2);
  return Number.parseInt(aheadText, 10) || 0;
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

test("buildCodexPrompt prepends runner-owned codeq8.md guidance when file sync is active", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      ok: true,
      contract_version: CONTRACT_VERSION,
      prompt: "server-owned fresh prompt",
    });

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
      workspacePersistenceState: null,
      threadSpecText: "",
      promptText: "fix it",
      recentChecksPromptText: "",
      codeq8Cli: { available: false },
      attachments: [],
      referencedThreads: [],
      serverOwnedCodeq8FilePath: "codeq8.md",
    });

    assert.match(prompt, /Runner-owned prompt file:/);
    assert.match(prompt, /edit `codeq8\.md` in place and keep the visible assistant reply free of prompt-transport markup/);
    assert.match(prompt, /server-owned fresh prompt$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buildCodexPrompt prepends runner-owned Discord DM guidance when available", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      ok: true,
      contract_version: CONTRACT_VERSION,
      prompt: "server-owned fresh prompt",
    });

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
      workspacePersistenceState: null,
      threadSpecText: "",
      promptText: "fix it",
      recentChecksPromptText: "",
      codeq8Cli: { available: false },
      attachments: [],
      referencedThreads: [],
      runnerDiscordDmCommand: "codeq8-discord-dm",
    });

    assert.match(prompt, /Runner-owned Discord DM helper:/);
    assert.match(prompt, /codeq8-discord-dm list --json/);
    assert.match(prompt, /codeq8-discord-dm send --content .* --json/);
    assert.match(prompt, /wrapper prints no visible stdout/i);
    assert.match(prompt, /node --input-type=module -e/);
    assert.match(prompt, /Do not claim that a Discord DM was sent unless the helper proves `sent: true`\./);
    assert.match(prompt, /server-owned fresh prompt$/);
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

test("buildResumePrompt prepends runner-owned Discord DM guidance when available", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      ok: true,
      contract_version: CONTRACT_VERSION,
      prompt: "server-owned resume prompt",
    });

  try {
    const prompt = await buildResumePrompt({
      publicBaseUrl: "https://codeq8.example.com",
      webChatRunToken: "header.payload.signature",
      repository: "Codeq8/Codeq8",
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
      workspacePersistenceState: null,
      threadSpecText: "",
      promptText: "keep going",
      recentUserMessagesPromptText: "",
      recentChecksPromptText: "",
      attachments: [],
      referencedThreads: [],
      serverOwnedCodeq8FilePath: "",
      runnerDiscordDmCommand: "codeq8-discord-dm",
    });

    assert.match(prompt, /Runner-owned Discord DM helper:/);
    assert.match(prompt, /codeq8-discord-dm list --json/);
    assert.match(prompt, /codeq8-discord-dm send --content .* --json/);
    assert.match(prompt, /server-owned resume prompt$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prepareRunnerDiscordDmCli writes the helper wrapper into the runtime bin", async (t) => {
  const runtimeHomePath = await fs.mkdtemp(path.join(os.tmpdir(), "runner-discord-dm-"));
  t.after(async () => {
    await fs.rm(runtimeHomePath, { recursive: true, force: true });
  });

  const commandEnv = { PATH: "/usr/bin" };
  const prepared = await prepareRunnerDiscordDmCli({
    commandEnv,
    runtimeHomePath,
  });

  assert.equal(prepared.available, true);
  assert.equal(prepared.commandName, "codeq8-discord-dm");
  assert.match(prepared.wrapperPath, /codeq8-discord-dm$/);
  const wrapperContents = await fs.readFile(prepared.wrapperPath, "utf8");
  assert.match(wrapperContents, /web-chat-runner-discord-dm\.mjs/);
  assert.match(commandEnv.PATH, new RegExp(runtimeHomePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("hydrateServerOwnedCodeq8File writes the prompt file into the workspace and hides it from git", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-file-hydrate-"));
  const gitPath = path.join(workspacePath, ".git", "info");
  const originalFetch = globalThis.fetch;

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await fs.mkdir(gitPath, { recursive: true });
  globalThis.fetch = async () =>
    Response.json({
      ok: true,
      contract_version: CONTRACT_VERSION,
      prompt_file_path: "codeq8.md",
      repo_workflow_prompt_markdown: "# Codeq8\n\n- Durable prompt",
      latest_revision_id: "rpr_123",
      latest_revision_number: 4,
    });

  const hydrated = await hydrateServerOwnedCodeq8File({
    publicBaseUrl: "https://codeq8.example.com",
    webChatRunToken: "header.payload.signature",
    workspaceRepository: "Codeq8/Codeq8",
    threadId: "wct_123",
    runId: "wcr_123",
    workspacePath,
  });

  assert.equal(hydrated.relativePath, "codeq8.md");
  assert.equal(hydrated.latestRevisionId, "rpr_123");
  assert.equal(
    await fs.readFile(path.join(workspacePath, "codeq8.md"), "utf8"),
    "# Codeq8\n\n- Durable prompt",
  );
  assert.match(await fs.readFile(path.join(workspacePath, ".git", "info", "exclude"), "utf8"), /\/codeq8\.md/);
});

test("flushServerOwnedCodeq8File saves direct file edits and preserves the visible assistant reply", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-file-flush-"));
  const promptFilePath = path.join(workspacePath, "codeq8.md");
  const originalFetch = globalThis.fetch;
  const calls = [];

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await fs.writeFile(promptFilePath, "# Codeq8\n\n- Updated on disk", "utf8");
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({
      ok: true,
      contract_version: CONTRACT_VERSION,
      prompt_file_path: "codeq8.md",
      unchanged: false,
      latest_revision_id: "rpr_next",
      latest_revision_number: 5,
    });
  };

  const result = await flushServerOwnedCodeq8File({
    publicBaseUrl: "https://codeq8.example.com",
    webChatRunToken: "header.payload.signature",
    workspaceRepository: "Codeq8/Codeq8",
    threadId: "wct_123",
    runId: "wcr_123",
    hydratedFile: {
      filePath: promptFilePath,
      relativePath: "codeq8.md",
      promptMarkdown: "# Codeq8\n\n- Original",
      latestRevisionId: "rpr_prev",
      latestRevisionNumber: 4,
    },
    assistantMessage: "Finished the work.",
  });

  assert.equal(result.assistantMessage, "Finished the work.");
  assert.equal(result.promptSaved, true);
  assert.equal(result.latestRevisionId, "rpr_next");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://codeq8.example.com/api/chat/runs/codeq8-file/save");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.body?.repo_workflow_prompt_markdown, "# Codeq8\n\n- Updated on disk");
  assert.equal(calls[0]?.body?.expected_revision_id, "rpr_prev");
});

test("flushServerOwnedCodeq8File skips saves when the prompt file is unchanged", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-file-hidden-sync-"));
  const promptFilePath = path.join(workspacePath, "codeq8.md");
  const originalFetch = globalThis.fetch;
  const calls = [];

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await fs.writeFile(promptFilePath, "# Codeq8\n\n- Original", "utf8");
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({
      ok: true,
      contract_version: CONTRACT_VERSION,
      prompt_file_path: "codeq8.md",
      unchanged: false,
      latest_revision_id: "rpr_next",
      latest_revision_number: 5,
    });
  };

  const result = await flushServerOwnedCodeq8File({
    publicBaseUrl: "https://codeq8.example.com",
    webChatRunToken: "header.payload.signature",
    workspaceRepository: "Codeq8/Codeq8",
    threadId: "wct_123",
    runId: "wcr_123",
    hydratedFile: {
      filePath: promptFilePath,
      relativePath: "codeq8.md",
      promptMarkdown: "# Codeq8\n\n- Original",
      latestRevisionId: "rpr_prev",
      latestRevisionNumber: 4,
    },
    assistantMessage: "Finished the work.",
  });

  assert.equal(result.assistantMessage, "Finished the work.");
  assert.equal(result.promptSaved, false);
  assert.equal(calls.length, 0);
  assert.equal(
    await fs.readFile(promptFilePath, "utf8"),
    "# Codeq8\n\n- Original",
  );
});

test("findPullRequestForBranch only reads existing pull requests", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json([
      {
        number: 42,
        title: "Preserve loop state in thread registry",
        html_url: "https://github.com/Codeq8/codeq8-action/pull/42",
      },
    ]);
  };

  try {
    const result = await findPullRequestForBranch({
      repository: "Codeq8/codeq8-action",
      headRepository: "Codeq8/codeq8-action",
      headBranch: "feature/thread-title",
      baseBranch: "main",
      token: "github-token",
    });

    assert.deepEqual(result, {
      ok: true,
      pullRequest: {
        number: 42,
        title: "Preserve loop state in thread registry",
        url: "https://github.com/Codeq8/codeq8-action/pull/42",
      },
      existing: true,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls[0]?.body, null);
    assert.match(calls[0]?.url, /^https:\/\/api\.github\.com\/repos\/Codeq8\/codeq8-action\/pulls\?/);
    assert.match(calls[0]?.url, /state=open/);
    assert.match(calls[0]?.url, /head=Codeq8%3Afeature%2Fthread-title/);
    assert.match(calls[0]?.url, /base=main/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prepareGitHubCliAuth configures gh through environment without wrapping the binary", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-gh-env-"));
  const fakeBinPath = path.join(tempDir, "fake-bin");
  const runtimeHomePath = path.join(tempDir, "runtime");
  const ghCallLogPath = path.join(tempDir, "gh-call-log.txt");
  await fs.mkdir(fakeBinPath, { recursive: true });
  const fakeGhPath = path.join(fakeBinPath, "gh");
  await fs.writeFile(
    fakeGhPath,
    [
      "#!/bin/sh",
      `log_path=${JSON.stringify(ghCallLogPath)}`,
      "printf 'GH_TOKEN=%s\\nGITHUB_TOKEN=%s\\nGH_CONFIG_DIR=%s\\nGH_PROMPT_DISABLED=%s\\nARGS=%s\\n' \"$GH_TOKEN\" \"$GITHUB_TOKEN\" \"$GH_CONFIG_DIR\" \"$GH_PROMPT_DISABLED\" \"$*\" >> \"$log_path\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await fs.chmod(fakeGhPath, 0o755);

  const originalPath = `${fakeBinPath}${path.delimiter}${process.env.PATH || ""}`;
  const commandEnv = {
    ...process.env,
    PATH: originalPath,
    CODEX_GITHUB_WRITE_TOKEN: "token",
    CODEX_GITHUB_TOKEN_HELPER_PATH: "",
  };
  const prepared = await prepareGitHubCliAuth({
    commandEnv,
    runtimeHomePath,
  });
  assert.equal(prepared.available, true);
  assert.equal(prepared.binPath, fakeGhPath);
  assert.equal(commandEnv.PATH, originalPath);
  assert.equal(commandEnv.GH_TOKEN, "token");
  assert.equal(commandEnv.GITHUB_TOKEN, "token");
  assert.equal(commandEnv.GH_PROMPT_DISABLED, "1");
  assert.equal(commandEnv.GH_CONFIG_DIR, path.join(runtimeHomePath, "gh-config"));

  execFileSync(
    "gh",
    ["pr", "create", "--body", "## Summary\\n- raw gh input"],
    {
      env: commandEnv,
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  const ghCallLog = await fs.readFile(ghCallLogPath, "utf8");
  assert.match(ghCallLog, /GH_TOKEN=token/);
  assert.match(ghCallLog, /GITHUB_TOKEN=token/);
  assert.match(ghCallLog, /GH_CONFIG_DIR=.*gh-config/);
  assert.match(ghCallLog, /GH_PROMPT_DISABLED=1/);
  assert.match(ghCallLog, /ARGS=pr create --body ## Summary\\n- raw gh input/);
});

test("persistWorkspaceProgress explicitly pushes remembered branches that are ahead of origin", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-action-persist-push-"));
  const remotePath = path.join(tempRoot, "remote.git");
  const seedPath = path.join(tempRoot, "seed");
  const workspacePath = path.join(tempRoot, "workspace");

  try {
    git(tempRoot, ["init", "--bare", remotePath]);
    await fs.mkdir(seedPath, { recursive: true });
    git(seedPath, ["init"]);
    git(seedPath, ["checkout", "-b", "main"]);
    git(seedPath, ["config", "user.name", "Codeq8 Test"]);
    git(seedPath, ["config", "user.email", "codeq8@example.com"]);
    await fs.writeFile(path.join(seedPath, "README.md"), "seed\n");
    git(seedPath, ["add", "README.md"]);
    git(seedPath, ["commit", "-m", "Initial commit"]);
    git(seedPath, ["remote", "add", "origin", remotePath]);
    git(seedPath, ["push", "-u", "origin", "main"]);

    git(tempRoot, ["clone", remotePath, workspacePath]);
    git(workspacePath, ["config", "user.name", "Codeq8 Test"]);
    git(workspacePath, ["config", "user.email", "codeq8@example.com"]);
    git(workspacePath, ["checkout", "-b", "feature/test", "origin/main"]);
    await fs.writeFile(path.join(workspacePath, "feature.txt"), "v1\n");
    git(workspacePath, ["add", "feature.txt"]);
    git(workspacePath, ["commit", "-m", "Feature start"]);
    git(workspacePath, ["push", "-u", "origin", "feature/test"]);

    await fs.writeFile(path.join(workspacePath, "feature.txt"), "v2\n");
    git(workspacePath, ["add", "feature.txt"]);
    git(workspacePath, ["commit", "-m", "Feature follow-up"]);

    assert.equal(readAheadCount(workspacePath, "feature/test"), 1);

    const result = await persistWorkspaceProgress({
      publicBaseUrl: "https://codeq8.example.com",
      webChatRunToken: "header.payload.signature",
      workspacePath,
      commandEnv: process.env,
      sourceType: "default_branch",
      branch: "feature/test",
      writeMode: "direct_push",
      repository: "Codeq8/codeq8-action",
      threadId: "wct_123",
      runId: "wcr_123",
      headRepository: "Codeq8/codeq8-action",
      baseBranch: "main",
      gitToken: "",
      protectedBranches: ["main"],
      baselineState: null,
      threadTitle: "test",
      assistantMessage: "test",
    });

    assert.equal(result.error, "");
    assert.equal(result.pendingRemoteSync, "");
    assert.equal(result.pushed, true);
    assert.equal(result.resolvedWriteBranch, "feature/test");
    assert.equal(readAheadCount(workspacePath, "feature/test"), 0);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("configureWorkspaceGitCredentialHelper clears inherited helpers before adding the Codeq8 helper", async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-action-credential-helper-"));

  try {
    git(workspacePath, ["init"]);

    const helperPath = await configureWorkspaceGitCredentialHelper({
      workspacePath,
      commandEnv: process.env,
      publicBaseUrl: "https://codeq8.example.com",
      workspaceRepository: "Codeq8/codeq8-action",
    });

    const helperConfig = execFileSync(
      "git",
      ["config", "--local", "--get-all", "credential.helper"],
      {
        cwd: workspacePath,
        env: process.env,
        encoding: "utf8",
      },
    );
    const helperValues = String(helperConfig || "")
      .split(/\r?\n/)
      .slice(0, -1);
    assert.deepEqual(helperValues, ["", helperPath]);

    const useHttpPath = execFileSync(
      "git",
      ["config", "--local", "--get", "credential.useHttpPath"],
      {
        cwd: workspacePath,
        env: process.env,
        encoding: "utf8",
      },
    );
    assert.equal(String(useHttpPath || "").trim(), "true");

    const helperScript = await fs.readFile(helperPath, "utf8");
    assert.match(helperScript, /workspace-git-token/);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test("configureWorkspacePushPolicy rejects credential-bearing HTTPS push remotes", async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-action-push-policy-"));

  try {
    git(workspacePath, ["init"]);
    git(workspacePath, ["remote", "add", "origin", "https://github.com/Codeq8/codeq8-action.git"]);

    await assert.rejects(
      configureWorkspacePushPolicy({
        workspacePath,
        commandEnv: process.env,
        remoteUrl: "https://x-access-token:secret@github.com/Codeq8/codeq8-action.git",
        blockedBranches: [],
      }),
      /must not embed credentials/i,
    );
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test("configureWorkspacePushPolicy keeps HTTPS push remotes tokenless", async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-action-push-policy-"));

  try {
    git(workspacePath, ["init"]);
    git(workspacePath, ["remote", "add", "origin", "https://github.com/Codeq8/codeq8-action.git"]);

    await configureWorkspacePushPolicy({
      workspacePath,
      commandEnv: process.env,
      remoteUrl: "https://github.com/Codeq8/codeq8-action.git",
      blockedBranches: [],
    });

    const pushUrl = execFileSync(
      "git",
      ["config", "--local", "--get", "remote.origin.pushurl"],
      {
        cwd: workspacePath,
        env: process.env,
        encoding: "utf8",
      },
    );
    assert.equal(
      String(pushUrl || "").trim(),
      "https://github.com/Codeq8/codeq8-action.git",
    );
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test("prepare/upload/discard codex session bundle calls the staged worker routes", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const bodyText = init?.body ? String(init.body) : "";
    const contentType = String(init?.headers?.["Content-Type"] || "");
    calls.push({
      url: String(url),
      method: init?.method || "GET",
      contentType,
      body:
        bodyText && contentType.includes("application/json")
          ? JSON.parse(bodyText)
          : bodyText || null,
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
    assert.match(
      calls[1]?.url,
      /^https:\/\/worker\.example\.com\/web-chat\/codex-session\/upload-direct\?/,
    );
    const uploadUrl = new URL(calls[1]?.url || "");
    assert.equal(uploadUrl.searchParams.get("thread_id"), "wct_123");
    assert.equal(
      uploadUrl.searchParams.get("storage_key"),
      "web_chat_codex_session_blob:wct_123:1:nonce",
    );
    assert.equal(uploadUrl.searchParams.get("storage_bucket"), "bucket");
    assert.equal(uploadUrl.searchParams.get("storage_backend"), "firebase_storage");
    assert.equal(calls[1]?.contentType, "text/plain; charset=utf-8");
    assert.equal(calls[1]?.body, "{\"version\":3}");
    assert.equal(calls[2]?.url, "https://worker.example.com/web-chat/codex-session/upload-discard");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("persistCapturedCodexSessionBundleWithRetries accepts duplicate same-run revision conflicts", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-home-"));
  const sessionFileRelativePath =
    "sessions/2026/05/02/rollout-2026-05-02T01-06-49-019dd643-e3ec-76e1-952c-3dc25053e8c3.jsonl";
  const sessionFilePath = path.join(codexHome, sessionFileRelativePath);
  const sessionFileContents = [
    JSON.stringify({
      timestamp: "2026-05-02T01:06:49.000Z",
      type: "session_meta",
      payload: {
        id: "019dd643-e3ec-76e1-952c-3dc25053e8c3",
        cli_version: "0.128.0",
        model: "gpt-5.5",
      },
    }),
    "",
  ].join("\n");
  await fs.mkdir(path.dirname(sessionFilePath), { recursive: true });
  await fs.writeFile(sessionFilePath, sessionFileContents, "utf8");

  globalThis.fetch = async (url, init) => {
    const parsedUrl = new URL(String(url));
    calls.push({
      url: String(url),
      path: parsedUrl.pathname,
      method: init?.method || "GET",
      body: init?.body ? String(init.body) : "",
    });
    if (parsedUrl.pathname === "/web-chat/codex-session/upload-prepare") {
      return Response.json(
        {
          ok: false,
          error: "web chat codex session revision conflict (expected 161, found 162).",
        },
        { status: 409 },
      );
    }
    if (parsedUrl.pathname === "/web-chat/codex-session/get") {
      return Response.json({
        ok: true,
        codex_session_state: {
          status: "ready",
          session_id: "019dd643-e3ec-76e1-952c-3dc25053e8c3",
          session_file_relative_path: sessionFileRelativePath,
          bundle_storage_key: "web_chat_codex_session_blob:wct_123:162:nonce",
          storage_bucket: "bucket",
          storage_backend: "firebase_storage",
          bundle_size_bytes: 123,
          bundle_compressed_size_bytes: 45,
          bundle_revision: 162,
          last_run_id: "wcr_duplicate",
        },
      });
    }
    throw new Error(`Unexpected request ${parsedUrl.pathname}`);
  };

  try {
    const state = await persistCapturedCodexSessionBundleWithRetries({
      workerUrl: "https://worker.example.com",
      adminToken: "secret",
      threadId: "wct_123",
      runId: "wcr_duplicate",
      codexHome,
      existingSessionState: {
        status: "ready",
        session_id: "019dd643-e3ec-76e1-952c-3dc25053e8c3",
        session_file_relative_path: sessionFileRelativePath,
        bundle_revision: 161,
      },
      model: "gpt-5.5",
      targetSignature: "target",
      expectedBundleRevision: 161,
    });

    assert.equal(state.status, "ready");
    assert.equal(state.bundle_revision, 162);
    assert.equal(state.last_run_id, "wcr_duplicate");
    assert.deepEqual(
      calls.map((call) => call.path),
      ["/web-chat/codex-session/upload-prepare", "/web-chat/codex-session/get"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(codexHome, { recursive: true, force: true });
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

test("isRecoverableCodexSessionErrorState treats worker fetch failures as recoverable stale session state", () => {
  assert.equal(
    isRecoverableCodexSessionErrorState("Worker request failed: fetch failed"),
    true,
  );
  assert.equal(
    isRecoverableCodexSessionErrorState(
      "Codex session state is in error status: Worker request failed: fetch failed",
    ),
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
