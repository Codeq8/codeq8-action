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
  appendWebChatRunMarkerToPrompt,
  buildFirebaseStorageDownloadUrl,
  buildFinalWorkspaceStateCallbackPayload,
  buildCodexPrompt,
  buildCodexRunMetadata,
  buildResumePrompt,
  buildWebChatRunMarker,
  buildWebChatRunnerDiagnosticRequest,
  buildUploadedCodexSessionStoredValue,
  captureCodexSessionBundle,
  configureWorkspaceGitCredentialHelper,
  configureWorkspacePushPolicy,
  DEFAULT_TIMEOUT_SECONDS,
  findPullRequestForBranch,
  flushServerOwnedCodeq8File,
  hydrateServerOwnedCodeq8File,
  extractUserVisibleFailureHeadline,
  isRecoverableCodexTransportFailure,
  isRecoverableCodexSessionErrorState,
  isSupersededWebChatRunError,
  materializeWebChatAttachments,
  normalizeAttachmentRecord,
  postWebChatRunnerDiagnostic,
  persistCapturedCodexSessionBundleWithRetries,
  persistWorkspaceProgress,
  prepareGitHubCliAuth,
  prepareRunnerDiscordDmCli,
  prepareWebChatCodexSessionUpload,
  readFirebaseStorageAttachment,
  readFirebaseStorageSignedAttachment,
  readWebChatAttachment,
  readWebChatAttachmentReadUrl,
  runCodex,
  sessionContainsWebChatRunMarker,
  shouldContinueAfterCodexSessionPersistenceFailure,
  shouldStopBeforeCodexForRunCallbackPayload,
  shouldTreatCodexFailureAsCompleted,
  stripLeadingCodexTransportNoise,
  toUserVisibleRunnerFailureMessage,
  uploadPreparedWebChatCodexSessionBundle,
  discardPreparedWebChatCodexSessionBundle,
} from "./web-chat-runner.mjs";

const CONTRACT_VERSION = "web_chat_runner_runtime_v1";

test("Codex chat runs default to the 72 hour GitHub Actions budget", () => {
  assert.equal(DEFAULT_TIMEOUT_SECONDS, 72 * 60 * 60);
});

