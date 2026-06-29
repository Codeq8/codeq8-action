import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OPTIONAL_WEB_CHAT_RUNNER_RUNTIME_CAPABILITIES,
  OPTIONAL_WEB_CHAT_RUNNER_RUNTIME_PATHS,
  REQUIRED_WEB_CHAT_RUNNER_RUNTIME_CAPABILITIES,
  REQUIRED_WEB_CHAT_RUNNER_RUNTIME_PATHS,
} from "../lib/web-chat-runner-runtime-manifest.mjs";
import {
  assertWebChatRunnerRuntimeCompatibility,
  applyCodexNodeOptions,
  applyCodexSessionContinuityGuidance,
  appendWebChatRunMarkerToPrompt,
  buildFirebaseStorageDownloadUrl,
  buildFinalWorkspaceStateCallbackPayload,
  buildCodexPrompt,
  buildCodexRunMetadata,
  buildPublicActionStartupTimingMetadata,
  buildWorkspacePreparationRunMetadata,
  buildResumePrompt,
  buildWebChatRunMarker,
  buildWebChatRunnerDiagnosticRequest,
  buildUploadedCodexSessionStoredValue,
  createAppServerActionsReasoningTranscript,
  createAppServerFirestoreControlListener,
  captureCodexSessionBundle,
  configureWorkspaceGitCredentialHelper,
  configureWorkspacePushPolicy,
  DEFAULT_TIMEOUT_SECONDS,
  findPullRequestForBranch,
  loadCodexSessionStateForExecution,
  extractUserVisibleFailureHeadline,
  isRecoverableCodexResumeFailure,
  isRecoverableCodexTransportFailure,
  isRecoverableCodexSessionErrorState,
  isCodexAuthRefreshFailure,
  isSupersededWebChatRunError,
  invalidateHostedCodexAuthAfterRefreshFailure,
  runtimeManifestSupportsScopedPath,
  isTerminalWebChatRunPromptRefusal,
  materializeWebChatAttachments,
  normalizeAttachmentRecord,
  postAppServerProgressHistoryBatch,
  postWebChatRunnerDiagnostic,
  persistCapturedCodexSessionBundleWithRetries,
  persistWorkspaceProgress,
  prepareHostedPrecheckedWorkspace,
  prepareGitHubCliAuth,
  prepareWebChatCodexSessionUpload,
  requestWorkspaceGitToken,
  readFirebaseStorageAttachment,
  readFirebaseStorageSignedAttachment,
  writeFirebaseStorageSignedTextObject,
  readWebChatCodexSessionState,
  readWebChatAttachment,
  readWebChatAttachmentReadUrl,
  resolveCodexPath,
  resolveHostedPrecheckedWorkspacePlan,
  runCodex,
  sessionContainsWebChatRunMarker,
  normalizeHiddenThreadTitle,
  shouldContinueAfterCodexSessionPersistenceFailure,
  shouldStopBeforeCodexForRunCallbackPayload,
  shouldTreatCodexFailureAsCompleted,
  shouldRunHiddenThreadTitlePreturn,
  stripLeadingCodexTransportNoise,
  toUserVisibleRunnerFailureMessage,
  uploadPreparedWebChatCodexSessionBundle,
  discardPreparedWebChatCodexSessionBundle,
  fetchJson,
  filterUnhandledPendingAppServerControlRequests,
} from "./web-chat-runner.mjs";

const CONTRACT_VERSION = "web_chat_runner_runtime_v1";
const STARTUP_REQUIRED_RUNTIME_CAPABILITIES = Object.freeze([
  "server_owned_prompt",
  "staged_codex_session_upload",
  "recoverable_codex_session_errors",
  "codex_app_server_turn_control",
  "codex_app_server_attachment_turn_control",
  "runner_codeq8_cli",
]);
const STARTUP_REQUIRED_RUNTIME_PATHS = Object.freeze([
  "/api/github/workspace-git-token",
  "/api/chat/runs/callback",
  "/api/chat/runs/diagnostic",
  "/api/chat/runs/app-server/firebase-session",
  "/api/chat/runs/runtime-manifest",
  "/api/chat/runs/prompt",
  "/web-chat/attachments/get",
  "/web-chat/attachments/read-url",
  "/web-chat/codex-session/get",
  "/web-chat/codex-session/read-url",
  "/web-chat/codex-session/unwrap-key",
  "/web-chat/codex-session/upload-prepare",
  "/web-chat/codex-session/upload-direct",
  "/web-chat/codex-session/upload-discard",
  "/web-chat/codex-session/upsert",
  "/web-chat/codex-session/invalidate",
  "/web-chat/threads/get",
]);

test("runtime manifest baseline matches the public startup contract", () => {
  assert.deepEqual(
    REQUIRED_WEB_CHAT_RUNNER_RUNTIME_CAPABILITIES,
    STARTUP_REQUIRED_RUNTIME_CAPABILITIES,
  );
  assert.deepEqual(OPTIONAL_WEB_CHAT_RUNNER_RUNTIME_CAPABILITIES, [
    "codex_app_server_thread_goals",
    "codex_app_server_progress_history",
    "codeq8_plugin",
    "codeq8_plugin_run_behavior_skills",
    "codeq8_plugin_playwright_mcp",
    "codeq8_python_tools",
  ]);
  assert.deepEqual(
    REQUIRED_WEB_CHAT_RUNNER_RUNTIME_PATHS,
    STARTUP_REQUIRED_RUNTIME_PATHS,
  );
  assert.deepEqual(OPTIONAL_WEB_CHAT_RUNNER_RUNTIME_PATHS, [
    "/api/chat/runs/goal",
    "/api/chat/runs/thread-title",
    "/api/chat/runs/thread-pull-request",
    "/api/chat/runs/app-server/control",
    "/web-chat/hosted-codex-auth/invalidate",
  ]);
});

test("Codex chat runs default to the 72 hour GitHub Actions budget", () => {
  assert.equal(DEFAULT_TIMEOUT_SECONDS, 72 * 60 * 60);
});

test("hidden title pre-turn treats placeholder titles as needing runner ownership", () => {
  assert.equal(
    shouldRunHiddenThreadTitlePreturn({
      mode: "fresh",
      threadTitle: "Untitled",
      threadTitleSource: "manual",
      promptText: "Investigate unread state",
    }),
    true,
  );
  assert.equal(
    shouldRunHiddenThreadTitlePreturn({
      mode: "fresh",
      threadTitle: "Unread state bug",
      threadTitleSource: "manual",
      promptText: "Investigate unread state",
    }),
    false,
  );
  assert.equal(
    shouldRunHiddenThreadTitlePreturn({
      mode: "resume",
      threadTitle: "Untitled",
      threadTitleSource: "provisional_first_message",
      promptText: "Investigate unread state",
    }),
    false,
  );
  assert.equal(
    shouldRunHiddenThreadTitlePreturn({
      mode: "fresh",
      threadTitle: "Untitled",
      threadTitleSource: "provisional_first_message",
      promptText: "hi",
    }),
    false,
  );
  assert.equal(
    shouldRunHiddenThreadTitlePreturn({
      mode: "fresh",
      threadTitle: "Untitled",
      threadTitleSource: "provisional_first_message",
      promptText: "Fix bug",
    }),
    true,
  );
  assert.equal(
    shouldRunHiddenThreadTitlePreturn({
      mode: "fresh",
      threadTitle: "Untitled",
      threadTitleSource: "provisional_first_message",
      promptText: "Fix bug",
      executionBackend: "runner_pool",
    }),
    true,
  );
});

test("hidden title normalization rejects placeholder title outputs", () => {
  assert.equal(normalizeHiddenThreadTitle("No title"), "");
  assert.equal(normalizeHiddenThreadTitle("New chat"), "");
  assert.equal(normalizeHiddenThreadTitle("Title: Fix runner startup."), "Fix runner startup");
});

test("JSON control-plane requests fail fast instead of waiting on platform timeouts", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) =>
    new Promise((_resolve, reject) => {
      const guard = setTimeout(() => reject(new Error("fetch did not abort")), 1000);
      init.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(guard);
          reject(init.signal.reason || new Error("aborted"));
        },
        { once: true },
      );
    });

  try {
    await assert.rejects(
      fetchJson("https://example.test/web-chat/codex-session/get", {
        method: "GET",
        timeoutMs: 5,
      }),
      /JSON request timed out after 5ms/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex session contents reads use a longer bounded JSON timeout", async () => {
  const source = await fs.readFile(
    path.join(process.cwd(), "scripts/web-chat-runner.mjs"),
    "utf8",
  );

  assert.match(source, /const CODEX_SESSION_CONTENTS_FETCH_JSON_TIMEOUT_MS = 60_000;/);
  assert.match(
    source,
    /timeoutMs:\s*includeContents\s*\?\s*CODEX_SESSION_CONTENTS_FETCH_JSON_TIMEOUT_MS\s*:\s*undefined/,
  );
});

test("failed web chat run callbacks can read workspace preparation metadata", async () => {
  const source = await fs.readFile(
    path.join(process.cwd(), "scripts/web-chat-runner.mjs"),
    "utf8",
  );
  const mainStart = source.indexOf("async function main() {");
  const exportStart = source.indexOf("\nexport {", mainStart);
  assert.notEqual(mainStart, -1);
  assert.notEqual(exportStart, -1);
  const mainSource = source.slice(mainStart, exportStart);

  assert.match(
    mainSource,
    /let workspacePreparationRunMetadata = \{\};[\s\S]*try \{\s*while \(true\)/,
  );
  assert.match(
    mainSource,
    /preparedWorkspace = null;\s+workspacePreparationRunMetadata = \{\};/,
  );
  assert.match(
    mainSource,
    /workspacePreparationRunMetadata = buildWorkspacePreparationRunMetadata\(\{/,
  );
  assert.doesNotMatch(mainSource, /const workspacePreparationRunMetadata\s*=/);
  assert.match(
    mainSource,
    /status: "failed",[\s\S]*metadata: buildCodexRunMetadata\(\{[\s\S]*extra: \{[\s\S]*\.\.\.workspacePreparationRunMetadata/,
  );
});

test("AppServer live bridge uses Firestore instead of runner HTTP polling", async () => {
  const source = await fs.readFile(
    path.join(process.cwd(), "scripts/web-chat-runner.mjs"),
    "utf8",
  );
  const readme = await fs.readFile(path.join(process.cwd(), "README.md"), "utf8");
  const runtimeContract = await fs.readFile(
    path.join(process.cwd(), "lib/web-chat-runner-runtime-contract.mjs"),
    "utf8",
  );
  const bridgeSource = source.slice(
    source.indexOf("async function createAppServerFirestoreBridge"),
    source.indexOf("async function runCodexAppServer"),
  );

  assert.match(readme, /Do not add timer-driven runner HTTP polling/);
  assert.match(readme, /very large infrastructure bills/);
  assert.match(
    runtimeContract,
    /Do not add the legacy AppServer event or\s+\/\/ control HTTP routes back/,
  );
  assert.match(source, /The bridge owns the AppServer live-cost boundary/);
  assert.match(source, /APP_SERVER_FIRESTORE_SESSION_PATH/);
  assert.match(source, /APP_SERVER_PROGRESS_HISTORY_PATH/);
  assert.match(source, /APP_SERVER_CONTROL_PATH/);
  assert.match(source, /fetchPendingAppServerControlRequests/);
  assert.match(source, /runner_app_server_final_continuation_restart/);
  const mainSource = source.slice(
    source.indexOf("async function main() {"),
    source.indexOf("\nexport {"),
  );
  const finalCheckpointIndex = mainSource.indexOf(
    "pendingFinalContinuationRequests = await fetchPendingAppServerControlRequests",
  );
  const terminalAssistantMessageIndex = mainSource.indexOf(
    "assistantMessage = workspaceRescueMetadata",
    finalCheckpointIndex,
  );
  assert.notEqual(finalCheckpointIndex, -1);
  assert.notEqual(terminalAssistantMessageIndex, -1);
  assert.ok(finalCheckpointIndex < terminalAssistantMessageIndex);
  assert.match(
    mainSource,
    /runner_app_server_final_continuation_restart[\s\S]{0,2500}status: "running"[\s\S]{0,2500}continue;/,
  );
  assert.match(source, /history_only:\s*true/);
  assert.match(source, /supportsAppServerProgressHistory/);
  assert.match(source, /progressHistoryEnabled/);
  assert.match(source, /app_server_firestore_control_listener_failed/);
  assert.match(source, /reportRunnerDiagnostic/);
  assert.match(bridgeSource, /import\("firebase\/firestore"\)/);
  assert.match(bridgeSource, /\bonSnapshot\b/);
  assert.match(bridgeSource, /\bterminate\(firestore\)/);
  assert.match(source, /firestoreBridge\.close\(\)/);
  assert.doesNotMatch(source, /APP_SERVER_PROGRESS_MAX_LABEL_CHARS/);
  assert.doesNotMatch(
    source,
    /normalizedMethod\s*===\s*["']item\/agentMessage\/delta["'][\s\S]{0,900}\bprogressReporter\.enqueue\s*\(/,
  );
  assert.doesNotMatch(source, /function createAppServerControlPoller/);
  assert.doesNotMatch(source, /setInterval[\s\S]{0,700}APP_SERVER_CONTROL_PATH/);
  assert.doesNotMatch(source, /\bsetInterval\s*\(/);
});

test("web chat run markers prove captured Codex sessions contain the current run", () => {
  const marker = buildWebChatRunMarker({
    threadId: "wct_123",
    runId: "wcr_456",
  });
  const otherMarker = buildWebChatRunMarker({
    threadId: "wct_123",
    runId: "wcr_789",
  });
  const prompt = appendWebChatRunMarkerToPrompt({
    prompt: "Fix the failing runner.",
    marker,
  });

  assert.match(marker, /^codeq8-run-marker:v1:[0-9a-f]{16}$/);
  assert.match(prompt, /do not mention in the reply/);
  assert.equal(
    sessionContainsWebChatRunMarker({
      sessionFileContents: prompt,
      marker,
    }),
    true,
  );
  assert.equal(
    sessionContainsWebChatRunMarker({
      sessionFileContents: prompt,
      marker: otherMarker,
    }),
    false,
  );
});

test("Codex session continuity guidance keeps rollover prompts bounded", () => {
  const prompt = applyCodexSessionContinuityGuidance({
    prompt: "User message:\nContinue the task.",
    continuityWarning:
      "Starting a fresh Codex session because the persisted session bundle is 104857600 compressed bytes.",
  });

  assert.match(prompt, /^Codeq8 session continuity:/);
  assert.match(
    prompt,
    /Continue seamlessly from the injected Codeq8 thread context/,
  );
  assert.match(prompt, /current thread goal/);
  assert.match(
    prompt,
    /Do not try to recover, download, or inspect the oversized persisted Codex session bundle/,
  );
  assert.match(prompt, /User message:\nContinue the task\./);
});

test("oversized Codex session state rolls over before reading bundle contents", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const diagnostics = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || "GET" });
    throw new Error("oversized rollover must not fetch session contents");
  };

  try {
    const result = await loadCodexSessionStateForExecution({
      workerUrl: "https://worker.example.com",
      adminToken: "secret",
      threadId: "wct_oversized",
      runId: "wcr_rollover",
      thread: {
        thread_id: "wct_oversized",
        codex_goal_state: {
          objective: "Keep the rollover goal durable",
          status: "active",
          token_budget: 12000,
          tokens_used: 600,
          time_used_seconds: 90,
          created_at: 1_000,
          updated_at: 2_000,
        },
        codex_session_state: {
          status: "ready",
          session_id: "019dd643-e3ec-76e1-952c-3dc25053e8c3",
          session_file_relative_path:
            "sessions/2026/05/02/rollout-2026-05-02T01-06-49-019dd643-e3ec-76e1-952c-3dc25053e8c3.jsonl",
          bundle_storage_key: "web_chat_codex_session_blob:wct_oversized:17:nonce",
          storage_bucket: "bucket",
          storage_backend: "firebase_storage",
          bundle_revision: 17,
          bundle_size_bytes: 200 * 1024 * 1024,
          bundle_compressed_size_bytes: 50 * 1024 * 1024,
          last_run_id: "wcr_previous",
        },
      },
      reportRunnerDiagnostic: async (diagnostic) => {
        diagnostics.push(diagnostic);
        return { ok: true };
      },
    });

    assert.deepEqual(calls, []);
    assert.equal(result.codexSessionState.status, "missing");
    assert.equal(result.codexSessionState.bundle_revision, 17);
    assert.equal(result.loadedCodexSession.sessionFileContents, "");
    assert.equal(
      result.loadedCodexSession.thread.codex_goal_state.objective,
      "Keep the rollover goal durable",
    );
    assert.equal(result.expectedBundleRevision, 17);
    assert.match(result.continuityWarning, /fresh Codex session/);
    assert.equal(
      diagnostics.some(
        (diagnostic) => diagnostic.event === "runner_session_state_load_started",
      ),
      true,
    );
    assert.equal(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.event === "runner_session_size_rollover_selected" &&
          diagnostic.mode === "fresh" &&
          diagnostic.details?.limit_bytes === 50 * 1024 * 1024,
      ),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex session capture uses the expected App Server session id", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-capture-"));
  const expectedSessionId = "019dd643-e3ec-76e1-952c-3dc25053e8c3";
  const newerWrongSessionId = "019e52e9-de09-7580-9e63-ba6c89381476";

  async function writeSession(sessionId, relativePath, mtime) {
    const sessionFilePath = path.join(codexHome, relativePath);
    await fs.mkdir(path.dirname(sessionFilePath), { recursive: true });
    await fs.writeFile(
      sessionFilePath,
      [
        JSON.stringify({
          timestamp: "2026-05-02T01:06:49.000Z",
          type: "session_meta",
          payload: {
            id: sessionId,
            cli_version: "0.133.0",
            model: "gpt-5.5",
          },
        }),
        `session ${sessionId}`,
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.utimes(sessionFilePath, mtime, mtime);
  }

  try {
    await writeSession(
      expectedSessionId,
      `sessions/2026/05/02/rollout-2026-05-02T01-06-49-${expectedSessionId}.jsonl`,
      new Date("2026-05-02T01:06:49.000Z"),
    );
    await writeSession(
      newerWrongSessionId,
      `sessions/2026/05/22/rollout-2026-05-22T20-38-39-${newerWrongSessionId}.jsonl`,
      new Date("2026-05-23T03:42:04.000Z"),
    );

    const captured = await captureCodexSessionBundle({
      codexHome,
      existingSessionState: {},
      model: "gpt-5.5",
      expectedSessionId,
    });

    assert.equal(captured.sessionId, expectedSessionId);
    assert.match(captured.sessionFileRelativePath, new RegExp(expectedSessionId));
    await assert.rejects(
      captureCodexSessionBundle({
        codexHome,
        existingSessionState: {},
        model: "gpt-5.5",
        expectedSessionId: "019fffffffffffffffffffffffffffff",
      }),
      /expected session bundle/i,
    );
  } finally {
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});

test("buildCodexRunMetadata advertises AppServer attachment steering support", () => {
  const metadata = buildCodexRunMetadata({
    model: "gpt-5.5",
    mode: "fresh",
  });

  assert.deepEqual(metadata.app_server_control_capabilities, [
    "codex_app_server_attachment_turn_control",
  ]);
});

test("buildCodexRunMetadata preserves final AppServer control statuses", () => {
  const metadata = buildCodexRunMetadata({
    model: "gpt-5.5",
    mode: "fresh",
    appServerControlRequests: [
      {
        request_id: "wcasr_accepted",
        sequence: 1,
        kind: "steer",
        content: "Delivered follow-up",
        attachments: [],
        message_id: "wcm_followup",
        status: "accepted",
        error: "",
        requested_by_github_login: "aalzanki",
        requested_at: 1000,
        acknowledged_at: 2000,
      },
    ],
  });

  assert.equal(metadata.app_server.transport, "app-server");
  assert.equal(
    metadata.app_server.control.requests[0].request_id,
    "wcasr_accepted",
  );
  assert.equal(metadata.app_server.control.requests[0].status, "accepted");
  assert.equal(metadata.app_server.control.requests[0].message_id, "wcm_followup");
});

test("runner diagnostic requests redact secrets before posting", async () => {
  const diagnostic = buildWebChatRunnerDiagnosticRequest({
    event: "runner_session_marker_missing",
    failureClass: "runner_session_marker_missing",
    severity: "warning",
    ok: false,
    mode: "resume",
    workspaceRepository: "Codeq8/Codeq8",
    threadId: "wct_123",
    runId: "wcr_456",
    messageId: "wcm_789",
    details: {
      authorization: "Bearer header.payload.signature",
      github_token: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      nested: {
        password: "super-secret",
        message: "safe context",
      },
    },
  });

  assert.equal(diagnostic.source, "web_chat_runner_diagnostic");
  assert.equal(diagnostic.failure_class, "runner_session_marker_missing");
  assert.equal(diagnostic.ok, false);
  assert.equal(diagnostic.details.authorization, "[redacted]");
  assert.equal(diagnostic.details.github_token, "[redacted]");
  assert.equal(diagnostic.details.nested.password, "[redacted]");
  assert.equal(diagnostic.details.nested.message, "safe context");

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method || "GET",
      authorization: String(init?.headers?.Authorization || ""),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json(
      {
        ok: true,
        report: {
          ok: true,
          status: 202,
        },
      },
      { status: 202 },
    );
  };

  try {
    const result = await postWebChatRunnerDiagnostic({
      publicBaseUrl: "https://codeq8.example.com",
      webChatRunToken: "header.payload.signature",
      diagnostic,
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://codeq8.example.com/api/chat/runs/diagnostic");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.authorization, "Bearer header.payload.signature");
    assert.equal(calls[0]?.body?.details?.authorization, "[redacted]");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postAppServerProgressHistoryBatch sends bounded history-only event chunks", async () => {
  const calls = [];
  const result = await postAppServerProgressHistoryBatch({
    publicBaseUrl: "https://codeq8.example.com",
    webChatRunToken: "header.payload.signature",
    workspaceRepository: "Codeq8/Codeq8",
    threadId: "wct_history",
    runId: "wcr_history",
    events: Array.from({ length: 12 }, (_, index) => ({
      event_id: `event_${index}`,
      kind: "item",
      item_type: "assistant_reasoning",
      label: `Reasoning ${index}`,
      status: "completed",
      at: 1_700_000_000_000 + index,
    })),
    fetchImpl: async (url, init = {}) => {
      calls.push({
        url: String(url),
        authorization: String(init.headers?.Authorization || ""),
        body: JSON.parse(String(init.body || "{}")),
      });
      return Response.json({ ok: true }, { status: 200 });
    },
  });

  assert.deepEqual(result, { eventCount: 12, ok: true, requestCount: 2 });
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0]?.url,
    "https://codeq8.example.com/api/chat/runs/app-server/events",
  );
  assert.equal(calls[0]?.authorization, "Bearer header.payload.signature");
  assert.equal(calls[0]?.body?.history_only, true);
  assert.equal(calls[0]?.body?.events.length, 10);
  assert.equal(calls[1]?.body?.events.length, 2);
  assert.equal(calls[1]?.body?.thread_id, "wct_history");
  assert.equal(calls[1]?.body?.run_id, "wcr_history");
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

test("buildFinalWorkspaceStateCallbackPayload serializes final branch state", () => {
  assert.deepEqual(
    buildFinalWorkspaceStateCallbackPayload({
      branch: "refs/heads/codex/final-target",
      headCommitSha: "abc123",
      hasWorkingTreeChanges: false,
      hasRemoteBranch: true,
      aheadCount: 2,
    }),
    {
      branch: "codex/final-target",
      head_sha: "abc123",
      has_working_tree_changes: false,
      has_remote_branch: true,
      ahead_count: 2,
      detached: false,
    },
  );
  assert.equal(buildFinalWorkspaceStateCallbackPayload({ branch: "HEAD" }), null);
});

test("runCodex applies dedicated Node options only to the Codex process env", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-node-options-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  const envOutputPath = path.join(workspacePath, "node-options.txt");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await writeFakeCodexAppServer(fakeCodexPath, {
    envOutputPath,
    agentMessage: "env ok",
  });

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
  assert.equal(result.output, "env ok");
  assert.equal(await fs.readFile(envOutputPath, "utf8"), "--no-warnings");
  assert.equal(commandEnv.NODE_OPTIONS, "");
});

test("resolveCodexPath uses the runner machine PATH before Codeq8-managed npm tools", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-path-"));
  const machineBinPath = path.join(workspacePath, "machine-bin");
  const managedBinPath = path.join(workspacePath, "managed-bin");
  const machineCodexPath = path.join(machineBinPath, "codex");
  const managedCodexPath = path.join(managedBinPath, "codex");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await fs.mkdir(machineBinPath, { recursive: true });
  await fs.mkdir(managedBinPath, { recursive: true });
  await fs.writeFile(machineCodexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(managedCodexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const resolved = await resolveCodexPath({
    ...process.env,
    CODEX_PATH: "",
    CODEQ8_MACHINE_PATH: machineBinPath,
    PATH: `${managedBinPath}:${machineBinPath}:${process.env.PATH || ""}`,
  });

  assert.equal(resolved, machineCodexPath);
});

test("runCodex allows Git metadata writes without approval prompts", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-sandbox-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  const argsOutputPath = path.join(workspacePath, "codex-args.json");
  const requestsOutputPath = path.join(workspacePath, "codex-requests.json");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await writeFakeCodexAppServer(fakeCodexPath, {
    argsOutputPath,
    requestsOutputPath,
    agentMessage: "sandbox ok",
  });

  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "stay sandboxed",
    workspacePath,
    commandEnv: process.env,
    timeoutSeconds: 30,
  });

  assert.equal(result.ok, true);
  const args = JSON.parse(await fs.readFile(argsOutputPath, "utf8"));
  assert.deepEqual(args, ["app-server", "--listen", "stdio://"]);
  assert.equal(args.includes("--yolo"), false);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  const requests = JSON.parse(await fs.readFile(requestsOutputPath, "utf8"));
  const threadStart = requests.find((request) => request.method === "thread/start");
  const turnStart = requests.find((request) => request.method === "turn/start");

  assert.equal(threadStart?.params?.approvalPolicy, "never");
  assert.equal(threadStart?.params?.sandbox, "danger-full-access");
  assert.equal(turnStart?.params?.approvalPolicy, "never");
  assert.deepEqual(turnStart?.params?.sandboxPolicy, { type: "dangerFullAccess" });
});

test("runCodex can drive codex app-server over stdio and report bounded progress", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-app-server-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  const argsOutputPath = path.join(workspacePath, "codex-args.json");
  const longProgressUpdate = `Progress update 4. ${"Detailed active-run status ".repeat(18)}`.trim();
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs/promises';",
      "import readline from 'node:readline';",
      `await fs.writeFile(${JSON.stringify(argsOutputPath)}, JSON.stringify(process.argv.slice(2)), "utf8");`,
      `const longProgressUpdate = ${JSON.stringify(longProgressUpdate)};`,
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "rl.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });",
      "  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_app' } } });",
      "  if (message.method === 'turn/start') {",
      "    send({ id: message.id, result: { turn: { id: 'turn_app', status: 'inProgress' } } });",
      "    send({ method: 'item/started', params: { item: { type: 'command_execution', command: 'npm test' } } });",
      "    for (let index = 1; index <= 10; index += 1) {",
      "      const text = index === 4 ? longProgressUpdate : `Progress update ${index}.`;",
      "      send({ method: 'item/started', params: { item: { id: `msg_${index}`, type: 'agent_message' } } });",
      "      send({ method: 'item/agentMessage/delta', params: { item_id: `msg_${index}`, delta: text } });",
      "      send({ method: 'item/completed', params: { item: { id: `msg_${index}`, type: 'agent_message', text } } });",
      "    }",
      "    send({ method: 'item/completed', params: { item: { type: 'command_execution', command: 'npm test' } } });",
      "    send({ method: 'turn/completed', params: { turn: { id: 'turn_app', status: 'completed' } } });",
      "  }",
      "});",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const progressEvents = [];
  let bridgeCloseCount = 0;
  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "use app server",
    workspacePath,
    commandEnv: {
      ...process.env,
    },
    timeoutSeconds: 30,
    appServerContext: {
      publicBaseUrl: "https://codeq8.example",
      webChatRunToken: "runner_token",
      workspaceRepository: "Codeq8/Codeq8",
      threadId: "wct_app",
      runId: "wcr_app",
      createAppServerFirestoreBridgeImpl: async () => ({
        progressReporter: {
          enqueue(event) {
            if (progressEvents.length < 8) {
              progressEvents.push(event);
            }
          },
          flush: async () => {},
        },
        createControlListener: () => ({
          start: () => {},
          stop: async () => {},
        }),
        close: async () => {
          bridgeCloseCount += 1;
        },
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "Progress update 10.");
  assert.equal(result.sessionId, "thr_app");
  const args = JSON.parse(await fs.readFile(argsOutputPath, "utf8"));
  assert.deepEqual(args, ["app-server", "--listen", "stdio://"]);
  assert.equal(progressEvents.length, 8);
  assert.deepEqual(
    progressEvents.map((event) => event.label),
    Array.from({ length: 8 }, (_, index) =>
      index === 3 ? longProgressUpdate : `Progress update ${index + 1}.`,
    ),
  );
  assert(longProgressUpdate.length > 280);
  assert.equal(progressEvents[3]?.label, longProgressUpdate);
  assert.equal(
    progressEvents.some((event) => String(event.item_type || "").includes("command")),
    false,
  );
  assert.equal(bridgeCloseCount, 1);
});

test("runCodex preserves AppServer usage-limit failures as the terminal reason", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-usage-limit-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "let goal = null;",
      "rl.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });",
      "  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_app' } } });",
      "  if (message.method === 'thread/goal/set') {",
      "    goal = { objective: message.params?.objective || 'ship fix', status: 'active' };",
      "    send({ id: message.id, result: { goal } });",
      "  }",
      "  if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal } });",
      "  if (message.method === 'turn/start') {",
      "    send({ id: message.id, result: { turn: { id: 'turn_app', status: 'inProgress' } } });",
      "    goal = { objective: 'ship fix', status: 'usageLimited' };",
      "    send({ method: 'thread/goal/updated', params: { goal } });",
      "    send({ method: 'account/rateLimits/updated', params: { status: 'usageLimited' } });",
      "    send({ method: 'error', params: { code: 'usageLimited', message: 'usage limit reached' } });",
      "    send({ method: 'turn/completed', params: { turn: { id: 'turn_app', status: 'failed' } } });",
      "  }",
      "});",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "use app server",
    workspacePath,
    commandEnv: process.env,
    timeoutSeconds: 30,
    codexThreadGoalsEnabled: true,
    codexGoalState: {
      objective: "ship fix",
      status: "active",
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Codex account on this runner has reached its usage limit/);
  assert.doesNotMatch(result.reason, /turn completed with status failed/i);
  assert.equal(result.codexGoalState.status, "usageLimited");
});

test("runCodex reports AppServer Firestore session HTTP failure details", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-app-server-session-http-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await writeFakeCodexAppServer(fakeCodexPath, {
    agentMessage: "session http degraded",
  });

  const sessionRequests = [];
  const diagnostics = [];
  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "use app server with degraded session",
    workspacePath,
    commandEnv: process.env,
    timeoutSeconds: 30,
    appServerContext: {
      publicBaseUrl: "https://codeq8.example",
      webChatRunToken: "header.payload.signature",
      workspaceRepository: "Codeq8/Codeq8",
      threadId: "wct_app",
      runId: "wcr_app",
      fetchImpl: async (url, init = {}) => {
        sessionRequests.push({
          url: String(url),
          body: init.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json(
          {
            ok: false,
            error: "Run is not using Codex AppServer control.",
          },
          { status: 409 },
        );
      },
      reportRunnerDiagnostic: async (diagnostic) => {
        diagnostics.push(diagnostic);
        return { ok: true };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "session http degraded");
  assert.equal(sessionRequests.length, 1);
  assert.equal(
    sessionRequests[0]?.url,
    "https://codeq8.example/api/chat/runs/app-server/firebase-session",
  );
  assert.deepEqual(sessionRequests[0]?.body, {
    workspace_repository: "Codeq8/Codeq8",
    thread_id: "wct_app",
    run_id: "wcr_app",
  });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.event, "app_server_firestore_session_unavailable");
  assert.equal(diagnostics[0]?.failureClass, "app_server_firestore_session_unavailable");
  assert.equal(diagnostics[0]?.details?.reason, "session_bootstrap_http_failed");
  assert.equal(diagnostics[0]?.details?.status, 409);
  assert.equal(diagnostics[0]?.details?.response_ok, false);
  assert.equal(
    diagnostics[0]?.details?.response_error,
    "Run is not using Codex AppServer control.",
  );
  assert.equal(diagnostics[0]?.details?.payload_ok, false);
});

test("runCodex reports invalid AppServer Firestore session payload fields", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-app-server-session-invalid-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await writeFakeCodexAppServer(fakeCodexPath, {
    agentMessage: "session payload degraded",
  });

  const diagnostics = [];
  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "use app server with invalid session payload",
    workspacePath,
    commandEnv: process.env,
    timeoutSeconds: 30,
    appServerContext: {
      publicBaseUrl: "https://codeq8.example",
      webChatRunToken: "header.payload.signature",
      workspaceRepository: "Codeq8/Codeq8",
      threadId: "wct_app",
      runId: "wcr_app",
      fetchImpl: async () =>
        Response.json({
          ok: true,
          firebase_auth: {
            ok: true,
          },
          firebase_config: {
            apiKey: "api-key",
          },
          channel: {
            thread_id: "wct_app",
            run_id: "wcr_app",
          },
        }),
      reportRunnerDiagnostic: async (diagnostic) => {
        diagnostics.push(diagnostic);
        return { ok: true };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "session payload degraded");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.details?.reason, "session_bootstrap_invalid_response");
  assert.equal(diagnostics[0]?.details?.status, 200);
  assert.equal(diagnostics[0]?.details?.response_ok, true);
  assert.equal(diagnostics[0]?.details?.payload_ok, true);
  assert.equal(diagnostics[0]?.details?.firebase_auth_ok, true);
  assert.deepEqual(diagnostics[0]?.details?.missing_fields, [
    "firebase_auth.firebase_custom_token",
    "firebase_config.projectId",
    "channel.document_id",
  ]);
});

test("AppServer Actions reasoning transcript renders ordered sanitized bounded groups", () => {
  const githubToken = `ghp_${"A".repeat(36)}`;
  const messageText = [
    `Assistant message with ${githubToken}`,
    "::warning::not a workflow command",
    "cookie=session_cookie_value",
  ].join("\n");
  const transcript = createAppServerActionsReasoningTranscript({
    maxItems: 2,
    maxItemChars: 500,
    maxTotalChars: 1000,
    chunkChars: 1000,
  });

  transcript.recordNotification("item/started", {
    item: {
      id: "reason-1",
      type: "assistant_reasoning",
      text: "Inspecting token=secret_progress_token",
    },
  });
  transcript.recordNotification("item/completed", {
    item: {
      id: "reason-1",
      type: "assistant_reasoning",
      text: "Inspecting token=secret_progress_token",
    },
  });
  transcript.recordNotification("item/started", {
    item: { id: "msg-1", type: "agent_message" },
  });
  transcript.recordNotification("item/agentMessage/delta", {
    item_id: "msg-1",
    delta: messageText,
  });
  transcript.recordNotification("item/completed", {
    item: { id: "msg-1", type: "agent_message", text: messageText },
  });
  transcript.recordNotification("item/started", {
    item: {
      id: "cmd-1",
      type: "command_execution",
      text: "npm test token=command_secret",
    },
  });
  transcript.recordNotification("item/started", {
    item: {
      id: "reason-2",
      type: "agent_reasoning",
      text: "This reasoning item is omitted by the maxItems guard.",
    },
  });

  const rendered = transcript.render().join("\n");
  assert.match(rendered, /^::group::Codeq8 AppServer reasoning transcript/m);
  assert.match(rendered, /items=2/);
  assert.match(rendered, /omitted_items=1/);
  assert.match(rendered, /\[1\] assistant_reasoning \| status=completed/);
  assert.match(rendered, /\[2\] agent_message \| status=completed/);
  assert(rendered.indexOf("[1] assistant_reasoning") < rendered.indexOf("[2] agent_message"));
  assert.equal((rendered.match(/Inspecting token=\[redacted\]/g) || []).length, 1);
  assert.match(rendered, /\[redacted_github_token\]/);
  assert.match(rendered, /cookie=\[redacted\]/);
  assert.match(rendered, /^    ::warning::not a workflow command$/m);
  assert.doesNotMatch(rendered, /^::warning::/m);
  assert.doesNotMatch(rendered, /secret_progress_token|session_cookie_value|command_secret|ghp_A/);
  assert.doesNotMatch(rendered, /command_execution|npm test/);

  const boundedTranscript = createAppServerActionsReasoningTranscript({
    maxItems: 1,
    maxItemChars: 24,
    maxTotalChars: 24,
    chunkChars: 1000,
  });
  boundedTranscript.recordNotification("item/started", {
    item: {
      id: "long-reason",
      type: "assistant_reasoning",
      text: "A".repeat(60),
    },
  });

  const boundedRendered = boundedTranscript.render().join("\n");
  assert.match(boundedRendered, /truncated=true/);
  assert.match(boundedRendered, /omitted_chars=36/);
});

test("runCodex writes a clean AppServer reasoning transcript to Actions logs", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-app-server-reasoning-log-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "rl.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });",
      "  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_app' } } });",
      "  if (message.method === 'turn/start') {",
      "    send({ id: message.id, result: { turn: { id: 'turn_app', status: 'inProgress' } } });",
      "    send({ method: 'item/started', params: { item: { id: 'reason_1', type: 'assistant_reasoning', text: 'Checking token=secret_reasoning_token' } } });",
      "    send({ method: 'item/completed', params: { item: { id: 'reason_1', type: 'assistant_reasoning', text: 'Checking token=secret_reasoning_token' } } });",
      "    send({ method: 'item/started', params: { item: { id: 'cmd_1', type: 'command_execution', command: 'npm test' } } });",
      "    send({ method: 'item/started', params: { item: { id: 'msg_1', type: 'agent_message' } } });",
      "    send({ method: 'item/agentMessage/delta', params: { item_id: 'msg_1', delta: 'Ready with cookie=session_cookie_secret' } });",
      "    send({ method: 'item/completed', params: { item: { id: 'msg_1', type: 'agent_message', text: 'Ready with cookie=session_cookie_secret' } } });",
      "    send({ method: 'item/completed', params: { item: { id: 'cmd_1', type: 'command_execution', command: 'npm test' } } });",
      "    send({ method: 'turn/completed', params: { turn: { id: 'turn_app', status: 'completed' } } });",
      "  }",
      "});",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const output = await captureRunnerOutput(() =>
    runCodex({
      codexPath: fakeCodexPath,
      model: "gpt-5.5",
      task: "log reasoning cleanly",
      workspacePath,
      commandEnv: process.env,
      timeoutSeconds: 30,
    }),
  );

  assert.equal(output.result.ok, true);
  assert.match(output.logs, /^::group::Codeq8 AppServer reasoning transcript/m);
  assert.match(output.logs, /\[1\] assistant_reasoning \| status=completed/);
  assert.match(output.logs, /\[2\] agent_message \| status=completed/);
  assert.equal((output.logs.match(/Checking token=\[redacted\]/g) || []).length, 1);
  assert.match(output.logs, /Ready with cookie=\[redacted\]/);
  assert.match(output.logs, /Codex app-server requests summarized/);
  assert.doesNotMatch(output.logs, /secret_reasoning_token|session_cookie_secret/);
  assert.doesNotMatch(output.logs, /Codex app-server request sent/);
  assert.doesNotMatch(output.logs, /Codex app-server request completed/);
  assert.doesNotMatch(output.logs, /command_execution \| status/);
});

test("runCodex forwards AppServer reasoning items to durable progress", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-app-server-reasoning-progress-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "rl.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });",
      "  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_app' } } });",
      "  if (message.method === 'turn/start') {",
      "    send({ id: message.id, result: { turn: { id: 'turn_app', status: 'inProgress' } } });",
      "    for (let index = 1; index <= 12; index += 1) {",
      "      send({ method: 'item/started', params: { item: { id: `reason_${index}`, type: 'assistant_reasoning', text: `Reasoning block ${index}` } } });",
      "      send({ method: 'item/completed', params: { item: { id: `reason_${index}`, type: 'assistant_reasoning', text: `Reasoning block ${index}` } } });",
      "    }",
      "    send({ method: 'item/started', params: { item: { id: 'msg_done', type: 'agent_message' } } });",
      "    send({ method: 'item/agentMessage/delta', params: { item_id: 'msg_done', delta: 'done' } });",
      "    send({ method: 'item/completed', params: { item: { id: 'msg_done', type: 'agent_message', text: 'done' } } });",
      "    send({ method: 'turn/completed', params: { turn: { id: 'turn_app', status: 'completed' } } });",
      "  }",
      "});",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const progressEvents = [];
  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "persist reasoning progress",
    workspacePath,
    commandEnv: process.env,
    timeoutSeconds: 30,
    appServerContext: {
      publicBaseUrl: "https://codeq8.example",
      webChatRunToken: "runner_token",
      workspaceRepository: "Codeq8/Codeq8",
      threadId: "wct_app",
      runId: "wcr_app",
      createAppServerFirestoreBridgeImpl: async () => ({
        progressReporter: {
          enqueue(event) {
            progressEvents.push(event);
          },
          flush: async () => {},
        },
        createControlListener: () => ({
          start: () => {},
          stop: async () => {},
        }),
        close: async () => {},
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "done");
  const reasoningEvents = progressEvents.filter(
    (event) => event.item_type === "assistant_reasoning",
  );
  assert.equal(reasoningEvents.length, 12);
  assert.deepEqual(
    reasoningEvents.map((event) => event.label),
    Array.from({ length: 12 }, (_value, index) => `Reasoning block ${index + 1}`),
  );
  assert(
    reasoningEvents.every((event) =>
      /^app_server:reasoning:[a-f0-9]+$/.test(String(event.event_id || "")),
    ),
  );
  assert(
    reasoningEvents.every((event) =>
      !String(event.event_id || "").startsWith("app_server:agent_message:"),
    ),
  );
  assert.equal(
    progressEvents.filter((event) => event.item_type === "agent_message").length,
    0,
  );
});

test("runCodex forwards AppServer agent-message progress fragments without final answer", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-app-server-agent-progress-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "rl.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });",
      "  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_app' } } });",
      "  if (message.method === 'turn/start') {",
      "    send({ id: message.id, result: { turn: { id: 'turn_app', status: 'inProgress' } } });",
      "    send({ method: 'item/started', params: { item: { id: 'msg_progress_1', type: 'agent_message' } } });",
      "    send({ method: 'item/agentMessage/delta', params: { item_id: 'msg_progress_1', delta: 'Inspecting the route.' } });",
      "    send({ method: 'item/started', params: { item: { id: 'msg_progress_2', type: 'agent_message' } } });",
      "    send({ method: 'item/agentMessage/delta', params: { item_id: 'msg_progress_2', delta: 'Checking the store.' } });",
      "    send({ method: 'item/started', params: { item: { id: 'msg_final', type: 'agent_message' } } });",
      "    send({ method: 'item/agentMessage/delta', params: { item_id: 'msg_final', delta: 'Done.' } });",
      "    send({ method: 'turn/completed', params: { turn: { id: 'turn_app', status: 'completed' } } });",
      "  }",
      "});",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const progressEvents = [];
  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "persist agent progress",
    workspacePath,
    commandEnv: process.env,
    timeoutSeconds: 30,
    appServerContext: {
      publicBaseUrl: "https://codeq8.example",
      webChatRunToken: "runner_token",
      workspaceRepository: "Codeq8/Codeq8",
      threadId: "wct_app",
      runId: "wcr_app",
      createAppServerFirestoreBridgeImpl: async () => ({
        progressReporter: {
          enqueue(event) {
            progressEvents.push(event);
          },
          flush: async () => {},
        },
        createControlListener: () => ({
          start: () => {},
          stop: async () => {},
        }),
        close: async () => {},
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "Done.");
  const agentProgressEvents = progressEvents.filter(
    (event) => event.item_type === "agent_message_progress",
  );
  assert.deepEqual(
    agentProgressEvents.map((event) => event.label),
    ["Inspecting the route.", "Checking the store."],
  );
  assert(
    agentProgressEvents.every((event) =>
      /^app_server:agent_message_progress:[a-f0-9]+$/.test(
        String(event.event_id || ""),
      ),
    ),
  );
  assert.equal(
    progressEvents.some((event) => event.label === "Done."),
    false,
  );
});

test("runCodex summarizes AppServer chatter and suppresses successful stderr", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-app-server-logs-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "import readline from 'node:readline';",
      "console.error('ERROR codex_core::tools::router: transient tool failure');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "rl.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });",
      "  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_app' } } });",
      "  if (message.method === 'turn/start') {",
      "    send({ id: message.id, result: { turn: { id: 'turn_app', status: 'inProgress' } } });",
      "    send({ method: 'thread/status/changed', params: { status: 'running' } });",
      "    send({ method: 'item/started', params: { item: { type: 'command_execution', command: 'npm test' } } });",
      "    for (let index = 0; index < 5; index += 1) send({ method: 'item/agentMessage/delta', params: { delta: 'ok' } });",
      "    send({ method: 'item/completed', params: { item: { type: 'command_execution', command: 'npm test' } } });",
      "    send({ method: 'turn/completed', params: { turn: { id: 'turn_app', status: 'completed' } } });",
      "  }",
      "});",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const output = await captureRunnerOutput(() =>
    runCodex({
      codexPath: fakeCodexPath,
      model: "gpt-5.5",
      task: "use app server quietly",
      workspacePath,
      commandEnv: process.env,
      timeoutSeconds: 30,
    }),
  );

  assert.equal(output.result.ok, true);
  assert.equal(output.stderr, "");
  assert.doesNotMatch(output.logs, /transient tool failure/);
  assert.doesNotMatch(output.logs, /method=item\/agentMessage\/delta/);
  assert.doesNotMatch(output.logs, /method=item\/started/);
  assert.match(output.logs, /Codex app-server notifications summarized/);
  assert.match(output.logs, /agent_message_deltas=5/);
  assert.doesNotMatch(output.logs, /item\/agentMessage\/delta=5/);
  assert.match(output.logs, /Codex app-server stderr captured \| chars=\d+/);
});

test("runCodex sends AppServer steer requests with the active expected turn id", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-app-server-steer-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  const requestsOutputPath = path.join(workspacePath, "codex-requests.json");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await writeFakeCodexAppServer(fakeCodexPath, {
    requestsOutputPath,
    agentMessage: "steered ok",
    delayTurnCompletionMs: 2200,
  });

  const acknowledgementBodies = [];
  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "use app server steering",
    workspacePath,
    commandEnv: {
      ...process.env,
    },
    timeoutSeconds: 30,
    appServerContext: {
      publicBaseUrl: "https://codeq8.example",
      webChatRunToken: "runner_token",
      workspaceRepository: "Codeq8/Codeq8",
      threadId: "wct_app",
      runId: "wcr_app",
      createAppServerFirestoreBridgeImpl: async () => ({
        progressReporter: {
          enqueue: () => {},
          flush: async () => {},
        },
        createControlListener: ({ sendRequest, getAppServerThreadId, getAppServerTurnId }) => {
          let timer = null;
          return {
            start() {
              timer = setTimeout(async () => {
                await sendRequest("turn/steer", {
                  threadId: getAppServerThreadId(),
                  expectedTurnId: getAppServerTurnId(),
                  input: [{ type: "text", text: "Actually say awesome." }],
                });
                acknowledgementBodies.push({
                  acknowledgements: [
                    { request_id: "wcasr_steer", status: "accepted" },
                  ],
                });
              }, 350);
            },
            async stop() {
              if (timer) {
                clearTimeout(timer);
              }
            },
          };
        },
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "steered ok");
  const requests = JSON.parse(await fs.readFile(requestsOutputPath, "utf8"));
  const steerRequest = requests.find((request) => request.method === "turn/steer");
  assert.equal(steerRequest?.params?.threadId, "thr_app");
  assert.equal(steerRequest?.params?.expectedTurnId, "turn_app");
  assert.deepEqual(steerRequest?.params?.input, [
    { type: "text", text: "Actually say awesome." },
  ]);
  assert.deepEqual(acknowledgementBodies.at(-1)?.acknowledgements, [
    { request_id: "wcasr_steer", status: "accepted" },
  ]);
});

test("final AppServer continuation ignores route-pending requests already handled live", () => {
  const pendingRequests = [
    {
      request_id: "wcasr_live",
      sequence: 1,
      kind: "steer",
      content: "already delivered",
      status: "pending",
    },
    {
      request_id: "wcasr_late",
      sequence: 2,
      kind: "steer",
      content: "needs final continuation",
      status: "pending",
    },
  ];
  const filtered = filterUnhandledPendingAppServerControlRequests({
    pendingRequests,
    handledRequests: [
      {
        request_id: "wcasr_live",
        sequence: 1,
        kind: "steer",
        content: "already delivered",
        status: "accepted",
      },
    ],
  });
  assert.deepEqual(
    filtered.map((request) => request.request_id),
    ["wcasr_late"],
  );
});

test("runCodex continues an AppServer turn for follow-ups visible at turn completion", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-app-server-final-continuation-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  const requestsOutputPath = path.join(workspacePath, "codex-requests.json");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs/promises';",
      "import readline from 'node:readline';",
      `const requestsOutputPath = ${JSON.stringify(requestsOutputPath)};`,
      "const requests = [];",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "const persistRequests = async () => fs.writeFile(requestsOutputPath, JSON.stringify(requests), 'utf8');",
      "let turnStartCount = 0;",
      "rl.on('line', async (line) => {",
      "  const message = JSON.parse(line);",
      "  requests.push({ method: message.method, params: message.params || {} });",
      "  await persistRequests();",
      "  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;",
      "  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });",
      "  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_app' } } });",
      "  if (message.method === 'turn/start') {",
      "    turnStartCount += 1;",
      "    const turnId = `turn_${turnStartCount}`;",
      "    const text = turnStartCount === 1 ? 'first answer' : 'final answer with late follow-up';",
      "    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });",
      "    send({ method: 'item/started', params: { item: { id: `msg_${turnStartCount}`, type: 'agent_message' } } });",
      "    send({ method: 'item/agentMessage/delta', params: { item_id: `msg_${turnStartCount}`, delta: text } });",
      "    send({ method: 'item/completed', params: { item: { id: `msg_${turnStartCount}`, type: 'agent_message', text } } });",
      "    send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });",
      "  }",
      "});",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const acknowledged = [];
  let consumedPending = false;
  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "answer before late follow-up",
    workspacePath,
    commandEnv: {
      ...process.env,
    },
    timeoutSeconds: 30,
    appServerContext: {
      publicBaseUrl: "https://codeq8.example",
      webChatRunToken: "runner_token",
      workspaceRepository: "Codeq8/Codeq8",
      threadId: "wct_app",
      runId: "wcr_app",
      createAppServerFirestoreBridgeImpl: async () => ({
        progressReporter: {
          enqueue: () => {},
          flush: async () => {},
        },
        createControlListener: () => ({
          start: () => {},
          flushPending: () => {},
          pauseProcessing: () => {},
          resumeProcessing: () => {},
          takePendingSteerRequestsForContinuation: async () => {
            if (consumedPending) {
              return [];
            }
            consumedPending = true;
            return [
              {
                request_id: "wcasr_late",
                sequence: 1,
                kind: "steer",
                content: "Actually include the late clarification.",
                attachments: [],
                status: "pending",
              },
            ];
          },
          acknowledgeRequests: async (acknowledgements) => {
            acknowledged.push(...acknowledgements);
          },
          readControlRequests: () => [
            {
              request_id: "wcasr_late",
              sequence: 1,
              kind: "steer",
              content: "Actually include the late clarification.",
              attachments: [],
              status: acknowledged.length > 0 ? "accepted" : "pending",
            },
          ],
          stop: async (options) => {
            assert.deepEqual(options, { failPending: false });
          },
        }),
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "final answer with late follow-up");
  assert.deepEqual(acknowledged, [
    { request_id: "wcasr_late", status: "accepted" },
  ]);
  assert.equal(result.appServerControlRequests[0]?.status, "accepted");
  const requests = JSON.parse(await fs.readFile(requestsOutputPath, "utf8"));
  const turnStarts = requests.filter((request) => request.method === "turn/start");
  assert.equal(turnStarts.length, 2);
  assert.match(
    turnStarts[1]?.params?.input?.[0]?.text || "",
    /late user messages/i,
  );
  assert.match(
    turnStarts[1]?.params?.input?.[0]?.text || "",
    /Actually include the late clarification/,
  );
  assert.equal(requests.some((request) => request.method === "turn/steer"), false);
});

test("AppServer Firestore control listener retries stale active turn id rejections", async () => {
  class FieldPath {
    constructor(...segments) {
      this.segments = segments;
    }
  }

  let activeTurnId = "stale_turn";
  const sentRequests = [];
  const transactionUpdates = [];
  const docData = {
    threads: {
      wct_app: {
        latestRunId: "wcr_app",
        appServerControlRequests: [
          {
            request_id: "wcasr_stale_turn",
            sequence: 1,
            kind: "steer",
            content: "Please switch to the production issue.",
            attachments: [],
            status: "pending",
            error: "",
          },
        ],
      },
    },
  };

  const listener = createAppServerFirestoreControlListener({
    FieldPathImpl: FieldPath,
    channel: {
      workspaceRepository: "Codeq8/Codeq8",
      threadId: "wct_app",
      runId: "wcr_app",
      collectionId: "chat_repository_live_status",
      documentId: "app-server-run:workspace:workspace:repository:repo:thread:wct_app:run:wcr_app",
    },
    docRef: {},
    firestore: {},
    onSnapshotImpl: (_docRef, next) => {
      next({
        exists: () => true,
        data: () => docData,
      });
      return () => {};
    },
    runTransactionImpl: async (_firestore, callback) =>
      await callback({
        get: async () => ({
          exists: () => true,
          data: () => docData,
        }),
        update: (...args) => {
          transactionUpdates.push(args);
          docData.threads.wct_app.appServerControlRequests = args[2];
        },
      }),
    sendRequest: async (method, params) => {
      sentRequests.push({ method, params });
      if (sentRequests.length === 1) {
        throw new Error(
          "expected active turn id `stale_turn` but found `fresh_turn`",
        );
      }
      return { ok: true };
    },
    getAppServerThreadId: () => "thr_app",
    getAppServerTurnId: () => activeTurnId,
    setAppServerTurnId: (turnId) => {
      activeTurnId = turnId || activeTurnId;
    },
  });

  listener.start();
  await listener.stop();

  assert.deepEqual(
    sentRequests.map((request) => request.method),
    ["turn/steer", "turn/steer"],
  );
  assert.equal(sentRequests[0]?.params?.expectedTurnId, "stale_turn");
  assert.equal(sentRequests[1]?.params?.expectedTurnId, "fresh_turn");
  assert.equal(activeTurnId, "fresh_turn");
  assert.equal(transactionUpdates.length, 1);
  assert.equal(transactionUpdates[0]?.[2]?.[0]?.request_id, "wcasr_stale_turn");
  assert.equal(transactionUpdates[0]?.[2]?.[0]?.status, "accepted");
});

test("AppServer Firestore control listener drains requests after the active turn id arrives", async () => {
  class FieldPath {
    constructor(...segments) {
      this.segments = segments;
    }
  }

  let activeTurnId = "";
  const sentRequests = [];
  const transactionUpdates = [];
  const docData = {
    threads: {
      wct_app: {
        latestRunId: "wcr_app",
        appServerControlRequests: [
          {
            request_id: "wcasr_deferred_turn",
            sequence: 1,
            kind: "steer",
            content: "This arrived before turn/start returned.",
            attachments: [],
            status: "pending",
            error: "",
          },
        ],
      },
    },
  };

  const listener = createAppServerFirestoreControlListener({
    FieldPathImpl: FieldPath,
    channel: {
      workspaceRepository: "Codeq8/Codeq8",
      threadId: "wct_app",
      runId: "wcr_app",
      collectionId: "chat_repository_live_status",
      documentId: "app-server-run:workspace:workspace:repository:repo:thread:wct_app:run:wcr_app",
    },
    docRef: {},
    firestore: {},
    onSnapshotImpl: (_docRef, next) => {
      next({
        exists: () => true,
        data: () => docData,
      });
      return () => {};
    },
    runTransactionImpl: async (_firestore, callback) =>
      await callback({
        get: async () => ({
          exists: () => true,
          data: () => docData,
        }),
        update: (...args) => {
          transactionUpdates.push(args);
          docData.threads.wct_app.appServerControlRequests = args[2];
        },
      }),
    sendRequest: async (method, params) => {
      sentRequests.push({ method, params });
      return { ok: true };
    },
    getAppServerThreadId: () => "thr_app",
    getAppServerTurnId: () => activeTurnId,
  });

  listener.start();
  assert.equal(sentRequests.length, 0);

  activeTurnId = "turn_app";
  listener.flushPending();
  await listener.stop();

  assert.equal(sentRequests.length, 1);
  assert.equal(sentRequests[0]?.method, "turn/steer");
  assert.equal(sentRequests[0]?.params?.expectedTurnId, "turn_app");
  assert.equal(transactionUpdates.length, 1);
  assert.equal(transactionUpdates[0]?.[2]?.[0]?.request_id, "wcasr_deferred_turn");
  assert.equal(transactionUpdates[0]?.[2]?.[0]?.status, "accepted");
  assert.equal(listener.readControlRequests()[0]?.status, "accepted");
});

test("AppServer Firestore control listener fails observed pending requests on shutdown", async () => {
  class FieldPath {
    constructor(...segments) {
      this.segments = segments;
    }
  }

  let sendCount = 0;
  const transactionUpdates = [];
  const docData = {
    threads: {
      wct_app: {
        latestRunId: "wcr_app",
        appServerControlRequests: [
          {
            request_id: "wcasr_shutdown",
            sequence: 1,
            kind: "steer",
            content: "This arrived too late.",
            attachments: [],
            status: "pending",
            error: "",
          },
        ],
      },
    },
  };

  const listener = createAppServerFirestoreControlListener({
    FieldPathImpl: FieldPath,
    channel: {
      workspaceRepository: "Codeq8/Codeq8",
      threadId: "wct_app",
      runId: "wcr_app",
      collectionId: "chat_repository_live_status",
      documentId: "app-server-run:workspace:workspace:repository:repo:thread:wct_app:run:wcr_app",
    },
    docRef: {},
    firestore: {},
    onSnapshotImpl: (_docRef, next) => {
      next({
        exists: () => true,
        data: () => docData,
      });
      return () => {};
    },
    runTransactionImpl: async (_firestore, callback) =>
      await callback({
        get: async () => ({
          exists: () => true,
          data: () => docData,
        }),
        update: (...args) => {
          transactionUpdates.push(args);
          docData.threads.wct_app.appServerControlRequests = args[2];
        },
      }),
    sendRequest: async () => {
      sendCount += 1;
      return { ok: true };
    },
    getAppServerThreadId: () => "thr_app",
    getAppServerTurnId: () => "",
  });

  listener.start();
  await listener.stop();

  assert.equal(sendCount, 0);
  assert.equal(transactionUpdates.length, 1);
  assert.equal(transactionUpdates[0]?.[2]?.[0]?.request_id, "wcasr_shutdown");
  assert.equal(transactionUpdates[0]?.[2]?.[0]?.status, "failed");
  assert.match(
    transactionUpdates[0]?.[2]?.[0]?.error,
    /finished before this follow-up could be delivered/,
  );
  assert.equal(listener.readControlRequests()[0]?.status, "failed");
});

test("runCodex synchronizes Codeq8 Codex goals through AppServer", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-app-server-goal-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  const requestsOutputPath = path.join(workspacePath, "codex-requests.json");
  const longGoalObjective = `Ship native Codeq8 goal support ${"without truncating active-run reasoning context ".repeat(5)}`.trim();
  const goalUpdates = [];
  const progressEvents = [];
  const server = createServer((request, response) => {
    let rawBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      rawBody += chunk;
    });
    request.on("end", () => {
      if (request.url === "/api/chat/runs/goal") {
        goalUpdates.push({
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(rawBody || "{}"),
        });
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, contract_version: CONTRACT_VERSION }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(async () => {
    server.close();
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await writeFakeCodexAppServer(fakeCodexPath, {
    requestsOutputPath,
    agentMessage: "goal ok",
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "continue the goal",
    workspacePath,
    commandEnv: {
      ...process.env,
    },
    timeoutSeconds: 30,
    codexThreadGoalsEnabled: true,
    codexGoalState: {
      objective: longGoalObjective,
      status: "active",
      token_budget: 12345,
      tokens_used: 8,
      time_used_seconds: 3,
      created_at: 900,
      updated_at: 950,
    },
    appServerContext: {
      publicBaseUrl: `http://127.0.0.1:${address.port}`,
      webChatRunToken: "header.payload.signature",
      workspaceRepository: "Codeq8/Codeq8",
      threadId: "wct_app",
      runId: "wcr_app",
      createAppServerFirestoreBridgeImpl: async () => ({
        progressReporter: {
          enqueue(event) {
            progressEvents.push(event);
          },
          flush: async () => {},
        },
        createControlListener: () => ({
          start: () => {},
          stop: async () => {},
        }),
        close: async () => {},
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "goal ok");
  assert.equal(result.codexGoalState.objective, longGoalObjective);
  const requests = JSON.parse(await fs.readFile(requestsOutputPath, "utf8"));
  const goalSet = requests.find((request) => request.method === "thread/goal/set");
  const turnStartIndex = requests.findIndex((request) => request.method === "turn/start");
  const goalSetIndex = requests.findIndex((request) => request.method === "thread/goal/set");
  assert(goalSetIndex >= 0);
  assert(turnStartIndex > goalSetIndex);
  assert.deepEqual(goalSet?.params, {
    threadId: "thr_app",
    objective: longGoalObjective,
    status: "active",
    tokenBudget: 12345,
  });
  assert.equal(
    requests.some((request) => request.method === "thread/goal/get"),
    true,
  );
  assert.equal(goalUpdates.length, 1);
  assert.equal(goalUpdates[0]?.url, "/api/chat/runs/goal");
  assert.equal(goalUpdates[0]?.authorization, "Bearer header.payload.signature");
  assert.equal(goalUpdates[0]?.body?.event, "updated");
  assert.equal(goalUpdates[0]?.body?.goal?.objective, longGoalObjective);
  assert(longGoalObjective.length > 180);
  assert.deepEqual(
    progressEvents.filter(
      (event) =>
        event?.kind === "codex_goal" ||
        event?.item_type === "codex_goal" ||
        String(event?.label || "").startsWith("Goal: "),
    ),
    [],
  );
});

test("runCodex preserves the web goal when the final AppServer goal read is empty", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-app-server-goal-empty-read-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  const requestsOutputPath = path.join(workspacePath, "codex-requests.json");
  const goalUpdates = [];
  const server = createServer((request, response) => {
    let rawBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      rawBody += chunk;
    });
    request.on("end", () => {
      if (request.url === "/api/chat/runs/goal") {
        goalUpdates.push({
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(rawBody || "{}"),
        });
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, contract_version: CONTRACT_VERSION }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(async () => {
    server.close();
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await writeFakeCodexAppServer(fakeCodexPath, {
    requestsOutputPath,
    agentMessage: "empty goal read ok",
    goalGetReturnsEmpty: true,
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "continue the goal",
    workspacePath,
    commandEnv: {
      ...process.env,
    },
    timeoutSeconds: 30,
    codexThreadGoalsEnabled: true,
    codexGoalState: {
      objective: "Keep the Codeq8 web goal durable",
      status: "active",
      token_budget: null,
      tokens_used: 0,
      time_used_seconds: 0,
      created_at: 900,
      updated_at: 950,
    },
    appServerContext: {
      publicBaseUrl: `http://127.0.0.1:${address.port}`,
      webChatRunToken: "header.payload.signature",
      workspaceRepository: "Codeq8/Codeq8",
      threadId: "wct_app",
      runId: "wcr_app",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "empty goal read ok");
  assert.equal(result.codexGoalState.objective, "Keep the Codeq8 web goal durable");
  const requests = JSON.parse(await fs.readFile(requestsOutputPath, "utf8"));
  assert.equal(
    requests.some((request) => request.method === "thread/goal/set"),
    true,
  );
  assert.equal(
    requests.some((request) => request.method === "thread/goal/get"),
    true,
  );
  assert.equal(goalUpdates.length, 0);
});

test("runCodex treats unsupported AppServer goal methods as optional", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-app-server-goal-unsupported-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  const requestsOutputPath = path.join(workspacePath, "codex-requests.json");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await writeFakeCodexAppServer(fakeCodexPath, {
    requestsOutputPath,
    agentMessage: "unsupported goal api still runs",
    goalApisUnsupported: true,
  });

  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "continue without goal api support",
    workspacePath,
    commandEnv: {
      ...process.env,
    },
    timeoutSeconds: 30,
    codexThreadGoalsEnabled: true,
    codexGoalState: null,
    appServerContext: {
      publicBaseUrl: "https://codeq8.example",
      webChatRunToken: "header.payload.signature",
      workspaceRepository: "Codeq8/test",
      threadId: "wct_app",
      runId: "wcr_app",
      createAppServerFirestoreBridgeImpl: async () => ({
        progressReporter: {
          enqueue: () => {},
          flush: async () => {},
        },
        createControlListener: () => ({
          start: () => {},
          stop: async () => {},
        }),
        close: async () => {},
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "unsupported goal api still runs");
  const requests = JSON.parse(await fs.readFile(requestsOutputPath, "utf8"));
  assert.equal(
    requests.some((request) => request.method === "thread/goal/clear"),
    true,
  );
  assert.equal(
    requests.some((request) => request.method === "thread/goal/get"),
    false,
  );
  assert.equal(
    requests.some((request) => request.method === "turn/start"),
    true,
  );
});

test("runCodex materializes AppServer steer attachments before forwarding them", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-app-server-steer-attachments-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  const requestsOutputPath = path.join(workspacePath, "codex-requests.json");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await writeFakeCodexAppServer(fakeCodexPath, {
    requestsOutputPath,
    agentMessage: "attachment steer ok",
    delayTurnCompletionMs: 2200,
  });

  const materializeCalls = [];
  const acknowledgementBodies = [];
  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "use app server attachment steering",
    workspacePath,
    commandEnv: {
      ...process.env,
    },
    timeoutSeconds: 30,
    appServerContext: {
      publicBaseUrl: "https://codeq8.example",
      webChatRunToken: "runner_token",
      workspaceRepository: "Codeq8/Codeq8",
      threadId: "wct_app",
      runId: "wcr_app",
      workerUrl: "https://worker.example",
      adminToken: "runner_token",
      attachmentRootPath: path.join(workspacePath, "control-attachments"),
      materializeWebChatAttachmentsImpl: async (args) => {
        materializeCalls.push(args);
        return [
          {
            attachment_id: "wca_screenshot",
            name: "Screenshot.png",
            content_type: "image/png",
            size_bytes: 12,
            local_path: path.join(args.attachmentRootPath, "wca_screenshot-Screenshot.png"),
          },
        ];
      },
      createAppServerFirestoreBridgeImpl: async (context) => ({
        progressReporter: {
          enqueue: () => {},
          flush: async () => {},
        },
        createControlListener: ({ sendRequest, getAppServerThreadId, getAppServerTurnId }) => {
          let timer = null;
          return {
            start() {
              timer = setTimeout(async () => {
                const materialized = await context.materializeWebChatAttachmentsImpl({
                  attachments: [
                    {
                      attachment_id: "wca_screenshot",
                      name: "Screenshot.png",
                      content_type: "image/png",
                      size_bytes: 12,
                      storage_backend: "firebase_storage",
                      storage_bucket: "codeq8.appspot.com",
                      storage_key: "chat_attachments/wca_screenshot/Screenshot.png",
                    },
                  ],
                  attachmentRootPath: path.join(
                    context.attachmentRootPath,
                    "wcasr_attachment_steer",
                  ),
                  workerUrl: context.workerUrl,
                  adminToken: context.adminToken,
                  threadId: context.threadId,
                  commandEnv: process.env,
                });
                await sendRequest("turn/steer", {
                  threadId: getAppServerThreadId(),
                  expectedTurnId: getAppServerTurnId(),
                  input: [
                    {
                      type: "text",
                      text: [
                        "The user sent a follow-up while this run was active.",
                        "",
                        "Message:",
                        "(no text)",
                        "",
                        "Attachments materialized locally:",
                        `- Screenshot.png (image/png, 12 bytes, attachment_id=wca_screenshot): ${materialized[0].local_path}`,
                        "",
                        "Inspect these files directly if they are relevant to the request. Do not modify or delete the attached files.",
                      ].join("\n"),
                    },
                  ],
                });
                acknowledgementBodies.push({
                  acknowledgements: [
                    { request_id: "wcasr_attachment_steer", status: "accepted" },
                  ],
                });
              }, 350);
            },
            async stop() {
              if (timer) {
                clearTimeout(timer);
              }
            },
          };
        },
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "attachment steer ok");
  assert.equal(materializeCalls.length, 1);
  assert.equal(materializeCalls[0]?.workerUrl, "https://worker.example");
  assert.equal(materializeCalls[0]?.threadId, "wct_app");
  assert.match(materializeCalls[0]?.attachmentRootPath, /wcasr_attachment_steer$/);
  const requests = JSON.parse(await fs.readFile(requestsOutputPath, "utf8"));
  const steerRequest = requests.find((request) => request.method === "turn/steer");
  const steerText = String(steerRequest?.params?.input?.[0]?.text || "");
  assert.equal(steerRequest?.params?.expectedTurnId, "turn_app");
  assert.match(steerText, /The user sent a follow-up while this run was active\./);
  assert.match(steerText, /Message:\n\(no text\)/);
  assert.match(steerText, /Attachments materialized locally:/);
  assert.match(steerText, /Screenshot\.png/);
  assert.match(steerText, /wca_screenshot-Screenshot\.png/);
  assert.deepEqual(acknowledgementBodies.at(-1)?.acknowledgements, [
    { request_id: "wcasr_attachment_steer", status: "accepted" },
  ]);
});

test("runCodex completes while an AppServer progress flush is active", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-app-server-flush-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "rl.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });",
      "  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_app' } } });",
      "  if (message.method === 'turn/start') {",
      "    send({ id: message.id, result: { turn: { id: 'turn_app', status: 'inProgress' } } });",
      "    send({ method: 'item/started', params: { item: { type: 'reasoning', text: 'thinking' } } });",
      "    send({ method: 'item/started', params: { item: { id: 'msg_done', type: 'agent_message' } } });",
      "    send({ method: 'item/agentMessage/delta', params: { item_id: 'msg_done', delta: 'done' } });",
      "    send({ method: 'item/completed', params: { item: { id: 'msg_done', type: 'agent_message', text: 'done' } } });",
      "    setTimeout(() => {",
      "      send({ method: 'turn/completed', params: { turn: { id: 'turn_app', status: 'completed' } } });",
      "    }, 3500);",
      "  }",
      "});",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  let progressFlushCount = 0;
  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "complete during flush",
    workspacePath,
    commandEnv: {
      ...process.env,
    },
    timeoutSeconds: 30,
    appServerContext: {
      publicBaseUrl: "https://codeq8.example",
      webChatRunToken: "runner_token",
      workspaceRepository: "Codeq8/Codeq8",
      threadId: "wct_app",
      runId: "wcr_app",
      createAppServerFirestoreBridgeImpl: async () => ({
        progressReporter: {
          enqueue: () => {},
          async flush() {
            progressFlushCount += 1;
            await new Promise((resolve) => setTimeout(resolve, 2000));
          },
        },
        createControlListener: () => ({
          start: () => {},
          stop: async () => {},
        }),
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "done");
  assert(progressFlushCount >= 1);
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

test("readFirebaseStorageSignedAttachment downloads an object-scoped signed URL", async () => {
  const calls = [];

  const loaded = await readFirebaseStorageSignedAttachment({
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
    downloadUrl: "https://storage.googleapis.com/codeq8.appspot.com/signed.png?X-Goog-Signature=test",
    retries: 1,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(Buffer.from("signed-image-bytes", "utf8"), { status: 200 });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    "https://storage.googleapis.com/codeq8.appspot.com/signed.png?X-Goog-Signature=test",
  );
  assert.equal(calls[0]?.init?.headers, undefined);
  assert.equal(
    Buffer.from(loaded.fileContentsBase64Url, "base64url").toString("utf8"),
    "signed-image-bytes",
  );
});

test("readWebChatAttachmentReadUrl requests a signed Firebase attachment URL", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method || "GET",
      headers: new Headers(init?.headers || {}),
    });
    return Response.json({
      ok: true,
      attachment: {
        attachment_id: "wca_123",
        name: "screenshot.png",
        content_type: "image/png",
        size_bytes: 5,
        storage_backend: "firebase_storage",
        storage_bucket: "codeq8.appspot.com",
        storage_key: "chat_attachments/wca_123/screenshot.png",
      },
      download_url: "https://storage.googleapis.com/codeq8.appspot.com/signed.png",
      expires_at: 1778530000000,
    });
  };

  try {
    const loaded = await readWebChatAttachmentReadUrl({
      workerUrl: "https://worker.example",
      adminToken: "header.payload.signature",
      threadId: "wct_123",
      attachmentId: "wca_123",
      expiresSeconds: 120,
    });

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      "https://worker.example/web-chat/attachments/read-url?thread_id=wct_123&attachment_id=wca_123&expires_seconds=120",
    );
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer header.payload.signature");
    assert.equal(loaded.attachment.attachment_id, "wca_123");
    assert.equal(loaded.downloadUrl, "https://storage.googleapis.com/codeq8.appspot.com/signed.png");
    assert.equal(loaded.expiresAt, 1778530000000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("materializeWebChatAttachments reads Firebase Storage attachments through signed worker URLs", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-attachment-test-"));
  const calls = {
    signedUrlReads: [],
    signedDownloads: [],
    firebaseDirectReads: 0,
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
        FIREBASE_JSON_KEY: '{"client_email":"customer@example.com","private_key":"unused"}',
      },
      readWebChatAttachmentReadUrlImpl: async (request) => {
        calls.signedUrlReads.push(request);
        return {
          attachment: {
            ...request,
            attachment_id: "wca_screenshot",
            name: "Screenshot.png",
            content_type: "image/png",
            size_bytes: 12,
          },
          downloadUrl: "https://storage.googleapis.com/codeq8.appspot.com/signed.png",
        };
      },
      readFirebaseStorageSignedAttachmentImpl: async ({ attachment, downloadUrl }) => {
        calls.signedDownloads.push({ attachment, downloadUrl });
        return {
          attachment,
          fileContentsBase64Url: Buffer.from("signed-image-bytes", "utf8").toString(
            "base64url",
          ),
        };
      },
      readFirebaseStorageAttachmentImpl: async () => {
        calls.firebaseDirectReads += 1;
        throw new Error("Codeq8 direct Firebase credential fallback should not run");
      },
      readWebChatAttachmentImpl: async () => {
        calls.workerReads += 1;
        throw new Error("worker byte fallback should not run");
      },
    });

    assert.equal(calls.signedUrlReads.length, 1);
    assert.equal(calls.signedDownloads.length, 1);
    assert.equal(calls.firebaseDirectReads, 0);
    assert.equal(calls.workerReads, 0);
    assert.equal(materialized.length, 1);
    assert.equal(await fs.readFile(materialized[0].local_path, "utf8"), "signed-image-bytes");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("materializeWebChatAttachments falls back to direct Codeq8 credentials when signed URLs are unavailable", async () => {
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
        CODEQ8_FIREBASE_JSON_KEY: '{"client_email":"runner@example.com","private_key":"unused"}',
      },
      readWebChatAttachmentReadUrlImpl: async () => {
        throw new Error("signed URL route unavailable");
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

test("materializeWebChatAttachments ignores customer FIREBASE_JSON_KEY for Codeq8 attachment direct reads", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-attachment-test-"));
  const calls = {
    firebaseDirectReads: 0,
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
        FIREBASE_JSON_KEY: '{"client_email":"customer@example.com","private_key":"unused"}',
      },
      readWebChatAttachmentReadUrlImpl: async () => {
        throw new Error("signed URL route unavailable");
      },
      readFirebaseStorageAttachmentImpl: async () => {
        calls.firebaseDirectReads += 1;
        throw new Error("customer Firebase credential must not be used for Codeq8 storage");
      },
      readWebChatAttachmentImpl: async ({ attachmentId }) => {
        calls.workerReads += 1;
        return {
          attachment: {
            attachment_id: attachmentId,
            name: "Screenshot.png",
            content_type: "image/png",
            size_bytes: 12,
          },
          fileContentsBase64Url: Buffer.from("worker-image-bytes", "utf8").toString(
            "base64url",
          ),
        };
      },
    });

    assert.equal(calls.firebaseDirectReads, 0);
    assert.equal(calls.workerReads, 1);
    assert.equal(await fs.readFile(materialized[0].local_path, "utf8"), "worker-image-bytes");
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
        "staged_codex_session_upload",
        "recoverable_codex_session_errors",
        "codex_app_server_turn_control",
        "codex_app_server_attachment_turn_control",
        "runner_codeq8_cli",
      ],
      authorized_paths: [
        "/api/github/workspace-git-token",
        "/api/chat/runs/callback",
        "/api/chat/runs/runtime-manifest",
        "/api/chat/runs/prompt",
        "/api/chat/runs/app-server/firebase-session",
        "/web-chat/attachments/get",
        "/web-chat/codex-session/get",
        "/web-chat/codex-session/read-url",
        "/web-chat/codex-session/unwrap-key",
        "/web-chat/codex-session/upload-prepare",
        "/web-chat/codex-session/upload-discard",
        "/web-chat/codex-session/upsert",
        "/web-chat/codex-session/invalidate",
        "/web-chat/threads/get",
      ],
      scoped_authorized_paths: [
        "/api/chat/runs/diagnostic",
        "/web-chat/attachments/read-url",
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

test("assertWebChatRunnerRuntimeCompatibility accepts AppServer turn-control manifest entries when required", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      ok: true,
      contract_version: CONTRACT_VERSION,
      capabilities: [
        "server_owned_prompt",
        "staged_codex_session_upload",
        "recoverable_codex_session_errors",
        "codex_app_server_turn_control",
      ],
      authorized_paths: [
        "/api/github/workspace-git-token",
        "/api/chat/runs/callback",
        "/api/chat/runs/runtime-manifest",
        "/api/chat/runs/prompt",
        "/api/chat/runs/app-server/firebase-session",
        "/web-chat/attachments/get",
        "/web-chat/codex-session/get",
        "/web-chat/codex-session/read-url",
        "/web-chat/codex-session/unwrap-key",
        "/web-chat/codex-session/upload-prepare",
        "/web-chat/codex-session/upload-direct",
        "/web-chat/codex-session/upload-discard",
        "/web-chat/codex-session/upsert",
        "/web-chat/codex-session/invalidate",
        "/web-chat/threads/get",
      ],
      scoped_authorized_paths: [
        "/api/chat/runs/diagnostic",
        "/web-chat/attachments/read-url",
        "/api/chat/runs/app-server/firebase-session",
      ],
    });

  try {
    await assert.doesNotReject(() =>
      assertWebChatRunnerRuntimeCompatibility({
        publicBaseUrl: "https://codeq8.example.com",
        webChatRunToken: "header.payload.signature",
        workspaceRepository: "Codeq8/Codeq8",
        threadId: "wct_123",
        runId: "wcr_123",
        requiredCapabilities: [
          "server_owned_prompt",
          "staged_codex_session_upload",
          "recoverable_codex_session_errors",
          "codex_app_server_turn_control",
        ],
        requiredPaths: [
          "/api/github/workspace-git-token",
          "/api/chat/runs/callback",
          "/api/chat/runs/diagnostic",
          "/api/chat/runs/runtime-manifest",
          "/api/chat/runs/prompt",
          "/api/chat/runs/app-server/firebase-session",
          "/web-chat/attachments/get",
          "/web-chat/attachments/read-url",
          "/web-chat/codex-session/get",
          "/web-chat/codex-session/read-url",
          "/web-chat/codex-session/unwrap-key",
          "/web-chat/codex-session/upload-prepare",
          "/web-chat/codex-session/upload-direct",
          "/web-chat/codex-session/upload-discard",
          "/web-chat/codex-session/upsert",
          "/web-chat/codex-session/invalidate",
          "/web-chat/threads/get",
        ],
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("assertWebChatRunnerRuntimeCompatibility fails fast when AppServer Firestore session route is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      ok: true,
      contract_version: CONTRACT_VERSION,
      capabilities: [
        "server_owned_prompt",
        "staged_codex_session_upload",
        "recoverable_codex_session_errors",
        "codex_app_server_turn_control",
      ],
      authorized_paths: [
        "/api/github/workspace-git-token",
        "/api/chat/runs/callback",
        "/api/chat/runs/runtime-manifest",
        "/api/chat/runs/prompt",
        "/web-chat/attachments/get",
        "/web-chat/attachments/read-url",
        "/web-chat/codex-session/get",
        "/web-chat/codex-session/read-url",
        "/web-chat/codex-session/unwrap-key",
        "/web-chat/codex-session/upload-prepare",
        "/web-chat/codex-session/upload-direct",
        "/web-chat/codex-session/upload-discard",
        "/web-chat/codex-session/upsert",
        "/web-chat/codex-session/invalidate",
        "/web-chat/threads/get",
      ],
      scoped_authorized_paths: ["/api/chat/runs/diagnostic"],
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
          requiredCapabilities: [
            "server_owned_prompt",
            "staged_codex_session_upload",
            "recoverable_codex_session_errors",
            "codex_app_server_turn_control",
          ],
          requiredPaths: [
            "/api/github/workspace-git-token",
            "/api/chat/runs/callback",
            "/api/chat/runs/diagnostic",
            "/api/chat/runs/runtime-manifest",
            "/api/chat/runs/prompt",
            "/api/chat/runs/app-server/firebase-session",
            "/web-chat/attachments/get",
            "/web-chat/attachments/read-url",
            "/web-chat/codex-session/get",
            "/web-chat/codex-session/read-url",
            "/web-chat/codex-session/unwrap-key",
            "/web-chat/codex-session/upload-prepare",
            "/web-chat/codex-session/upload-direct",
            "/web-chat/codex-session/upload-discard",
            "/web-chat/codex-session/upsert",
            "/web-chat/codex-session/invalidate",
            "/web-chat/threads/get",
          ],
        }),
      /missing authorized paths: \/api\/chat\/runs\/app-server\/firebase-session/,
    );
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
        "/web-chat/codex-session/read-url",
        "/web-chat/codex-session/unwrap-key",
        "/web-chat/codex-session/upsert",
        "/web-chat/codex-session/invalidate",
        "/web-chat/threads/get",
      ],
      scoped_authorized_paths: [
        "/api/chat/runs/app-server/firebase-session",
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
      /missing authorized paths: \/api\/chat\/runs\/diagnostic, \/web-chat\/attachments\/read-url, \/web-chat\/codex-session\/upload-prepare, \/web-chat\/codex-session\/upload-direct, \/web-chat\/codex-session\/upload-discard/,
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

test("runCodex treats auth-like agent text as normal output", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-agent-auth-text-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await writeFakeCodexAppServer(fakeCodexPath, {
    agentMessage:
      'cloudflare/control-plane/tests/control-plane-routing.test.mjs: error: "refresh_token_reused",',
  });

  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "inspect auth fixtures",
    workspacePath,
    commandEnv: process.env,
    timeoutSeconds: 30,
  });

  assert.equal(result.ok, true);
  assert.match(result.output, /refresh_token_reused/i);
});

test("runCodex preserves AppServer agent delta whitespace without streaming partial progress", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-agent-whitespace-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await writeFakeCodexAppServer(fakeCodexPath, {
    agentMessage: [
      "Yes,",
      " I",
      "'m",
      " getting",
      " it.",
      " This",
      " run",
      " is",
      " targeting",
      " PR",
      " #1698",
      ".",
    ],
  });

  const progressEvents = [];
  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "preserve streaming whitespace",
    workspacePath,
    commandEnv: process.env,
    timeoutSeconds: 30,
    appServerContext: {
      publicBaseUrl: "https://codeq8.example",
      webChatRunToken: "runner_token",
      workspaceRepository: "Codeq8/Codeq8",
      threadId: "wct_app",
      runId: "wcr_app",
      createAppServerFirestoreBridgeImpl: async () => ({
        progressReporter: {
          enqueue(event) {
            progressEvents.push(event);
          },
          flush: async () => {},
        },
        createControlListener: () => ({
          start: () => {},
          stop: async () => {},
        }),
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "Yes, I'm getting it. This run is targeting PR #1698.");
  assert.equal(progressEvents.length, 0);
});

test("runCodex returns only the last AppServer agent message", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-agent-final-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "rl.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });",
      "  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_app' } } });",
      "  if (message.method === 'turn/start') {",
      "    send({ id: message.id, result: { turn: { id: 'turn_app', status: 'inProgress' } } });",
      "    send({ method: 'item/started', params: { item: { id: 'msg_status', type: 'agent_message' } } });",
      "    send({ method: 'item/agentMessage/delta', params: { item_id: 'msg_status', delta: 'I will inspect the screenshot.' } });",
      "    send({ method: 'item/completed', params: { item: { id: 'msg_status', type: 'agent_message', text: 'I will inspect the screenshot.' } } });",
      "    send({ method: 'item/started', params: { item: { type: 'command_execution', command: 'view_image' } } });",
      "    send({ method: 'item/completed', params: { item: { type: 'command_execution', command: 'view_image' } } });",
      "    send({ method: 'item/started', params: { item: { id: 'msg_final', type: 'agent_message' } } });",
      "    send({ method: 'item/agentMessage/delta', params: { item_id: 'msg_final', delta: 'The attachment is a tiny cropped screenshot.' } });",
      "    send({ method: 'item/completed', params: { item: { id: 'msg_final', type: 'agent_message', text: 'The attachment is a tiny cropped screenshot.' } } });",
      "    send({ method: 'turn/completed', params: { turn: { id: 'turn_app', status: 'completed' } } });",
      "  }",
      "});",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "do not persist status text",
    workspacePath,
    commandEnv: process.env,
    timeoutSeconds: 30,
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "The attachment is a tiny cropped screenshot.");
});

test("runCodex runs hidden AppServer title pre-turn before the visible task turn", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-title-preturn-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  const requestsOutputPath = path.join(workspacePath, "codex-requests.json");
  const originalFetch = globalThis.fetch;
  const titleCalls = [];
  const lifecycleEvents = [];
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/chat/runs/thread-title") {
      const body = JSON.parse(String(init.body || "{}"));
      lifecycleEvents.push("title-write");
      titleCalls.push({
        authorization: init.headers?.Authorization || init.headers?.authorization || "",
        body,
      });
      return Response.json({
        ok: true,
        title: body.title,
        updated: true,
        thread: {
          thread_id: body.target_thread_id,
          title: body.title,
          title_source: "manual",
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs/promises';",
      "import readline from 'node:readline';",
      `const requestsOutputPath = ${JSON.stringify(requestsOutputPath)};`,
      "const requests = [];",
      "let persistChain = Promise.resolve();",
      "const persistRequests = () => {",
      "  persistChain = persistChain.then(() => fs.writeFile(requestsOutputPath, JSON.stringify(requests), 'utf8'));",
      "  return persistChain;",
      "};",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "let turnCount = 0;",
      "rl.on('line', async (line) => {",
      "  const message = JSON.parse(line);",
      "  requests.push({ method: message.method, params: message.params || {} });",
      "  await persistRequests();",
      "  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;",
      "  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });",
      "  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_app' } } });",
      "  if (message.method === 'turn/start') {",
      "    turnCount += 1;",
      "    const isTitleTurn = turnCount === 1;",
      "    const turnId = isTitleTurn ? 'turn_title' : 'turn_main';",
      "    const text = isTitleTurn ? 'Timeout contract' : 'Done.';",
      "    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });",
      "    send({ method: 'turn/started', params: { turn: { id: turnId } } });",
      "    const messages = isTitleTurn ? ['Hidden title setup', text] : [text];",
      "    for (let index = 0; index < messages.length; index += 1) {",
      "      const messageText = messages[index];",
      "      const itemId = `msg_${turnCount}_${index}`;",
      "      send({ method: 'item/started', params: { item: { id: itemId, type: 'agent_message' } } });",
      "      send({ method: 'item/agentMessage/delta', params: { item_id: itemId, delta: messageText } });",
      "      send({ method: 'item/completed', params: { item: { id: itemId, type: 'agent_message', text: messageText } } });",
      "    }",
      "    send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });",
      "  }",
      "});",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const progressEvents = [];
  const diagnostics = [];
  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "visible work prompt",
    workspacePath,
    commandEnv: process.env,
    timeoutSeconds: 30,
    appServerContext: {
      publicBaseUrl: "https://codeq8.example",
      webChatRunToken: "header.payload.signature",
      workspaceRepository: "example-org/example-repo",
      threadId: "wct_title",
      runId: "wcr_title",
      threadTitle: "Untitled",
      threadTitleSource: "provisional_first_message",
      promptText: "Fix the repeated 120 second timeout before rerunning tests.",
      reportRunnerDiagnostic: async (diagnostic) => {
        diagnostics.push(diagnostic);
        return { ok: true, status: 200 };
      },
      createAppServerFirestoreBridgeImpl: async () => ({
        progressReporter: {
          enqueue(event) {
            progressEvents.push(event);
          },
          flush: async () => {},
        },
        createControlListener: () => ({
          start: () => {},
          stop: async () => {},
        }),
      }),
    },
    beforeMainTurn: async () => {
      const requests = JSON.parse(await fs.readFile(requestsOutputPath, "utf8"));
      lifecycleEvents.push(
        `before-main:${requests.filter((request) => request.method === "turn/start").length}`,
      );
      return { stop: false };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "Done.");
  assert.deepEqual(lifecycleEvents, ["title-write", "before-main:1"]);
  assert.equal(titleCalls.length, 1);
  assert.match(titleCalls[0]?.authorization, /^Bearer /);
  assert.equal(titleCalls[0]?.body?.workspace_repository, "example-org/example-repo");
  assert.equal(titleCalls[0]?.body?.thread_id, "wct_title");
  assert.equal(titleCalls[0]?.body?.run_id, "wcr_title");
  assert.equal(titleCalls[0]?.body?.target_thread_id, "wct_title");
  assert.equal(titleCalls[0]?.body?.title, "Timeout contract");
  assert.deepEqual(progressEvents.map((event) => event.label), []);
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.event === "runner_hidden_thread_title_preturn_finished"),
    true,
  );

  const requests = JSON.parse(await fs.readFile(requestsOutputPath, "utf8"));
  const turnStarts = requests.filter((request) => request.method === "turn/start");
  assert.equal(turnStarts.length, 2);
  assert.match(turnStarts[0]?.params?.input?.[0]?.text, /Create a concise title/);
  assert.match(turnStarts[0]?.params?.input?.[0]?.text, /120 second timeout/);
  assert.equal(turnStarts[1]?.params?.input?.[0]?.text, "visible work prompt");
});

test("runCodex skips hidden AppServer title pre-turn for low-signal greeting prompts", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-title-skip-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  const requestsOutputPath = path.join(workspacePath, "codex-requests.json");
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  globalThis.fetch = async (url) => {
    throw new Error(`Unexpected fetch: ${url}`);
  };

  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs/promises';",
      "import readline from 'node:readline';",
      `const requestsOutputPath = ${JSON.stringify(requestsOutputPath)};`,
      "const requests = [];",
      "let persistChain = Promise.resolve();",
      "const persistRequests = () => {",
      "  persistChain = persistChain.then(() => fs.writeFile(requestsOutputPath, JSON.stringify(requests), 'utf8'));",
      "  return persistChain;",
      "};",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "rl.on('line', async (line) => {",
      "  const message = JSON.parse(line);",
      "  requests.push({ method: message.method, params: message.params || {} });",
      "  await persistRequests();",
      "  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;",
      "  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });",
      "  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_app' } } });",
      "  if (message.method === 'turn/start') {",
      "    send({ id: message.id, result: { turn: { id: 'turn_main', status: 'inProgress' } } });",
      "    send({ method: 'turn/started', params: { turn: { id: 'turn_main' } } });",
      "    send({ method: 'item/started', params: { item: { id: 'msg_main', type: 'agent_message' } } });",
      "    send({ method: 'item/agentMessage/delta', params: { item_id: 'msg_main', delta: 'Hi.' } });",
      "    send({ method: 'item/completed', params: { item: { id: 'msg_main', type: 'agent_message', text: 'Hi.' } } });",
      "    send({ method: 'turn/completed', params: { turn: { id: 'turn_main', status: 'completed' } } });",
      "  }",
      "});",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "visible work prompt",
    workspacePath,
    commandEnv: process.env,
    timeoutSeconds: 30,
    appServerContext: {
      publicBaseUrl: "https://codeq8.example",
      webChatRunToken: "header.payload.signature",
      workspaceRepository: "example-org/example-repo",
      threadId: "wct_title_skip",
      runId: "wcr_title_skip",
      threadTitle: "Untitled",
      threadTitleSource: "provisional_first_message",
      promptText: "hi",
      reportRunnerDiagnostic: async () => ({ ok: true, status: 200 }),
      createAppServerFirestoreBridgeImpl: async () => ({
        progressReporter: {
          enqueue() {},
          flush: async () => {},
        },
        createControlListener: () => ({
          start: () => {},
          stop: async () => {},
        }),
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "Hi.");
  const requests = JSON.parse(await fs.readFile(requestsOutputPath, "utf8"));
  const turnStarts = requests.filter((request) => request.method === "turn/start");
  assert.equal(turnStarts.length, 1);
  assert.equal(turnStarts[0]?.params?.input?.[0]?.text, "visible work prompt");
});

test("runCodex runs hidden AppServer title pre-turn for hosted runner pool startup", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-title-hosted-skip-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  const requestsOutputPath = path.join(workspacePath, "codex-requests.json");
  const originalFetch = globalThis.fetch;
  const titleCalls = [];
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/chat/runs/thread-title") {
      const body = JSON.parse(String(init.body || "{}"));
      titleCalls.push(body);
      return Response.json({
        ok: true,
        title: body.title,
        updated: true,
        thread: {
          thread_id: body.target_thread_id,
          title: body.title,
          title_source: "manual",
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs/promises';",
      "import readline from 'node:readline';",
      `const requestsOutputPath = ${JSON.stringify(requestsOutputPath)};`,
      "const requests = [];",
      "let persistChain = Promise.resolve();",
      "const persistRequests = () => {",
      "  persistChain = persistChain.then(() => fs.writeFile(requestsOutputPath, JSON.stringify(requests), 'utf8'));",
      "  return persistChain;",
      "};",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "let turnCount = 0;",
      "rl.on('line', async (line) => {",
      "  const message = JSON.parse(line);",
      "  requests.push({ method: message.method, params: message.params || {} });",
      "  await persistRequests();",
      "  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;",
      "  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });",
      "  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_app' } } });",
      "  if (message.method === 'turn/start') {",
      "    turnCount += 1;",
      "    const isTitleTurn = turnCount === 1;",
      "    const turnId = isTitleTurn ? 'turn_title' : 'turn_main';",
      "    const text = isTitleTurn ? 'Timeout contract' : 'Done.';",
      "    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });",
      "    send({ method: 'turn/started', params: { turn: { id: turnId } } });",
      "    send({ method: 'item/started', params: { item: { id: `msg_${turnCount}`, type: 'agent_message' } } });",
      "    send({ method: 'item/agentMessage/delta', params: { item_id: `msg_${turnCount}`, delta: text } });",
      "    send({ method: 'item/completed', params: { item: { id: `msg_${turnCount}`, type: 'agent_message', text } } });",
      "    send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });",
      "  }",
      "});",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "visible work prompt",
    workspacePath,
    commandEnv: {
      ...process.env,
      CODEQ8_EXECUTION_BACKEND: "runner_pool",
    },
    timeoutSeconds: 30,
    appServerContext: {
      publicBaseUrl: "https://codeq8.example",
      webChatRunToken: "header.payload.signature",
      workspaceRepository: "example-org/example-repo",
      threadId: "wct_title_hosted_skip",
      runId: "wcr_title_hosted_skip",
      threadTitle: "Untitled",
      threadTitleSource: "provisional_first_message",
      promptText: "Fix the repeated 120 second timeout before rerunning tests.",
      reportRunnerDiagnostic: async () => ({ ok: true, status: 200 }),
      createAppServerFirestoreBridgeImpl: async () => ({
        progressReporter: {
          enqueue() {},
          flush: async () => {},
        },
        createControlListener: () => ({
          start: () => {},
          stop: async () => {},
        }),
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "Done.");
  assert.equal(titleCalls.length, 1);
  assert.equal(titleCalls[0]?.workspace_repository, "example-org/example-repo");
  assert.equal(titleCalls[0]?.target_thread_id, "wct_title_hosted_skip");
  assert.equal(titleCalls[0]?.title, "Timeout contract");
  const requests = JSON.parse(await fs.readFile(requestsOutputPath, "utf8"));
  const turnStarts = requests.filter((request) => request.method === "turn/start");
  assert.equal(turnStarts.length, 2);
  assert.match(turnStarts[0]?.params?.input?.[0]?.text, /Create a concise title/);
  assert.equal(turnStarts[1]?.params?.input?.[0]?.text, "visible work prompt");
});

test("runCodex can stop after hidden setup before starting the visible task turn", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-before-main-stop-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  const requestsOutputPath = path.join(workspacePath, "codex-requests.json");
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs/promises';",
      "import readline from 'node:readline';",
      `const requestsOutputPath = ${JSON.stringify(requestsOutputPath)};`,
      "const requests = [];",
      "let persistChain = Promise.resolve();",
      "const persistRequests = () => {",
      "  persistChain = persistChain.then(() => fs.writeFile(requestsOutputPath, JSON.stringify(requests), 'utf8'));",
      "  return persistChain;",
      "};",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "rl.on('line', async (line) => {",
      "  const message = JSON.parse(line);",
      "  requests.push({ method: message.method, params: message.params || {} });",
      "  await persistRequests();",
      "  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;",
      "  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });",
      "  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_app' } } });",
      "  if (message.method === 'turn/start') send({ id: message.id, result: { turn: { id: 'turn_main', status: 'inProgress' } } });",
      "});",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "visible work prompt",
    workspacePath,
    commandEnv: process.env,
    timeoutSeconds: 30,
    beforeMainTurn: async () => ({ stop: true }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.stoppedBeforeCodex, true);
  assert.equal(result.output, "");

  const requests = JSON.parse(await fs.readFile(requestsOutputPath, "utf8"));
  assert.equal(requests.some((request) => request.method === "turn/start"), false);
});

test("runCodex falls back when hidden AppServer title pre-turn times out", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-codex-title-timeout-"));
  const fakeCodexPath = path.join(workspacePath, "fake-codex.mjs");
  const requestsOutputPath = path.join(workspacePath, "codex-requests.json");
  const originalFetch = globalThis.fetch;
  const titleCalls = [];
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/chat/runs/thread-title") {
      const body = JSON.parse(String(init.body || "{}"));
      titleCalls.push(body);
      return Response.json({
        ok: true,
        title: body.title,
        updated: true,
        thread: {
          thread_id: body.target_thread_id,
          title: body.title,
          title_source: "manual",
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs/promises';",
      "import readline from 'node:readline';",
      `const requestsOutputPath = ${JSON.stringify(requestsOutputPath)};`,
      "const requests = [];",
      "let persistChain = Promise.resolve();",
      "const persistRequests = () => {",
      "  persistChain = persistChain.then(() => fs.writeFile(requestsOutputPath, JSON.stringify(requests), 'utf8'));",
      "  return persistChain;",
      "};",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "let turnCount = 0;",
      "rl.on('line', async (line) => {",
      "  const message = JSON.parse(line);",
      "  requests.push({ method: message.method, params: message.params || {} });",
      "  await persistRequests();",
      "  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;",
      "  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });",
      "  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_app' } } });",
      "  if (message.method === 'turn/interrupt') {",
      "    send({ id: message.id, result: { ok: true } });",
      "    send({ method: 'turn/completed', params: { turn: { id: message.params.turnId, status: 'cancelled' } } });",
      "  }",
      "  if (message.method === 'turn/start') {",
      "    turnCount += 1;",
      "    const isTitleTurn = turnCount === 1;",
      "    const turnId = isTitleTurn ? 'turn_title_timeout' : 'turn_main';",
      "    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });",
      "    send({ method: 'turn/started', params: { turn: { id: turnId } } });",
      "    if (isTitleTurn) return;",
      "    send({ method: 'item/started', params: { item: { id: 'msg_main', type: 'agent_message' } } });",
      "    send({ method: 'item/agentMessage/delta', params: { item_id: 'msg_main', delta: 'Done.' } });",
      "    send({ method: 'item/completed', params: { item: { id: 'msg_main', type: 'agent_message', text: 'Done.' } } });",
      "    send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });",
      "  }",
      "});",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const progressEvents = [];
  const diagnostics = [];
  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "visible timeout prompt",
    workspacePath,
    commandEnv: process.env,
    timeoutSeconds: 30,
    appServerContext: {
      publicBaseUrl: "https://codeq8.example",
      webChatRunToken: "header.payload.signature",
      workspaceRepository: "example-org/example-repo",
      threadId: "wct_title_timeout",
      runId: "wcr_title_timeout",
      threadTitle: "Untitled",
      threadTitleSource: "provisional_first_message",
      promptText: "Fix upload retry before running node tests.",
      hiddenThreadTitlePreturnTimeoutMs: 20,
      reportRunnerDiagnostic: async (diagnostic) => {
        diagnostics.push(diagnostic);
        return { ok: true, status: 200 };
      },
      createAppServerFirestoreBridgeImpl: async () => ({
        progressReporter: {
          enqueue(event) {
            progressEvents.push(event);
          },
          flush: async () => {},
        },
        createControlListener: () => ({
          start: () => {},
          stop: async () => {},
        }),
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "Done.");
  assert.equal(titleCalls.length, 1);
  assert.equal(titleCalls[0]?.title, "Fix upload retry before");
  assert.deepEqual(progressEvents.map((event) => event.label), []);
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.event === "runner_hidden_thread_title_preturn_finished"),
    true,
  );

  const requests = JSON.parse(await fs.readFile(requestsOutputPath, "utf8"));
  assert.equal(requests.filter((request) => request.method === "turn/start").length, 2);
  assert.equal(requests.some((request) => request.method === "turn/interrupt"), true);
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
  assert.match(result.reason, /Codex app-server exited with code=1 signal=none/i);
  assert.match(result.diagnosticOutput, /refresh_token_reused/i);
});

async function writeFakeCodexAppServer(
  fakeCodexPath,
  {
    argsOutputPath = "",
    envOutputPath = "",
    requestsOutputPath = "",
    agentMessage = "done",
    commandLabel = "npm test",
    delayTurnCompletionMs = 0,
    goalGetReturnsEmpty = false,
    goalApisUnsupported = false,
  } = {},
) {
  await fs.writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs/promises';",
      "import readline from 'node:readline';",
      `const argsOutputPath = ${JSON.stringify(argsOutputPath)};`,
      `const envOutputPath = ${JSON.stringify(envOutputPath)};`,
      `const requestsOutputPath = ${JSON.stringify(requestsOutputPath)};`,
      `const agentMessage = ${JSON.stringify(agentMessage)};`,
      `const commandLabel = ${JSON.stringify(commandLabel)};`,
      `const delayTurnCompletionMs = ${JSON.stringify(delayTurnCompletionMs)};`,
      `const goalGetReturnsEmpty = ${JSON.stringify(goalGetReturnsEmpty)};`,
      `const goalApisUnsupported = ${JSON.stringify(goalApisUnsupported)};`,
      "const agentMessages = Array.isArray(agentMessage) ? agentMessage : [agentMessage];",
      "if (argsOutputPath) await fs.writeFile(argsOutputPath, JSON.stringify(process.argv.slice(2)), 'utf8');",
      "if (envOutputPath) await fs.writeFile(envOutputPath, process.env.NODE_OPTIONS || '', 'utf8');",
      "const requests = [];",
      "let persistChain = Promise.resolve();",
      "const persistRequests = async () => {",
      "  if (!requestsOutputPath) return;",
      "  persistChain = persistChain.then(() => fs.writeFile(requestsOutputPath, JSON.stringify(requests), 'utf8'));",
      "  await persistChain;",
      "};",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "let goal = null;",
      "rl.on('line', async (line) => {",
      "  const message = JSON.parse(line);",
      "  requests.push({ method: message.method, params: message.params || {} });",
      "  await persistRequests();",
      "  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;",
      "  if (goalApisUnsupported && String(message.method || '').startsWith('thread/goal/')) {",
      "    send({ id: message.id, error: { message: `Invalid request: unknown variant \\`${message.method}\\`, expected one of \\`initialize\\`, \\`thread/start\\`, \\`thread/resume\\`, \\`turn/start\\`` } });",
      "    return;",
      "  }",
      "  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });",
      "  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_app' } } });",
      "  if (message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: message.params?.threadId || 'thr_app' } } });",
      "  if (message.method === 'thread/goal/set') {",
      "    goal = {",
      "      threadId: message.params?.threadId || 'thr_app',",
      "      objective: message.params?.objective || '',",
      "      status: message.params?.status || 'active',",
      "      tokenBudget: message.params?.tokenBudget ?? null,",
      "      tokensUsed: 0,",
      "      timeUsedSeconds: 0,",
      "      createdAt: 1000,",
      "      updatedAt: 1000,",
      "    };",
      "    send({ id: message.id, result: { goal } });",
      "  }",
      "  if (message.method === 'thread/goal/get') send({ id: message.id, result: goalGetReturnsEmpty ? {} : { goal } });",
      "  if (message.method === 'thread/goal/clear') { goal = null; send({ id: message.id, result: { cleared: true } }); }",
      "  if (message.method === 'turn/start') {",
      "    send({ id: message.id, result: { turn: { id: 'turn_app', status: 'inProgress' } } });",
      "    send({ method: 'item/started', params: { item: { type: 'command_execution', command: commandLabel } } });",
      "    send({ method: 'item/started', params: { item: { id: 'msg_fake', type: 'agent_message' } } });",
      "    for (const delta of agentMessages) send({ method: 'item/agentMessage/delta', params: { item_id: 'msg_fake', delta } });",
      "    const completeTurn = () => {",
      "      send({ method: 'item/completed', params: { item: { id: 'msg_fake', type: 'agent_message', text: agentMessages.join('') } } });",
      "      send({ method: 'item/completed', params: { item: { type: 'command_execution', command: commandLabel } } });",
      "      send({ method: 'turn/completed', params: { turn: { id: 'turn_app', status: 'completed' } } });",
      "    };",
      "    if (delayTurnCompletionMs > 0) setTimeout(completeTurn, delayTurnCompletionMs);",
      "    else completeTurn();",
      "  }",
      "  if (message.method === 'turn/steer') {",
      "    if (message.params?.expectedTurnId !== 'turn_app') send({ id: message.id, error: { message: 'missing field expectedTurnId' } });",
      "    else send({ id: message.id, result: { ok: true } });",
      "  }",
      "  if (message.method === 'turn/interrupt') send({ id: message.id, result: { ok: true } });",
      "});",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

async function captureRunnerOutput(callback) {
  const originalConsoleLog = console.log;
  const originalStderrWrite = process.stderr.write;
  const logs = [];
  const stderr = [];
  console.log = (...args) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  process.stderr.write = (chunk, encoding, callbackOrError) => {
    stderr.push(String(chunk || ""));
    const callbackFn = typeof encoding === "function" ? encoding : callbackOrError;
    if (typeof callbackFn === "function") {
      callbackFn();
    }
    return true;
  };
  try {
    const result = await callback();
    return {
      result,
      logs: logs.join("\n"),
      stderr: stderr.join(""),
    };
  } finally {
    console.log = originalConsoleLog;
    process.stderr.write = originalStderrWrite;
  }
}

function git(workspacePath, args) {
  execFileSync("git", args, { cwd: workspacePath, env: process.env });
}

function gitWithEnv(workspacePath, args, env) {
  execFileSync("git", args, { cwd: workspacePath, env });
}

function runCredentialHelperGet({ helperPath, input, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helperPath, "get"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
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

function readHeadCommitSha(workspacePath) {
  return String(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspacePath,
      env: process.env,
      encoding: "utf8",
    }) || "",
  ).trim();
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
      threadTitleSource: "provisional_first_message",
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

    assert.match(prompt, /server-owned fresh prompt/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://codeq8.example.com/api/chat/runs/prompt");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer header.payload.signature");
    assert.equal(calls[0]?.body?.mode, "fresh");
    assert.equal(calls[0]?.body?.workspace_repository, "Codeq8/Codeq8");
    assert.equal(calls[0]?.body?.thread_id, "wct_123");
    assert.equal(calls[0]?.body?.thread_title, "Fix the runner");
    assert.equal(calls[0]?.body?.thread_title_source, "provisional_first_message");
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
      threadTitleSource: "provisional_first_message",
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
      codeq8Cli: { available: true },
      attachments: [],
      referencedThreads: [],
      targetShift: true,
    });

    assert.equal(prompt, "server-owned resume prompt");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://codeq8.example.com/api/chat/runs/prompt");
    assert.equal(calls[0]?.body?.mode, "resume");
    assert.equal(calls[0]?.body?.thread_title_source, "provisional_first_message");
    assert.equal(calls[0]?.body?.target_shift, true);
    assert.equal(calls[0]?.body?.codeq8_cli_available, true);
    assert.equal(calls[0]?.body?.recent_user_messages_prompt_text, "Recent user context");
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("prepareGitHubCliAuth refreshes gh tokens before each invocation", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-gh-refresh-"));
  const fakeBinPath = path.join(tempDir, "fake-bin");
  const runtimeHomePath = path.join(tempDir, "runtime");
  const helperStatePath = path.join(tempDir, "helper-count.txt");
  const helperCallLogPath = path.join(tempDir, "helper-call-log.txt");
  const ghCallLogPath = path.join(tempDir, "gh-call-log.txt");
  await fs.mkdir(fakeBinPath, { recursive: true });

  const fakeGhPath = path.join(fakeBinPath, "gh");
  await fs.writeFile(
    fakeGhPath,
    [
      "#!/bin/sh",
      `log_path=${JSON.stringify(ghCallLogPath)}`,
      "printf 'GH_TOKEN=%s\\nGITHUB_TOKEN=%s\\nARGS=%s\\n' \"$GH_TOKEN\" \"$GITHUB_TOKEN\" \"$*\" >> \"$log_path\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await fs.chmod(fakeGhPath, 0o755);

  const helperPath = path.join(tempDir, "token-helper.sh");
  await fs.writeFile(
    helperPath,
    [
      "#!/bin/sh",
      `state_path=${JSON.stringify(helperStatePath)}`,
      `call_log_path=${JSON.stringify(helperCallLogPath)}`,
      'printf "%s\\n" "$*" >> "$call_log_path"',
      'count="$(cat "$state_path" 2>/dev/null || printf 0)"',
      'count="$((count + 1))"',
      'printf "%s" "$count" > "$state_path"',
      'repo="${2:-primary}"',
      'safe_repo="$(printf "%s" "$repo" | tr "/" "-")"',
      'printf "fresh-token-%s-%s" "$count" "$safe_repo"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await fs.chmod(helperPath, 0o755);

  const originalPath = `${fakeBinPath}${path.delimiter}${process.env.PATH || ""}`;
  const commandEnv = {
    ...process.env,
    PATH: originalPath,
    CODEX_GITHUB_WRITE_TOKEN: "startup-token",
    CODEX_GITHUB_TOKEN_HELPER_PATH: helperPath,
  };

  const prepared = await prepareGitHubCliAuth({
    commandEnv,
    runtimeHomePath,
  });
  assert.equal(prepared.available, true);
  assert.equal(prepared.wrappedBinPath, fakeGhPath);
  assert.equal(prepared.binPath, path.join(runtimeHomePath, "bin", "gh"));
  assert.equal(commandEnv.GH_TOKEN, "fresh-token-1-primary");
  assert.equal(commandEnv.GITHUB_TOKEN, "fresh-token-1-primary");
  const escapedRuntimeBinPath = path
    .join(runtimeHomePath, "bin")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(commandEnv.PATH, new RegExp(`^${escapedRuntimeBinPath}${path.delimiter}`));

  execFileSync("gh", ["pr", "view", "1", "--repo", "Codeq8/status"], {
    env: commandEnv,
    encoding: "utf8",
    stdio: "pipe",
  });
  execFileSync("gh", ["run", "view", "2", "-R", "Codeq8/codeq8-action"], {
    env: commandEnv,
    encoding: "utf8",
    stdio: "pipe",
  });
  execFileSync("gh", ["api", "repos/Codeq8/status/pulls"], {
    env: commandEnv,
    encoding: "utf8",
    stdio: "pipe",
  });
  execFileSync("gh", ["issue", "list"], {
    env: {
      ...commandEnv,
      GH_REPO: "Codeq8/status",
    },
    encoding: "utf8",
    stdio: "pipe",
  });

  const ghCallLog = await fs.readFile(ghCallLogPath, "utf8");
  assert.match(ghCallLog, /GH_TOKEN=fresh-token-2-Codeq8-status/);
  assert.match(ghCallLog, /GITHUB_TOKEN=fresh-token-2-Codeq8-status/);
  assert.match(ghCallLog, /ARGS=pr view 1 --repo Codeq8\/status/);
  assert.match(ghCallLog, /GH_TOKEN=fresh-token-3-Codeq8-codeq8-action/);
  assert.match(ghCallLog, /GITHUB_TOKEN=fresh-token-3-Codeq8-codeq8-action/);
  assert.match(ghCallLog, /ARGS=run view 2 -R Codeq8\/codeq8-action/);
  assert.match(ghCallLog, /GH_TOKEN=fresh-token-4-Codeq8-status/);
  assert.match(ghCallLog, /GITHUB_TOKEN=fresh-token-4-Codeq8-status/);
  assert.match(ghCallLog, /ARGS=api repos\/Codeq8\/status\/pulls/);
  assert.match(ghCallLog, /GH_TOKEN=fresh-token-5-Codeq8-status/);
  assert.match(ghCallLog, /GITHUB_TOKEN=fresh-token-5-Codeq8-status/);
  assert.match(ghCallLog, /ARGS=issue list/);
  assert.doesNotMatch(ghCallLog, /startup-token/);

  const helperCallLog = await fs.readFile(helperCallLogPath, "utf8");
  assert.match(helperCallLog, /^print-token$/m);
  assert.match(helperCallLog, /^print-token Codeq8\/status$/m);
  assert.match(helperCallLog, /^print-token Codeq8\/codeq8-action$/m);
});

test("requestWorkspaceGitToken does not fall back to admin tokens", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return Response.json({ ok: true, token: "unexpected-token" });
  };

  try {
    await assert.rejects(
      () =>
        requestWorkspaceGitToken({
          publicBaseUrl: "https://codeq8.example",
          adminToken: "header.payload.signature",
          webChatRunToken: "",
          workspaceRepository: "Codeq8/Codeq8",
        }),
      /A scoped CODE_WEB_CHAT_RUN_TOKEN is required to mint a GitHub repository token/,
    );
    assert.equal(requestCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted prepared workspace plan requires runner pool, matching repo/path, and token", () => {
  const baseArgs = {
    workspacePath: "/tmp/codeq8-hosted-workspace",
    workspaceRepository: "Codeq8/test",
    commandEnv: {
      CODEQ8_EXECUTION_BACKEND: "runner_pool",
      CODEQ8_HOSTED_PREPARED_WORKSPACE: "1",
      CODEQ8_HOSTED_PREPARED_WORKSPACE_PATH: "/tmp/codeq8-hosted-workspace",
      CODEQ8_HOSTED_PREPARED_WORKSPACE_REPOSITORY: "Codeq8/test",
      CODEX_GITHUB_WRITE_TOKEN: "prepared-token",
    },
  };

  assert.deepEqual(resolveHostedPrecheckedWorkspacePlan(baseArgs), {
    enabled: true,
    reason: "",
    gitToken: "prepared-token",
  });
  assert.deepEqual(
    resolveHostedPrecheckedWorkspacePlan({
      ...baseArgs,
      commandEnv: {
        ...baseArgs.commandEnv,
        CODEX_GITHUB_WRITE_TOKEN: "",
        CODEQ8_GITHUB_REPOSITORY_TOKEN: "compatibility-token",
      },
    }),
    {
      enabled: false,
      reason: "missing_hosted_git_token",
      gitToken: "",
    },
  );
  assert.equal(
    resolveHostedPrecheckedWorkspacePlan({
      ...baseArgs,
      commandEnv: {
        ...baseArgs.commandEnv,
        CODEQ8_EXECUTION_BACKEND: "github_actions",
      },
    }).reason,
    "not_runner_pool",
  );
  assert.equal(
    resolveHostedPrecheckedWorkspacePlan({
      ...baseArgs,
      commandEnv: {
        ...baseArgs.commandEnv,
        CODEQ8_HOSTED_PREPARED_WORKSPACE_REPOSITORY: "Codeq8/other",
      },
    }).reason,
    "repository_mismatch",
  );
  assert.equal(
    resolveHostedPrecheckedWorkspacePlan({
      ...baseArgs,
      commandEnv: {
        ...baseArgs.commandEnv,
        CODEQ8_HOSTED_PREPARED_WORKSPACE_PATH: "/tmp/other-workspace",
      },
    }).reason,
    "path_mismatch",
  );
  assert.equal(
    resolveHostedPrecheckedWorkspacePlan({
      ...baseArgs,
      commandEnv: {
        ...baseArgs.commandEnv,
        CODEX_GITHUB_WRITE_TOKEN: "",
        CODEQ8_GITHUB_REPOSITORY_TOKEN: "",
      },
    }).reason,
    "missing_hosted_git_token",
  );
});

test("prepareHostedPrecheckedWorkspace rejects fork direct-push reuse", async () => {
  await assert.rejects(
    () =>
      prepareHostedPrecheckedWorkspace({
        workspacePath: "/tmp/codeq8-hosted-workspace",
        workspaceRepository: "Codeq8/test",
        sourceType: "pull_request",
        branchContext: {
          default_branch: "main",
          protected_branches: ["main"],
          production_branch: "production",
          context_branch: "feature",
          write_mode: "direct_push",
          write_branch: "feature",
          base_branch: "main",
          pull_request_number: "123",
          pull_request_head_branch: "feature",
        },
        pullRequestHeadRepository: "external/test-fork",
        commandEnv: {
          CODE_PUBLIC_BASE_URL: "https://codeq8.example.com",
          CODEQ8_HOSTED_PREPARED_WORKSPACE_REPOSITORY: "Codeq8/test",
        },
        githubLogin: "aalzanki",
        githubWriteToken: "prepared-token",
      }),
    /fork direct-push/,
  );
});

test("prepareHostedPrecheckedWorkspace reuses a VM-prepared checkout without cloning", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-hosted-prechecked-"));
  const remotePath = path.join(tempRoot, "remote.git");
  const seedPath = path.join(tempRoot, "seed");
  const workspacePath = path.join(tempRoot, "workspace");
  const configPath = path.join(tempRoot, "gitconfig");
  const remoteUrl = "https://github.com/Codeq8/test.git";
  const commandEnv = {
    ...process.env,
    CODE_PUBLIC_BASE_URL: "https://codeq8.example.com",
    CODEQ8_EXECUTION_BACKEND: "runner_pool",
    CODEQ8_HOSTED_PREPARED_WORKSPACE: "1",
    CODEQ8_HOSTED_PREPARED_WORKSPACE_PATH: workspacePath,
    CODEQ8_HOSTED_PREPARED_WORKSPACE_REPOSITORY: "Codeq8/test",
    CODEX_GITHUB_WRITE_TOKEN: "prepared-token",
    GIT_CONFIG_GLOBAL: configPath,
    GIT_TERMINAL_PROMPT: "0",
  };

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

    gitWithEnv(tempRoot, [
      "config",
      "--file",
      configPath,
      `url.${remotePath}.insteadOf`,
      remoteUrl,
    ], commandEnv);
    gitWithEnv(tempRoot, ["clone", remoteUrl, workspacePath], commandEnv);

    const prepared = await prepareHostedPrecheckedWorkspace({
      workspacePath,
      workspaceRepository: "Codeq8/test",
      sourceType: "default_branch",
      branchContext: {
        default_branch: "main",
        protected_branches: ["main"],
        production_branch: "production",
        context_branch: "main",
        write_mode: "branch_and_pr",
        write_branch: "codeq8/hosted-fast-start",
        base_branch: "main",
      },
      pullRequestHeadRepository: "",
      commandEnv,
      githubLogin: "aalzanki",
      githubWriteToken: "prepared-token",
    });

    assert.equal(prepared.workspacePath, workspacePath);
    assert.equal(prepared.cloneRepository, "Codeq8/test");
    assert.equal(prepared.effectiveWriteBranch, "codeq8/hosted-fast-start");
    assert.equal(prepared.durableWriteBranch, "codeq8/hosted-fast-start");
    assert.equal(prepared.hostedPrepared, true);
    assert.equal(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: workspacePath,
        env: commandEnv,
        encoding: "utf8",
      }).trim(),
      "codeq8/hosted-fast-start",
    );
    assert.equal(
      execFileSync("git", ["config", "--local", "--get", "remote.origin.url"], {
        cwd: workspacePath,
        env: commandEnv,
        encoding: "utf8",
      }).trim(),
      remoteUrl,
    );
    assert.match(
      execFileSync("git", ["config", "--local", "--get-all", "credential.helper"], {
        cwd: workspacePath,
        env: commandEnv,
        encoding: "utf8",
      }),
      /codeq8-github-token-helper\.mjs/,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("workspace preparation metadata carries hosted fast-start hints", () => {
  assert.deepEqual(
    buildWorkspacePreparationRunMetadata({
      preparedWorkspace: { hostedPrepared: true },
      commandEnv: {
        CODEQ8_HOSTED_PROGRESS_CALLBACK_WARNING: "fetch failed",
      },
    }),
    {
      hosted_runner_public_action_prepared_workspace: true,
      hosted_runner_progress_callback_warning: "fetch failed",
    },
  );

  const longWarning = "x".repeat(1_200);
  const metadata = buildWorkspacePreparationRunMetadata({
    preparedWorkspace: { hostedPrepared: false },
    commandEnv: {
      CODEQ8_HOSTED_PROGRESS_CALLBACK_WARNING: longWarning,
    },
  });
  assert.equal(metadata.hosted_runner_progress_callback_warning.length, 1_000);
  assert.equal(metadata.hosted_runner_public_action_prepared_workspace, undefined);
});

test("public action startup timing metadata is bounded to numeric phases", () => {
  const metadata = buildPublicActionStartupTimingMetadata({
    appServerTimings: {
      before_main_turn: 789.6,
      ignored: -1,
    },
    timings: {
      runtime_manifest_ready: 12.2,
      prompt_ready: 456.8,
      skipped: "not-a-number",
    },
  });

  assert.equal(
    typeof metadata.hosted_runner_public_action_process_started_at_ms,
    "number",
  );
  assert.equal(
    typeof metadata.hosted_runner_public_action_running_callback_ready_ms,
    "number",
  );
  assert.equal(metadata.hosted_runner_public_action_runtime_manifest_ready_ms, 12);
  assert.equal(metadata.hosted_runner_public_action_prompt_ready_ms, 457);
  assert.equal(
    metadata.hosted_runner_public_action_app_server_before_main_turn_ms,
    790,
  );
  assert.equal(metadata.hosted_runner_public_action_skipped_ms, undefined);
  assert.equal(
    metadata.hosted_runner_public_action_app_server_ignored_ms,
    undefined,
  );
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

test("persistWorkspaceProgress rebases and retries remembered branch push after remote branch advances", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-action-persist-push-rebase-"));
  const remotePath = path.join(tempRoot, "remote.git");
  const seedPath = path.join(tempRoot, "seed");
  const workspacePath = path.join(tempRoot, "workspace");
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => Response.json([]);
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

    await fs.writeFile(path.join(workspacePath, "feature.txt"), "local\n");
    git(workspacePath, ["add", "feature.txt"]);
    git(workspacePath, ["commit", "-m", "Local follow-up"]);

    git(seedPath, ["fetch", "origin", "feature/test:feature/test"]);
    git(seedPath, ["checkout", "feature/test"]);
    await fs.writeFile(path.join(seedPath, "remote.txt"), "remote\n");
    git(seedPath, ["add", "remote.txt"]);
    git(seedPath, ["commit", "-m", "Remote branch update"]);
    git(seedPath, ["push", "origin", "feature/test"]);

    const result = await persistWorkspaceProgress({
      workspacePath,
      commandEnv: process.env,
      sourceType: "default_branch",
      branch: "feature/test",
      writeMode: "branch_and_pr",
      repository: "Codeq8/codeq8-action",
      headRepository: "Codeq8/codeq8-action",
      baseBranch: "main",
      gitToken: "github-token",
      protectedBranches: ["main"],
      baselineState: null,
      threadId: "wct_rebase",
      runId: "wcr_rebase",
    });

    assert.equal(result.error, "");
    assert.equal(result.pendingRemoteSync, "");
    assert.equal(result.pushed, true);
    assert.equal(result.rescueBranch, "");
    assert.equal(result.resolvedWriteBranch, "feature/test");
    assert.equal(readAheadCount(workspacePath, "feature/test"), 0);
    assert.equal(
      execFileSync("git", ["show", "feature/test:feature.txt"], {
        cwd: workspacePath,
        env: process.env,
        encoding: "utf8",
      }),
      "local\n",
    );
    assert.equal(
      execFileSync("git", ["show", "feature/test:remote.txt"], {
        cwd: workspacePath,
        env: process.env,
        encoding: "utf8",
      }),
      "remote\n",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("persistWorkspaceProgress backs up remembered branch when non-fast-forward rebase is unsafe", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-action-persist-push-rescue-"));
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

    await fs.writeFile(path.join(workspacePath, "feature.txt"), "local\n");
    git(workspacePath, ["add", "feature.txt"]);
    git(workspacePath, ["commit", "-m", "Local follow-up"]);
    await fs.writeFile(path.join(workspacePath, "dirty.txt"), "dirty\n");

    git(seedPath, ["fetch", "origin", "feature/test:feature/test"]);
    git(seedPath, ["checkout", "feature/test"]);
    await fs.writeFile(path.join(seedPath, "remote.txt"), "remote\n");
    git(seedPath, ["add", "remote.txt"]);
    git(seedPath, ["commit", "-m", "Remote branch update"]);
    git(seedPath, ["push", "origin", "feature/test"]);

    const result = await persistWorkspaceProgress({
      workspacePath,
      commandEnv: process.env,
      sourceType: "default_branch",
      branch: "feature/test",
      writeMode: "branch_and_pr",
      repository: "Codeq8/codeq8-action",
      headRepository: "Codeq8/codeq8-action",
      baseBranch: "main",
      gitToken: "github-token",
      protectedBranches: ["main"],
      baselineState: null,
      threadId: "wct_push_rescue",
      runId: "wcr_push_rescue",
    });

    const rescueBranch = "codeq8/rescue/wct_push_rescue/wcr_push_rescue";
    const remoteHeads = execFileSync(
      "git",
      ["ls-remote", "--heads", "origin", rescueBranch],
      { cwd: workspacePath, env: process.env, encoding: "utf8" },
    );

    assert.equal(result.error, "");
    assert.equal(result.pendingRemoteSync, "");
    assert.equal(result.pushed, true);
    assert.equal(result.rescueBranch, rescueBranch);
    assert.equal(result.rescueOriginalBranch, "feature/test");
    assert.equal(result.rescuedDirtyWork, true);
    assert.equal(result.resolvedWriteBranch, rescueBranch);
    assert.match(remoteHeads.trim(), new RegExp(`refs/heads/${rescueBranch}$`));
    assert.equal(
      execFileSync("git", ["show", `${rescueBranch}:dirty.txt`], {
        cwd: workspacePath,
        env: process.env,
        encoding: "utf8",
      }),
      "dirty\n",
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("persistWorkspaceProgress pushes committed new remembered branches even with dirty artifacts", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-action-persist-new-dirty-"));
  const remotePath = path.join(tempRoot, "remote.git");
  const seedPath = path.join(tempRoot, "seed");
  const workspacePath = path.join(tempRoot, "workspace");
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => Response.json([]);
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
    git(workspacePath, ["checkout", "-b", "add-staging-deployed-e2e-gate", "origin/main"]);
    const baselineState = {
      headCommitSha: readHeadCommitSha(workspacePath),
      statusFingerprint: "",
    };

    await fs.writeFile(path.join(workspacePath, "e2e-gate.txt"), "committed\n");
    git(workspacePath, ["add", "e2e-gate.txt"]);
    git(workspacePath, ["commit", "-m", "Add staging deployed e2e gate"]);
    await fs.mkdir(path.join(workspacePath, "test-results"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "test-results", ".last-run.json"), "{}\n");

    const result = await persistWorkspaceProgress({
      workspacePath,
      commandEnv: process.env,
      sourceType: "default_branch",
      branch: "add-staging-deployed-e2e-gate",
      writeMode: "branch_and_pr",
      repository: "Codeq8/Codeq8",
      headRepository: "Codeq8/Codeq8",
      baseBranch: "main",
      gitToken: "github-token",
      protectedBranches: ["main"],
      baselineState,
    });

    const remoteHeads = execFileSync(
      "git",
      ["ls-remote", "--heads", "origin", "add-staging-deployed-e2e-gate"],
      { cwd: workspacePath, env: process.env, encoding: "utf8" },
    );

    assert.equal(result.error, "");
    assert.equal(result.pendingRemoteSync, "");
    assert.equal(result.pushed, true);
    assert.equal(result.resolvedWriteBranch, "add-staging-deployed-e2e-gate");
    assert.match(remoteHeads, /refs\/heads\/add-staging-deployed-e2e-gate/);
    assert.match(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: workspacePath,
        env: process.env,
        encoding: "utf8",
      }),
      /test-results\//,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("persistWorkspaceProgress pushes committed new branches when the base ref is unavailable", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-action-persist-missing-base-"));
  const remotePath = path.join(tempRoot, "remote.git");
  const seedPath = path.join(tempRoot, "seed");
  const workspacePath = path.join(tempRoot, "workspace");
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => Response.json([]);
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
    git(workspacePath, ["checkout", "-b", "codeq8/remove-human-review-policy", "origin/main"]);
    const baselineState = {
      headCommitSha: readHeadCommitSha(workspacePath),
      statusFingerprint: "",
    };

    await fs.writeFile(path.join(workspacePath, "codeq8.json"), '{ "review": false }\n');
    git(workspacePath, ["add", "codeq8.json"]);
    git(workspacePath, ["commit", "-m", "Remove human review policy"]);
    git(workspacePath, ["update-ref", "-d", "refs/remotes/origin/main"]);

    const result = await persistWorkspaceProgress({
      workspacePath,
      commandEnv: process.env,
      sourceType: "default_branch",
      branch: "codeq8/remove-human-review-policy",
      writeMode: "branch_and_pr",
      repository: "Codeq8/Codeq8",
      headRepository: "Codeq8/Codeq8",
      baseBranch: "main",
      gitToken: "github-token",
      protectedBranches: ["main"],
      baselineState,
    });

    const remoteHeads = execFileSync(
      "git",
      ["ls-remote", "--heads", "origin", "codeq8/remove-human-review-policy"],
      { cwd: workspacePath, env: process.env, encoding: "utf8" },
    );

    assert.equal(result.error, "");
    assert.equal(result.pendingRemoteSync, "");
    assert.equal(result.pushed, true);
    assert.equal(result.resolvedWriteBranch, "codeq8/remove-human-review-policy");
    assert.match(remoteHeads, /refs\/heads\/codeq8\/remove-human-review-policy/);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("persistWorkspaceProgress backs up dirty local-only remembered branches", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-action-persist-dirty-rescue-"));
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
    git(workspacePath, ["checkout", "-b", "feature/local-draft", "origin/main"]);
    const baselineState = {
      headCommitSha: readHeadCommitSha(workspacePath),
      statusFingerprint: "",
    };

    await fs.writeFile(path.join(workspacePath, "draft.txt"), "draft work\n");

    const result = await persistWorkspaceProgress({
      workspacePath,
      commandEnv: process.env,
      sourceType: "default_branch",
      branch: "feature/local-draft",
      writeMode: "branch_and_pr",
      repository: "Codeq8/codeq8-action",
      headRepository: "Codeq8/codeq8-action",
      baseBranch: "main",
      gitToken: "",
      protectedBranches: ["main"],
      baselineState,
      threadId: "wct_dirty",
      runId: "wcr_dirty",
    });

    const rescueBranch = "codeq8/rescue/wct_dirty/wcr_dirty";
    const remoteHeads = execFileSync(
      "git",
      ["ls-remote", "--heads", "origin", rescueBranch],
      { cwd: workspacePath, env: process.env, encoding: "utf8" },
    );

    assert.equal(result.error, "");
    assert.equal(result.pendingRemoteSync, "");
    assert.equal(result.pushed, true);
    assert.equal(result.rescueBranch, rescueBranch);
    assert.equal(result.rescueOriginalBranch, "feature/local-draft");
    assert.equal(result.rescuedDirtyWork, true);
    assert.equal(result.resolvedWriteBranch, rescueBranch);
    assert.match(remoteHeads.trim(), new RegExp(`refs/heads/${rescueBranch}$`));
    assert.equal(
      execFileSync("git", ["show", `${rescueBranch}:draft.txt`], {
        cwd: workspacePath,
        env: process.env,
        encoding: "utf8",
      }),
      "draft work\n",
    );
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: workspacePath,
        env: process.env,
        encoding: "utf8",
      }),
      "",
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("persistWorkspaceProgress accepts clean protected branch fast-forwards already synced to origin", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-action-persist-protected-sync-"));
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
    git(workspacePath, ["checkout", "main"]);
    const baselineState = {
      headCommitSha: readHeadCommitSha(workspacePath),
      statusFingerprint: "",
    };

    await fs.writeFile(path.join(seedPath, "README.md"), "merged\n");
    git(seedPath, ["add", "README.md"]);
    git(seedPath, ["commit", "-m", "Merge accepted PR"]);
    git(seedPath, ["push", "origin", "main"]);
    git(workspacePath, ["fetch", "origin", "main"]);
    git(workspacePath, ["merge", "--ff-only", "origin/main"]);

    const result = await persistWorkspaceProgress({
      workspacePath,
      commandEnv: process.env,
      sourceType: "default_branch",
      branch: "main",
      writeMode: "branch_and_pr",
      repository: "Codeq8/codeq8-action",
      headRepository: "Codeq8/codeq8-action",
      baseBranch: "main",
      gitToken: "",
      protectedBranches: ["main"],
      baselineState,
    });

    assert.equal(result.error, "");
    assert.equal(result.skippedProtectedBranch, "");
    assert.equal(result.pendingRemoteSync, "");
    assert.equal(result.pushed, false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("persistWorkspaceProgress backs up configured protected branch progress", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-action-persist-protected-rescue-"));
  const remotePath = path.join(tempRoot, "remote.git");
  const seedPath = path.join(tempRoot, "seed");
  const workspacePath = path.join(tempRoot, "workspace");

  try {
    git(tempRoot, ["init", "--bare", remotePath]);
    await fs.mkdir(seedPath, { recursive: true });
    git(seedPath, ["init"]);
    git(seedPath, ["checkout", "-b", "trunk"]);
    git(seedPath, ["config", "user.name", "Codeq8 Test"]);
    git(seedPath, ["config", "user.email", "codeq8@example.com"]);
    await fs.writeFile(path.join(seedPath, "README.md"), "seed\n");
    git(seedPath, ["add", "README.md"]);
    git(seedPath, ["commit", "-m", "Initial commit"]);
    git(seedPath, ["remote", "add", "origin", remotePath]);
    git(seedPath, ["push", "-u", "origin", "trunk"]);
    git(seedPath, ["checkout", "-b", "release"]);
    git(seedPath, ["push", "-u", "origin", "release"]);

    git(tempRoot, ["clone", remotePath, workspacePath]);
    git(workspacePath, ["checkout", "release"]);
    git(workspacePath, ["config", "user.name", "Codeq8 Test"]);
    git(workspacePath, ["config", "user.email", "codeq8@example.com"]);
    const baselineState = {
      headCommitSha: readHeadCommitSha(workspacePath),
      statusFingerprint: "",
    };

    await fs.writeFile(path.join(workspacePath, "protected.txt"), "local\n");
    git(workspacePath, ["add", "protected.txt"]);
    git(workspacePath, ["commit", "-m", "Local protected branch work"]);

    const result = await persistWorkspaceProgress({
      workspacePath,
      commandEnv: process.env,
      sourceType: "default_branch",
      branch: "release",
      writeMode: "branch_and_pr",
      repository: "Codeq8/codeq8-action",
      headRepository: "Codeq8/codeq8-action",
      baseBranch: "trunk",
      gitToken: "",
      protectedBranches: ["release"],
      baselineState,
      threadId: "wct_release",
      runId: "wcr_release",
    });

    const rescueBranch = "codeq8/rescue/wct_release/wcr_release";
    const remoteHeads = execFileSync(
      "git",
      ["ls-remote", "--heads", "origin", rescueBranch],
      { cwd: workspacePath, env: process.env, encoding: "utf8" },
    );

    assert.equal(result.error, "");
    assert.equal(result.pendingRemoteSync, "");
    assert.equal(result.pushed, true);
    assert.equal(result.rescueBranch, rescueBranch);
    assert.equal(result.rescueOriginalBranch, "release");
    assert.equal(result.rescuedDirtyWork, false);
    assert.equal(result.resolvedWriteBranch, rescueBranch);
    assert.match(remoteHeads.trim(), new RegExp(`refs/heads/${rescueBranch}$`));
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
    assert.match(helperScript, /resolveRequestedRepository/);
    assert.match(helperScript, /request\.path/);
    assert.match(helperScript, /workspace_repository: requestedRepository/);
    assert.doesNotMatch(
      helperScript,
      /Refusing to request a GitHub token for non-workspace repository/,
    );
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test("workspace git credential helper reuses the prepared primary workspace token", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-action-credential-helper-"));
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "unexpected request" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(() => {
    server.close();
  });

  try {
    git(workspacePath, ["init"]);
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    const helperPath = await configureWorkspaceGitCredentialHelper({
      workspacePath,
      commandEnv: process.env,
      publicBaseUrl: `http://127.0.0.1:${address.port}`,
      workspaceRepository: "Codeq8/Codeq8",
    });

    const result = await runCredentialHelperGet({
      helperPath,
      input: [
        "protocol=https",
        "host=github.com",
        "path=Codeq8/Codeq8.git",
        "",
      ].join("\n"),
      env: {
        ...process.env,
        CODEX_GITHUB_WRITE_TOKEN: "prepared-primary-token",
      },
    });

    assert.equal(result.code, 0);
    assert.equal(
      result.stdout,
      "username=x-access-token\npassword=prepared-primary-token\n\n",
    );
    assert.equal(result.stderr, "");
    assert.equal(requestCount, 0);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test("workspace git credential helper requests linked repository tokens by path", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-action-credential-helper-"));
  const requests = [];
  const server = createServer((request, response) => {
    let rawBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      rawBody += chunk;
    });
    request.on("end", () => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(rawBody || "{}"),
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, token: "ghs_linked_repo_token" }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(() => {
    server.close();
  });

  try {
    git(workspacePath, ["init"]);
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    const helperPath = await configureWorkspaceGitCredentialHelper({
      workspacePath,
      commandEnv: process.env,
      publicBaseUrl: `http://127.0.0.1:${address.port}`,
      workspaceRepository: "miniExtensions/monorepo",
    });

    const result = await runCredentialHelperGet({
      helperPath,
      input: [
        "protocol=https",
        "host=github.com",
        "path=miniExtensions/webapp.git/",
        "",
      ].join("\n"),
      env: {
        ...process.env,
        CODE_WEB_CHAT_RUN_TOKEN: "scoped.run.token",
      },
    });

    assert.equal(result.code, 0);
    assert.equal(
      result.stdout,
      "username=x-access-token\npassword=ghs_linked_repo_token\n\n",
    );
    assert.equal(result.stderr, "");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.authorization, "Bearer scoped.run.token");
    assert.deepEqual(requests[0]?.body, {
      workspace_repository: "miniExtensions/webapp",
    });
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test("workspace git credential helper rejects malformed run tokens before refresh", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-action-credential-helper-"));
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "unexpected request" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(() => {
    server.close();
  });

  try {
    git(workspacePath, ["init"]);
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    const helperPath = await configureWorkspaceGitCredentialHelper({
      workspacePath,
      commandEnv: process.env,
      publicBaseUrl: `http://127.0.0.1:${address.port}`,
      workspaceRepository: "Codeq8/Codeq8",
    });

    const result = await runCredentialHelperGet({
      helperPath,
      input: [
        "protocol=https",
        "host=github.com",
        "path=Codeq8/status.git",
        "",
      ].join("\n"),
      env: {
        ...process.env,
        CODE_WEB_CHAT_RUN_TOKEN: "not-a-run-token",
      },
    });

    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /A scoped CODE_WEB_CHAT_RUN_TOKEN is required to mint a GitHub repository token/,
    );
    assert.equal(requestCount, 0);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test("workspace git credential helper rejects unrecognized non-empty repository paths", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-action-credential-helper-"));
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "unexpected request" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(() => {
    server.close();
  });

  try {
    git(workspacePath, ["init"]);
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    const helperPath = await configureWorkspaceGitCredentialHelper({
      workspacePath,
      commandEnv: process.env,
      publicBaseUrl: `http://127.0.0.1:${address.port}`,
      workspaceRepository: "miniExtensions/monorepo",
    });

    const result = await runCredentialHelperGet({
      helperPath,
      input: [
        "protocol=https",
        "host=github.com",
        "path=miniExtensions/webapp.git/unexpected",
        "",
      ].join("\n"),
      env: {
        ...process.env,
        CODE_WEB_CHAT_RUN_TOKEN: "scoped.run.token",
      },
    });

    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /Refusing to request a GitHub token for unrecognized repository path miniExtensions\/webapp\.git\/unexpected/,
    );
    assert.equal(requestCount, 0);
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

test("prepared codex session bundle upload prefers signed Firebase Storage URLs", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const headers = init?.headers || {};
    const contentType =
      typeof headers.get === "function"
        ? headers.get("Content-Type")
        : headers["Content-Type"] || headers["content-type"] || "";
    const bodyText = init?.body ? String(init.body) : "";
    calls.push({
      url: String(url),
      method: init?.method || "GET",
      contentType: String(contentType || ""),
      body:
        bodyText && String(contentType || "").includes("application/json")
          ? JSON.parse(bodyText)
          : bodyText || null,
    });
    if (String(url).endsWith("/upload-prepare")) {
      return Response.json({
        ok: true,
        upload_preparation: {
          storage_key: "web_chat_codex_session_blob:wct_123:94:nonce",
          storage_bucket: "bucket",
          storage_backend: "firebase_storage",
          upload_key: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          wrapped_key: "bbbb",
          wrapped_key_iv: "cccc",
          expected_bundle_revision: 93,
          next_bundle_revision: 94,
          direct_upload_url:
            "https://storage.googleapis.com/bucket/web_chat_codex_session_blob%3Awct_123%3A94%3Anonce?X-Goog-Signature=test",
          direct_upload_method: "PUT",
          direct_upload_expires_at: 1780452900000,
        },
      });
    }
    return new Response("", { status: 200 });
  };

  try {
    const prepared = await prepareWebChatCodexSessionUpload({
      workerUrl: "https://worker.example.com",
      adminToken: "secret",
      threadId: "wct_123",
      expectedBundleRevision: 93,
    });
    assert.equal(
      prepared.uploadPreparation.directUploadUrl,
      "https://storage.googleapis.com/bucket/web_chat_codex_session_blob%3Awct_123%3A94%3Anonce?X-Goog-Signature=test",
    );
    assert.equal(prepared.uploadPreparation.directUploadMethod, "PUT");
    assert.equal(prepared.uploadPreparation.directUploadExpiresAt, 1780452900000);

    await uploadPreparedWebChatCodexSessionBundle({
      workerUrl: "https://worker.example.com",
      adminToken: "secret",
      threadId: "wct_123",
      storageKey: prepared.uploadPreparation.storageKey,
      storageBucket: prepared.uploadPreparation.storageBucket,
      storageBackend: prepared.uploadPreparation.storageBackend,
      storedValue: "{\"version\":3}",
      directUploadUrl: prepared.uploadPreparation.directUploadUrl,
      directUploadMethod: prepared.uploadPreparation.directUploadMethod,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://worker.example.com/web-chat/codex-session/upload-prepare");
    assert.equal(
      calls[1]?.url,
      "https://storage.googleapis.com/bucket/web_chat_codex_session_blob%3Awct_123%3A94%3Anonce?X-Goog-Signature=test",
    );
    assert.equal(calls[1]?.method, "PUT");
    assert.equal(calls[1]?.contentType, "application/json; charset=utf-8");
    assert.deepEqual(calls[1]?.body, { version: 3 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("writeFirebaseStorageSignedTextObject reports signed upload failures", async () => {
  await assert.rejects(
    () =>
      writeFirebaseStorageSignedTextObject({
        uploadUrl:
          "https://storage.googleapis.com/bucket/web_chat_codex_session_blob%3Awct_123%3A94%3Anonce?X-Goog-Signature=test",
        storedValue: "{\"version\":3}",
        retries: 1,
        fetchImpl: async () => new Response("signature expired", { status: 403 }),
      }),
    /signature expired/,
  );
});

test("persistCapturedCodexSessionBundleWithRetries accepts duplicate same-run revision conflicts", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const diagnostics = [];
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
      expectedRunMarker: buildWebChatRunMarker({
        threadId: "wct_123",
        runId: "wcr_duplicate",
      }),
      reportRunnerDiagnostic: async (diagnostic) => {
        diagnostics.push(diagnostic);
        return { ok: true };
      },
    });

    assert.equal(state.status, "ready");
    assert.equal(state.bundle_revision, 162);
    assert.equal(state.last_run_id, "wcr_duplicate");
    assert.deepEqual(
      calls.map((call) => call.path),
      ["/web-chat/codex-session/upload-prepare", "/web-chat/codex-session/get"],
    );
    assert.equal(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.failureClass === "runner_session_capture_marker_missing" ||
          diagnostic.failure_class === "runner_session_capture_marker_missing",
      ),
      true,
    );
    assert.equal(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.event === "runner_session_revision_conflict_accepted",
      ),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});

test("readWebChatCodexSessionState restores session contents through direct storage reads", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const threadId = "wct_123";
  const storageKey = "web_chat_codex_session_blob:wct_123:163:nonce";
  const uploadKey = Buffer.from(
    Uint8Array.from({ length: 32 }, (_value, index) => index + 1),
  ).toString("base64url");
  const uploadedBundle = await buildUploadedCodexSessionStoredValue({
    threadId,
    storageKey,
    uploadKey,
    wrappedKey: "wrapped-key",
    wrappedKeyIv: "wrapped-key-iv",
    sessionFileContents: "session line 1\nsession line 2",
  });
  const storedValue = uploadedBundle.storedValue;

  globalThis.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(String(url));
    calls.push({
      path: parsedUrl.pathname,
      query: parsedUrl.search,
      method: init.method || "GET",
      body: init.body ? String(init.body) : "",
    });
    if (parsedUrl.pathname === "/web-chat/codex-session/read-url") {
      return Response.json({
        ok: true,
        thread: { thread_id: threadId },
        codex_session_state: {
          status: "ready",
          session_id: "019dd643-e3ec-76e1-952c-3dc25053e8c3",
          session_file_relative_path:
            "sessions/2026/05/02/rollout-2026-05-02T01-06-49-019dd643-e3ec-76e1-952c-3dc25053e8c3.jsonl",
          bundle_storage_key: storageKey,
          storage_bucket: "bucket",
          storage_backend: "firebase_storage",
          bundle_size_bytes: 29,
          bundle_compressed_size_bytes: 42,
          bundle_revision: 163,
        },
        session_bundle_read_url: {
          download_url: "https://storage.example/session-bundle",
          expires_at: Date.now() + 60_000,
          storage_key: storageKey,
          storage_bucket: "bucket",
          storage_backend: "firebase_storage",
        },
      });
    }
    if (parsedUrl.hostname === "storage.example") {
      return new Response(storedValue, { status: 200 });
    }
    if (parsedUrl.pathname === "/web-chat/codex-session/unwrap-key") {
      const body = JSON.parse(String(init.body || "{}"));
      assert.equal(body.thread_id, threadId);
      assert.equal(body.storage_key, storageKey);
      assert.equal(body.wrapped_key, "wrapped-key");
      assert.equal(body.wrapped_key_iv, "wrapped-key-iv");
      return Response.json({ ok: true, session_bundle_key: uploadKey });
    }
    throw new Error(`Unexpected request ${parsedUrl.pathname}`);
  };

  try {
    const loaded = await readWebChatCodexSessionState({
      workerUrl: "https://worker.example.com",
      adminToken: "secret",
      threadId,
      includeContents: true,
    });

    assert.equal(loaded.sessionFileContents, "session line 1\nsession line 2");
    assert.deepEqual(
      calls.map((call) => call.path),
      [
        "/web-chat/codex-session/read-url",
        "/session-bundle",
        "/web-chat/codex-session/unwrap-key",
      ],
    );
    assert.equal(
      calls.some(
        (call) =>
          call.path === "/web-chat/codex-session/get" &&
          call.query.includes("include_contents"),
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("readWebChatCodexSessionState decrypts source-owned inherited session bundles", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const targetThreadId = "wct_target";
  const sourceThreadId = "wct_source";
  const storageKey = "web_chat_codex_session_blob:wct_source:164:nonce";
  const uploadKey = Buffer.from(
    Uint8Array.from({ length: 32 }, (_value, index) => 32 - index),
  ).toString("base64url");
  const uploadedBundle = await buildUploadedCodexSessionStoredValue({
    threadId: sourceThreadId,
    storageKey,
    uploadKey,
    wrappedKey: "wrapped-key",
    wrappedKeyIv: "wrapped-key-iv",
    sessionFileContents: "source session line 1\nsource session line 2",
  });
  const storedValue = uploadedBundle.storedValue;

  globalThis.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(String(url));
    calls.push({
      path: parsedUrl.pathname,
      query: parsedUrl.search,
      method: init.method || "GET",
      body: init.body ? String(init.body) : "",
    });
    if (parsedUrl.pathname === "/web-chat/codex-session/read-url") {
      return Response.json({
        ok: true,
        thread: { thread_id: targetThreadId },
        codex_session_state: {
          status: "ready",
          session_id: "019dd643-e3ec-76e1-952c-3dc25053e8c3",
          session_file_relative_path:
            "sessions/2026/05/02/rollout-2026-05-02T01-06-49-019dd643-e3ec-76e1-952c-3dc25053e8c3.jsonl",
          bundle_storage_key: storageKey,
          bundle_owner_thread_id: sourceThreadId,
          storage_bucket: "bucket",
          storage_backend: "firebase_storage",
          bundle_size_bytes: 43,
          bundle_compressed_size_bytes: 56,
          bundle_revision: 164,
        },
        session_bundle_read_url: {
          download_url: "https://storage.example/source-session-bundle",
          expires_at: Date.now() + 60_000,
          storage_key: storageKey,
          storage_bucket: "bucket",
          storage_backend: "firebase_storage",
        },
      });
    }
    if (parsedUrl.hostname === "storage.example") {
      return new Response(storedValue, { status: 200 });
    }
    if (parsedUrl.pathname === "/web-chat/codex-session/unwrap-key") {
      const body = JSON.parse(String(init.body || "{}"));
      assert.equal(body.thread_id, targetThreadId);
      assert.equal(body.storage_key, storageKey);
      assert.equal(body.wrapped_key, "wrapped-key");
      assert.equal(body.wrapped_key_iv, "wrapped-key-iv");
      return Response.json({ ok: true, session_bundle_key: uploadKey });
    }
    throw new Error(`Unexpected request ${parsedUrl.pathname}`);
  };

  try {
    const loaded = await readWebChatCodexSessionState({
      workerUrl: "https://worker.example.com",
      adminToken: "secret",
      threadId: targetThreadId,
      includeContents: true,
    });

    assert.equal(
      loaded.sessionFileContents,
      "source session line 1\nsource session line 2",
    );
    assert.equal(loaded.codexSessionState.bundle_owner_thread_id, sourceThreadId);
    assert.deepEqual(
      calls.map((call) => call.path),
      [
        "/web-chat/codex-session/read-url",
        "/source-session-bundle",
        "/web-chat/codex-session/unwrap-key",
      ],
    );
    assert.equal(
      calls.some(
        (call) =>
          call.path === "/web-chat/codex-session/get" &&
          call.query.includes("include_contents"),
      ),
      false,
    );
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

test("isRecoverableCodexSessionErrorState treats worker fetch failures as recoverable stale session state", () => {
  assert.equal(
    isRecoverableCodexSessionErrorState("Worker request failed: fetch failed"),
    true,
  );
  assert.equal(
    isRecoverableCodexSessionErrorState("fetch failed"),
    true,
  );
  assert.equal(
    isRecoverableCodexSessionErrorState(
      "Codex session state is in error status: Worker request failed: fetch failed",
    ),
    true,
  );
  assert.equal(
    isRecoverableCodexSessionErrorState(
      "Codex session state is in error status: fetch failed",
    ),
    true,
  );
  assert.equal(
    isRecoverableCodexSessionErrorState(
      "Codex session state is in error status: Codex session state is in error status: fetch failed",
    ),
    true,
  );
});

test("isRecoverableCodexSessionErrorState treats missing session keys as recoverable stale session state", () => {
  assert.equal(
    isRecoverableCodexSessionErrorState("WEB_CHAT_CODEX_SESSION_MASTER_KEY is missing."),
    true,
  );
  assert.equal(
    isRecoverableCodexSessionErrorState(
      "Codex session state is in error status: WEB_CHAT_CODEX_SESSION_MASTER_KEY is missing.",
    ),
    true,
  );
  assert.equal(
    isRecoverableCodexSessionErrorState(
      "Codex session state is in error status: Codex session state is in error status: WEB_CHAT_CODEX_SESSION_MASTER_KEY is missing.",
    ),
    true,
  );
});

test("isRecoverableCodexSessionErrorState treats oversized session uploads as recoverable stale state", () => {
  assert.equal(
    isRecoverableCodexSessionErrorState("Request Entity Too Large"),
    true,
  );
  assert.equal(
    isRecoverableCodexSessionErrorState(
      "Codex session state is in error status: Codex session state is in error status: Request Entity Too Large",
    ),
    true,
  );
});

test("isRecoverableCodexResumeFailure retries zero-output AppServer terminal failures fresh", () => {
  assert.equal(
    isRecoverableCodexResumeFailure({
      reason: "Codex app-server turn completed with status failed.",
      output: "",
    }),
    true,
  );
  assert.equal(
    isRecoverableCodexResumeFailure({
      reason: "Codex app-server turn completed with status failed.",
      output: "apply_patch verification failed",
    }),
      false,
    );
});

test("isRecoverableCodexResumeFailure does not retry account usage-limit failures", () => {
  assert.equal(
    isRecoverableCodexResumeFailure({
      reason: "The Codex account on this runner has reached its usage limit. Retry after the limit resets.",
      output: "",
    }),
    false,
  );
});

test("superseded web chat runs do not poison Codex session state", () => {
  const message =
    "Codex session state is in error status: Run wcr_098550d0-7874-4f2e-856b-433034c63793 was superseded by a newer message.";

  assert.equal(isSupersededWebChatRunError(message), true);
  assert.equal(isRecoverableCodexSessionErrorState(message), true);

  const cancelledWakeupMessage =
    "Codex session state is in error status: Codex session state is in error status: Run wcr_codeq8_wakeup_68f18ca4f99faa9384f9a8295c5aa0807688d548 is already cancelled.";

  assert.equal(isSupersededWebChatRunError(cancelledWakeupMessage), true);
  assert.equal(isRecoverableCodexSessionErrorState(cancelledWakeupMessage), true);
});

test("terminal web chat run prompt refusals do not poison Codex session state", () => {
  const failedMessage =
    "Codex session state is in error status: Run wcr_407c1fa7-208b-4e5e-8882-0b1d4cf66566 is already failed.";
  const completedMessage =
    "Codex session state is in error status: Run wcr_407c1fa7-208b-4e5e-8882-0b1d4cf66566 is already completed.";
  const cancelledMessage =
    "Codex session state is in error status: Run wcr_407c1fa7-208b-4e5e-8882-0b1d4cf66566 is already cancelled.";

  assert.equal(isTerminalWebChatRunPromptRefusal(failedMessage), true);
  assert.equal(isTerminalWebChatRunPromptRefusal(completedMessage), true);
  assert.equal(isTerminalWebChatRunPromptRefusal(cancelledMessage), true);
  assert.equal(isRecoverableCodexSessionErrorState(failedMessage), true);
  assert.equal(isRecoverableCodexSessionErrorState(completedMessage), true);
  assert.equal(isRecoverableCodexSessionErrorState(cancelledMessage), true);
});

test("recoverable Codex session persistence failures do not fail completed runs", () => {
  assert.equal(
    shouldContinueAfterCodexSessionPersistenceFailure("fetch failed"),
    true,
  );
  assert.equal(
    shouldContinueAfterCodexSessionPersistenceFailure("Worker request failed: fetch failed"),
    true,
  );
  assert.equal(
    shouldContinueAfterCodexSessionPersistenceFailure(
      "Codex session state is in error status: Codex session state is in error status: fetch failed",
    ),
    true,
  );
  assert.equal(
    shouldContinueAfterCodexSessionPersistenceFailure("web chat codex session revision conflict"),
    true,
  );
  assert.equal(
    shouldContinueAfterCodexSessionPersistenceFailure(
      "Codex session persistence failed: web chat codex session revision conflict (expected 19, found 20).",
    ),
    true,
  );
  assert.equal(
    shouldContinueAfterCodexSessionPersistenceFailure(
      "Codex run finished without creating a session bundle",
    ),
    false,
  );
});

test("ignored cancelled running callbacks stop before Codex starts", () => {
  assert.equal(
    shouldStopBeforeCodexForRunCallbackPayload({
      ok: true,
      ignored: true,
      run: {
        status: "cancelled",
        metadata: {
          superseded_by_new_message: true,
        },
      },
    }),
    true,
  );
  assert.equal(
    shouldStopBeforeCodexForRunCallbackPayload({
      ok: true,
      ignored: false,
      run: {
        status: "running",
        metadata: {},
      },
    }),
    false,
  );
});

test("Codex model capacity errors are recoverable after workspace persistence", () => {
  const diagnosticOutput = [
    "ERROR: Selected model is at capacity. Please try a different model.",
    "tokens used",
    "575,792",
  ].join("\n");

  assert.equal(
    isRecoverableCodexTransportFailure({
      reason: "Codex exited with code=1 signal=none.",
      output: diagnosticOutput,
    }),
    true,
  );
  assert.equal(stripLeadingCodexTransportNoise(diagnosticOutput), "");
  assert.equal(
    shouldTreatCodexFailureAsCompleted({
      execution: {
        ok: false,
        reason: "Codex exited with code=1 signal=none.",
        diagnosticOutput,
      },
      persistenceSummary: "PR: https://github.com/Codeq8/Codeq8/pull/1208.",
    }),
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

test("toUserVisibleRunnerFailureMessage maps model capacity errors to retry guidance", () => {
  const message = toUserVisibleRunnerFailureMessage(`
    ERROR: Selected model is at capacity. Please try a different model.
  `);

  assert.equal(message, "The selected Codex model is temporarily at capacity. Retry the run.");
});

test("toUserVisibleRunnerFailureMessage maps usage-limit errors to account guidance", () => {
  const message = toUserVisibleRunnerFailureMessage("usageLimited");

  assert.equal(
    message,
    "The Codex account on this runner has reached its usage limit. Retry after the limit resets.",
  );
});

test("toUserVisibleRunnerFailureMessage maps hosted revoked auth to reconnect guidance", () => {
  const revokedReason =
    "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.";

  assert.equal(isCodexAuthRefreshFailure(revokedReason), true);
  assert.equal(
    toUserVisibleRunnerFailureMessage(revokedReason, {
      executionBackend: "runner_pool",
    }),
    "Your ChatGPT connection expired. Connect ChatGPT again, then retry.",
  );
  assert.equal(
    toUserVisibleRunnerFailureMessage(revokedReason, {
      executionBackend: "github_actions",
    }),
    "Codex is not logged in on this self-hosted runner. Sign in on the runner, then retry.",
  );
});

test("invalidateHostedCodexAuthAfterRefreshFailure calls optional scoped route", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: body ? JSON.parse(body) : {},
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, invalidated: true }));
    });
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const workerUrl = `http://127.0.0.1:${address.port}`;

  assert.equal(
    runtimeManifestSupportsScopedPath(
      {
        scoped_authorized_paths: ["/web-chat/hosted-codex-auth/invalidate"],
      },
      "/web-chat/hosted-codex-auth/invalidate",
    ),
    true,
  );
  const result = await invalidateHostedCodexAuthAfterRefreshFailure({
    workerUrl,
    adminToken: "header.payload.signature",
    runtimeManifest: {
      scoped_authorized_paths: ["/web-chat/hosted-codex-auth/invalidate"],
    },
    threadId: "wct_run",
    runId: "wcr_run",
    reason: "Your access token could not be refreshed because your refresh token was revoked.",
  });

  assert.equal(result.ok, true);
  assert.equal(result.invalidated, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "/web-chat/hosted-codex-auth/invalidate");
  assert.equal(requests[0].authorization, "Bearer header.payload.signature");
  assert.deepEqual(requests[0].body, {
    thread_id: "wct_run",
    run_id: "wcr_run",
    reason: "Your access token could not be refreshed because your refresh token was revoked.",
  });
});

test("invalidateHostedCodexAuthAfterRefreshFailure skips older runtimes", async () => {
  const result = await invalidateHostedCodexAuthAfterRefreshFailure({
    workerUrl: "https://codeq8.example",
    adminToken: "header.payload.signature",
    runtimeManifest: {
      scoped_authorized_paths: ["/web-chat/hosted-codex-auth/get"],
    },
    threadId: "wct_run",
    runId: "wcr_run",
    reason: "Your access token could not be refreshed.",
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "runtime_path_unavailable");
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