test("AppServer control polling honors the server cadence instead of a tight interval", async () => {
  const source = await fs.readFile(
    path.join(process.cwd(), "scripts/web-chat-runner.mjs"),
    "utf8",
  );
  const pollerSource = source.slice(
    source.indexOf("function createAppServerControlPoller"),
    source.indexOf("async function runCodexAppServer"),
  );

  assert.match(source, /APP_SERVER_CONTROL_DEFAULT_POLL_INTERVAL_MS = 5000/);
  assert.match(pollerSource, /payload\.poll_after_ms \|\| payload\.pollAfterMs/);
  assert.doesNotMatch(pollerSource, /\bsetInterval\s*\(/);
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
      "      const text = `Progress update ${index}.`;",
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

  const fetchCalls = [];
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
      fetchImpl: async (url, init = {}) => {
        fetchCalls.push({ url: String(url), init });
        if (String(url).includes("/api/chat/runs/app-server/control")) {
          return new Response(JSON.stringify({ ok: true, requests: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "Progress update 10.");
  assert.equal(result.sessionId, "thr_app");
  const args = JSON.parse(await fs.readFile(argsOutputPath, "utf8"));
  assert.deepEqual(args, ["app-server", "--listen", "stdio://"]);
  const progressEventBodies = fetchCalls
    .filter((call) => String(call.url).endsWith("/api/chat/runs/app-server/events"))
    .map((call) => JSON.parse(String(call.init.body || "{}")));
  const progressEvents = progressEventBodies.flatMap((body) =>
    Array.isArray(body.events) ? body.events : [],
  );
  assert.equal(progressEvents.length, 8);
  assert.deepEqual(
    progressEvents.map((event) => event.label),
    Array.from({ length: 8 }, (_, index) => `Progress update ${index + 1}.`),
  );
  assert.equal(
    progressEvents.some((event) => String(event.item_type || "").includes("command")),
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

  let controlGetCount = 0;
  let steerReturned = false;
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
      fetchImpl: async (url, init = {}) => {
        if (String(url).includes("/api/chat/runs/app-server/control")) {
          const method = String(init.method || "GET").toUpperCase();
          if (method === "POST") {
            acknowledgementBodies.push(JSON.parse(String(init.body || "{}")));
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          controlGetCount += 1;
          const requests =
            controlGetCount >= 2 && !steerReturned
              ? [
                  {
                    request_id: "wcasr_steer",
                    sequence: 1,
                    kind: "steer",
                    content: "Actually say awesome.",
                  },
                ]
              : [];
          steerReturned = steerReturned || requests.length > 0;
          return new Response(JSON.stringify({ ok: true, poll_after_ms: 1000, requests }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
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

  let controlGetCount = 0;
  let steerReturned = false;
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
      fetchImpl: async (url, init = {}) => {
        if (String(url).includes("/api/chat/runs/app-server/control")) {
          const method = String(init.method || "GET").toUpperCase();
          if (method === "POST") {
            acknowledgementBodies.push(JSON.parse(String(init.body || "{}")));
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          controlGetCount += 1;
          const requests =
            controlGetCount >= 2 && !steerReturned
              ? [
                  {
                    request_id: "wcasr_attachment_steer",
                    sequence: 1,
                    kind: "steer",
                    content: "",
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
                  },
                ]
              : [];
          steerReturned = steerReturned || requests.length > 0;
          return new Response(JSON.stringify({ ok: true, poll_after_ms: 1000, requests }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
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

  let eventPostCount = 0;
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
      fetchImpl: async (url) => {
        if (String(url).includes("/api/chat/runs/app-server/events")) {
          eventPostCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 2000));
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true, requests: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "done");
  assert(eventPostCount >= 1);
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
        "server_owned_codeq8_file_sync",
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
        "/api/chat/runs/diagnostic",
        "/api/chat/runs/app-server/events",
        "/api/chat/runs/app-server/control",
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
        "/web-chat/attachments/get",
        "/web-chat/codex-session/get",
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
        "/api/chat/runs/app-server/events",
        "/api/chat/runs/app-server/control",
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
          "/api/chat/runs/app-server/events",
          "/api/chat/runs/app-server/control",
          "/web-chat/attachments/get",
          "/web-chat/attachments/read-url",
          "/web-chat/codex-session/get",
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

test("assertWebChatRunnerRuntimeCompatibility fails fast when AppServer turn-control routes are missing", async () => {
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
            "/api/chat/runs/app-server/events",
            "/api/chat/runs/app-server/control",
            "/web-chat/attachments/get",
            "/web-chat/attachments/read-url",
            "/web-chat/codex-session/get",
            "/web-chat/codex-session/upload-prepare",
            "/web-chat/codex-session/upload-direct",
            "/web-chat/codex-session/upload-discard",
            "/web-chat/codex-session/upsert",
            "/web-chat/codex-session/invalidate",
            "/web-chat/threads/get",
          ],
        }),
      /missing authorized paths: \/api\/chat\/runs\/app-server\/events, \/api\/chat\/runs\/app-server\/control/,
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
        "/web-chat/codex-session/upsert",
        "/web-chat/codex-session/invalidate",
        "/web-chat/threads/get",
      ],
      scoped_authorized_paths: [
        "/api/chat/runs/app-server/events",
        "/api/chat/runs/app-server/control",
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

test("runCodex preserves AppServer agent delta whitespace", async (t) => {
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

  const result = await runCodex({
    codexPath: fakeCodexPath,
    model: "gpt-5.5",
    task: "preserve streaming whitespace",
    workspacePath,
    commandEnv: process.env,
    timeoutSeconds: 30,
  });

  assert.equal(result.ok, true);
  assert.equal(result.output, "Yes, I'm getting it. This run is targeting PR #1698.");
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
      "const agentMessages = Array.isArray(agentMessage) ? agentMessage : [agentMessage];",
      "if (argsOutputPath) await fs.writeFile(argsOutputPath, JSON.stringify(process.argv.slice(2)), 'utf8');",
      "if (envOutputPath) await fs.writeFile(envOutputPath, process.env.NODE_OPTIONS || '', 'utf8');",
      "const requests = [];",
      "const persistRequests = async () => {",
      "  if (requestsOutputPath) await fs.writeFile(requestsOutputPath, JSON.stringify(requests), 'utf8');",
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
      "  if (message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: message.params?.threadId || 'thr_app' } } });",
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
      codeq8Cli: { available: true },
      attachments: [],
      referencedThreads: [],
      targetShift: true,
    });

    assert.equal(prompt, "server-owned resume prompt");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://codeq8.example.com/api/chat/runs/prompt");
    assert.equal(calls[0]?.body?.mode, "resume");
    assert.equal(calls[0]?.body?.target_shift, true);
    assert.equal(calls[0]?.body?.codeq8_cli_available, true);
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

test("prepareGitHubCliAuth refreshes gh tokens before each invocation", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-gh-refresh-"));
  const fakeBinPath = path.join(tempDir, "fake-bin");
  const runtimeHomePath = path.join(tempDir, "runtime");
  const helperStatePath = path.join(tempDir, "helper-count.txt");
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
      'count="$(cat "$state_path" 2>/dev/null || printf 0)"',
      'count="$((count + 1))"',
      'printf "%s" "$count" > "$state_path"',
      'printf "fresh-token-%s" "$count"',
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
  assert.equal(commandEnv.GH_TOKEN, "fresh-token-1");
  assert.equal(commandEnv.GITHUB_TOKEN, "fresh-token-1");
  const escapedRuntimeBinPath = path
    .join(runtimeHomePath, "bin")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(commandEnv.PATH, new RegExp(`^${escapedRuntimeBinPath}${path.delimiter}`));

  execFileSync("gh", ["pr", "view", "1"], {
    env: commandEnv,
    encoding: "utf8",
    stdio: "pipe",
  });
  execFileSync("gh", ["run", "view", "2"], {
    env: commandEnv,
    encoding: "utf8",
    stdio: "pipe",
  });

  const ghCallLog = await fs.readFile(ghCallLogPath, "utf8");
  assert.match(ghCallLog, /GH_TOKEN=fresh-token-2/);
  assert.match(ghCallLog, /GITHUB_TOKEN=fresh-token-2/);
  assert.match(ghCallLog, /ARGS=pr view 1/);
  assert.match(ghCallLog, /GH_TOKEN=fresh-token-3/);
  assert.match(ghCallLog, /GITHUB_TOKEN=fresh-token-3/);
  assert.match(ghCallLog, /ARGS=run view 2/);
  assert.doesNotMatch(ghCallLog, /startup-token/);
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

test("persistWorkspaceProgress still rejects unpushed protected branch commits", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-action-persist-protected-local-"));
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
      branch: "main",
      writeMode: "branch_and_pr",
      repository: "Codeq8/codeq8-action",
      headRepository: "Codeq8/codeq8-action",
      baseBranch: "main",
      gitToken: "",
      protectedBranches: ["main"],
      baselineState,
    });

    assert.match(result.error, /protected branch main/);
    assert.equal(result.skippedProtectedBranch, "main");
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
