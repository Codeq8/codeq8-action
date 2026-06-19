import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { handleRunnerCodeq8Cli } from "../dist/runner-helper.js";

function testEnv() {
  return {
    CODE_PUBLIC_BASE_URL: "https://codeq8.example",
    CODE_WORKER_URL: "https://worker.example",
    CODE_WEB_CHAT_RUN_TOKEN: "header.payload.signature",
    CODEQ8_TRIGGERING_GITHUB_WEB_SESSION_COOKIE: "session_cookie",
    CODE_WORKSPACE_REPOSITORY: "Codeq8/Codeq8",
    CODE_CHAT_THREAD_ID: "wct_parent",
    CODE_CHAT_RUN_ID: "wcr_parent",
  };
}

function createOutputCapture() {
  let text = "";
  return {
    stream: {
      write(chunk) {
        text += String(chunk || "");
      },
    },
    readText() {
      return text;
    },
    readJson() {
      return JSON.parse(text);
    },
  };
}

function assertNoRawCredentialPayload(text) {
  for (const key of [
    "thread_stream_token",
    "thread_record_handoff",
    "run_record_handoff",
    "repository_access_handoff",
    "codex_session_state",
    "github_web_session_cookie",
    "session_id",
    "session_file_relative_path",
    "session_bundle_key",
    "bundle_storage_key",
    "authorization",
    "cookie",
    "credential",
  ]) {
    assert.doesNotMatch(text, new RegExp(`"${key}"`));
  }
  assert.doesNotMatch(text, /secret_(stream|handoff|run|repository|session|bundle|message|root|goal|assign|ghp)/);
}
test("runner codeq8 helper archives completed threads through the runner route without a web session cookie", async () => {
  const output = createOutputCapture();
  const calls = [];
  const env = {
    ...testEnv(),
    CODEQ8_TRIGGERING_GITHUB_WEB_SESSION_COOKIE: "",
  };
  await handleRunnerCodeq8Cli({
    argv: ["threads", "close", "wct_done"],
    env,
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        updated: true,
        thread: {
          thread_id: "wct_done",
          status: "archived",
          thread_stream_token: "secret_stream_token",
          thread_record_handoff: "secret_handoff_token",
        },
      });
    },
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0]?.url);
  assert.equal(url.origin, "https://codeq8.example");
  assert.equal(url.pathname, "/api/chat/runs/thread-archive");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.headers?.Authorization, "Bearer header.payload.signature");
  assert.equal(calls[0]?.init?.headers?.Cookie, undefined);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body || "{}")), {
    workspace_repository: "Codeq8/Codeq8",
    thread_id: "wct_parent",
    run_id: "wcr_parent",
    target_thread_id: "wct_done",
  });

  assert.deepEqual(output.readJson(), {
    ok: true,
    thread_id: "wct_done",
    status: "archived",
    updated: true,
  });
  const text = output.readText();
  assertNoRawCredentialPayload(text);
  assert.doesNotMatch(text, /secret_stream_token/);
  assert.doesNotMatch(text, /secret_handoff_token/);
});

test("runner codeq8 helper reopens archived threads through the runner route without a web session cookie", async () => {
  const output = createOutputCapture();
  const calls = [];
  const env = {
    ...testEnv(),
    CODEQ8_TRIGGERING_GITHUB_WEB_SESSION_COOKIE: "",
  };
  await handleRunnerCodeq8Cli({
    argv: ["threads", "reopen", "wct_archived"],
    env,
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        updated: true,
        thread: {
          thread_id: "wct_archived",
          status: "active",
          thread_stream_token: "secret_stream_token",
          thread_record_handoff: "secret_handoff_token",
        },
      });
    },
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0]?.url);
  assert.equal(url.origin, "https://codeq8.example");
  assert.equal(url.pathname, "/api/chat/runs/thread-reopen");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.headers?.Authorization, "Bearer header.payload.signature");
  assert.equal(calls[0]?.init?.headers?.Cookie, undefined);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body || "{}")), {
    workspace_repository: "Codeq8/Codeq8",
    thread_id: "wct_parent",
    run_id: "wcr_parent",
    target_thread_id: "wct_archived",
  });

  assert.deepEqual(output.readJson(), {
    ok: true,
    thread_id: "wct_archived",
    status: "active",
    updated: true,
  });
  const text = output.readText();
  assertNoRawCredentialPayload(text);
  assert.doesNotMatch(text, /secret_stream_token/);
  assert.doesNotMatch(text, /secret_handoff_token/);
});

test("runner codeq8 helper sets thread titles through backend contract", async () => {
  const output = createOutputCapture();
  const calls = [];
  await handleRunnerCodeq8Cli({
    argv: ["threads", "title", "wct_target", "--title", "Runner title"],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        titled: true,
        updated: true,
        target_thread_id: "wct_target",
        title: "Runner title",
        title_source: "manual",
        thread: {
          thread_id: "wct_target",
          workspace_repository: "Codeq8/Codeq8",
          title: "Runner title",
          title_source: "manual",
          thread_stream_token: "secret_title_stream",
          thread_record_handoff: "secret_title_handoff",
        },
      });
    },
  });

  assert.equal(new URL(calls[0]?.url).pathname, "/api/chat/runs/thread-title");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.headers?.Authorization, "Bearer header.payload.signature");
  assert.equal(calls[0]?.init?.headers?.Cookie, "code_github_session=session_cookie");
  const body = JSON.parse(String(calls[0]?.init?.body || "{}"));
  assert.equal(body.workspace_repository, "Codeq8/Codeq8");
  assert.equal(body.thread_id, "wct_parent");
  assert.equal(body.run_id, "wcr_parent");
  assert.equal(body.target_thread_id, "wct_target");
  assert.equal(body.title, "Runner title");
  const payload = output.readJson();
  assert.equal(payload.ok, true);
  assert.equal(payload.updated, true);
  assert.equal(payload.target_thread_id, "wct_target");
  assert.equal(payload.title, "Runner title");
  assert.equal(payload.title_source, "manual");
  assert.equal(payload.thread.title, "Runner title");
  assertNoRawCredentialPayload(output.readText());
});

test("runner codeq8 helper creates delegated threads with compact safe output", async () => {
  const output = createOutputCapture();
  const calls = [];
  await handleRunnerCodeq8Cli({
    argv: [
      "threads",
      "create",
      "--title",
      "Investigate",
      "--message",
      "Please inspect this.",
      "--assigned-to",
      "codeq8",
    ],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        delegated: true,
        target_thread_id: "wct_managed",
        runner_parent_thread_id: "wct_parent",
        runner_parent_run_id: "wcr_parent",
        runner_parent_workspace_repository: "Codeq8/Codeq8",
        thread_stream_token: "secret_root_stream_token",
        thread_record_handoff: "secret_root_handoff",
        thread: {
          thread_id: "wct_managed",
          workspace_repository: "Codeq8/Codeq8",
          title: "Investigate",
          status: "active",
          thread_stream_token: "secret_stream_token",
          thread_record_handoff: "secret_handoff_token",
        },
        run: {
          run_id: "wcr_managed",
          status: "queued",
          run_record_handoff: "secret_run_handoff",
        },
        message: {
          message_id: "wcm_managed",
          role: "user",
          content: "Please inspect repository_access_handoff=secret_repository_handoff.",
          metadata: {
            session_bundle_key: "secret_session_bundle",
          },
        },
      });
    },
  });

  assert.equal(new URL(calls[0]?.url).pathname, "/api/chat/runs/delegated-threads");
  const body = JSON.parse(String(calls[0]?.init?.body || "{}"));
  assert.equal(body.workspace_repository, "Codeq8/Codeq8");
  assert.equal(body.thread_id, "wct_parent");
  assert.equal(body.run_id, "wcr_parent");
  assert.equal(body.title, "Investigate");
  assert.equal(body.initial_message.content, "Please inspect this.");
  assert.equal(body.assigned_to_kind, "codeq8");
  const text = output.readText();
  assert.match(text, /Created thread: wct_managed/);
  assert.match(text, /Title: Investigate/);
  assert.match(text, /Repository: Codeq8\/Codeq8/);
  assert.match(text, /State: status=active run=queued dispatch=delegated/);
  assert.match(
    text,
    /Initial message: user \| wcm_managed \| Please inspect repository_access_handoff=\[redacted\]/,
  );
  assert.match(text, /Follow-up inspect: codeq8 threads inspect wct_managed/);
  assert.match(text, /Follow-up message: codeq8 threads message wct_managed --text "\.\.\."/);
  assert.ok(text.length < 900);
  assertNoRawCredentialPayload(text);
});

test("runner codeq8 helper create json returns a compact redacted snapshot", async () => {
  const output = createOutputCapture();
  await handleRunnerCodeq8Cli({
    argv: [
      "threads",
      "create",
      "--title",
      "Investigate",
      "--message",
      "Please inspect this.",
      "--json",
    ],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async () =>
      Response.json({
        ok: true,
        delegated: true,
        target_thread_id: "wct_managed",
        runner_parent_thread_id: "wct_parent",
        runner_parent_run_id: "wcr_parent",
        runner_parent_workspace_repository: "Codeq8/Codeq8",
        thread_stream_token: "secret_root_stream_token",
        thread_record_handoff: "secret_root_handoff",
        thread: {
          thread_id: "wct_managed",
          workspace_repository: "Codeq8/Codeq8",
          title: "Investigate",
          status: "active",
          thread_stream_token: "secret_stream_token",
          thread_record_handoff: "secret_handoff_token",
        },
        run: {
          run_id: "wcr_managed",
          status: "queued",
          run_record_handoff: "secret_run_handoff",
        },
        message: {
          message_id: "wcm_managed",
          role: "user",
          content: "Please inspect repository_access_handoff=secret_repository_handoff.",
          metadata: {
            session_bundle_key: "secret_session_bundle",
          },
        },
      }),
  });

  const payload = output.readJson();
  assert.equal(payload.ok, true);
  assert.equal(payload.delegated, true);
  assert.equal(payload.target_thread_id, "wct_managed");
  assert.equal(payload.dispatch_state, "delegated");
  assert.equal(payload.thread.thread_id, "wct_managed");
  assert.equal(payload.run.run_id, "wcr_managed");
  assert.equal(payload.message.message_id, "wcm_managed");
  assert.equal(
    payload.message.preview,
    "Please inspect repository_access_handoff=[redacted]",
  );
  assert.equal(payload.follow_up_inspect_command, "codeq8 threads inspect wct_managed");
  assert.equal(payload.follow_up_message_command, 'codeq8 threads message wct_managed --text "..."');
  assert.equal(
    payload.follow_up_command,
    'codeq8 threads message wct_managed --text "..."',
  );
  const serialized = output.readText();
  assert.ok(serialized.length < 1200);
  assertNoRawCredentialPayload(serialized);
});

test("runner codeq8 helper sends delegated thread messages with compact safe output", async () => {
  const output = createOutputCapture();
  const calls = [];
  await handleRunnerCodeq8Cli({
    argv: [
      "threads",
      "message",
      "wct_managed",
      "--text",
      "Continue from the latest evidence.",
    ],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        delegated: true,
        target_thread_id: "wct_managed",
        runner_parent_thread_id: "wct_parent",
        runner_parent_run_id: "wcr_parent",
        runner_parent_workspace_repository: "Codeq8/Codeq8",
        thread: {
          thread_id: "wct_managed",
          workspace_repository: "Codeq8/Codeq8",
          status: "active",
          thread_stream_token: "secret_stream_token",
          thread_record_handoff: "secret_handoff_token",
        },
        message: {
          message_id: "wcm_followup",
          role: "user",
          content: "Continue with thread_stream_token=secret_message_stream.",
          metadata: {
            run_record_handoff: "secret_message_run",
          },
        },
      });
    },
  });

  assert.equal(new URL(calls[0]?.url).pathname, "/api/chat/runs/delegated-thread-messages");
  const body = JSON.parse(String(calls[0]?.init?.body || "{}"));
  assert.equal(body.workspace_repository, "Codeq8/Codeq8");
  assert.equal(body.thread_id, "wct_parent");
  assert.equal(body.run_id, "wcr_parent");
  assert.equal(body.target_thread_id, "wct_managed");
  assert.equal(body.content, "Continue from the latest evidence.");
  assert.equal(body.role, "user");
  const payload = output.readJson();
  assert.equal(payload.ok, true);
  assert.equal(payload.target_thread_id, "wct_managed");
  assert.equal(payload.message.message_id, "wcm_followup");
  assert.equal(payload.message.preview, "Continue with thread_stream_token=[redacted]");
  assert.equal(payload.follow_up_command, "codeq8 threads inspect wct_managed");
  assertNoRawCredentialPayload(output.readText());
});

test("runner codeq8 helper sets thread goals through backend contract", async () => {
  const output = createOutputCapture();
  const calls = [];
  await handleRunnerCodeq8Cli({
    argv: [
      "threads",
      "goal",
      "wct_target",
      "--objective",
      "Keep this goal visible",
      "--status",
      "paused",
    ],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        target_thread_id: "wct_target",
        thread: {
          thread_id: "wct_target",
          thread_stream_token: "secret_goal_stream",
          thread_record_handoff: "secret_goal_handoff",
        },
        codex_goal_state: {
          objective: "Keep this goal visible",
          status: "paused",
          session_bundle_key: "secret_goal_bundle",
        },
      });
    },
  });

  assert.equal(new URL(calls[0]?.url).pathname, "/api/chat/runs/thread-goal");
  assert.equal(calls[0]?.init?.headers?.Authorization, "Bearer header.payload.signature");
  assert.equal(calls[0]?.init?.headers?.Cookie, "code_github_session=session_cookie");
  const body = JSON.parse(String(calls[0]?.init?.body || "{}"));
  assert.equal(body.workspace_repository, "Codeq8/Codeq8");
  assert.equal(body.thread_id, "wct_parent");
  assert.equal(body.run_id, "wcr_parent");
  assert.equal(body.target_thread_id, "wct_target");
  assert.equal(body.objective, "Keep this goal visible");
  assert.equal(body.status, "paused");
  assert.equal(output.readJson().codex_goal_state.objective, "Keep this goal visible");
  assertNoRawCredentialPayload(output.readText());
});

test("runner codeq8 helper clears thread goals through backend contract", async () => {
  const output = createOutputCapture();
  const calls = [];
  await handleRunnerCodeq8Cli({
    argv: ["threads", "goal", "wct_target", "--clear"],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        target_thread_id: "wct_target",
        cleared: true,
        thread: {
          thread_id: "wct_target",
          thread_stream_token: "secret_goal_stream",
          thread_record_handoff: "secret_goal_handoff",
        },
      });
    },
  });

  assert.equal(new URL(calls[0]?.url).pathname, "/api/chat/runs/thread-goal");
  const body = JSON.parse(String(calls[0]?.init?.body || "{}"));
  assert.equal(body.workspace_repository, "Codeq8/Codeq8");
  assert.equal(body.thread_id, "wct_parent");
  assert.equal(body.run_id, "wcr_parent");
  assert.equal(body.target_thread_id, "wct_target");
  assert.equal(body.clear, true);
  assert.equal(Object.hasOwn(body, "objective"), false);
  assert.equal(output.readJson().cleared, true);
  assertNoRawCredentialPayload(output.readText());
});

test("runner codeq8 helper materializes attachments through worker route", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-runner-cli-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const output = createOutputCapture();
  const calls = [];
  await handleRunnerCodeq8Cli({
    argv: [
      "attachments",
      "get",
      "--attachment",
      "wca_log",
      "--output",
      "attachments/log.txt",
    ],
    env: testEnv(),
    stdout: output.stream,
    cwd: tempDir,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        attachment: {
          attachment_id: "wca_log",
          name: "log.txt",
          content_type: "text/plain",
        },
        file_contents_base64url: Buffer.from("hello").toString("base64url"),
      });
    },
  });

  const url = new URL(calls[0]?.url);
  assert.equal(url.origin, "https://worker.example");
  assert.equal(url.pathname, "/web-chat/attachments/get");
  assert.equal(url.searchParams.get("thread_id"), "wct_parent");
  assert.equal(url.searchParams.get("attachment_id"), "wca_log");
  assert.equal(url.searchParams.get("include_contents"), "1");
  const payload = output.readJson();
  assert.equal(payload.path, path.join(tempDir, "attachments/log.txt"));
  assert.equal(await fs.readFile(payload.path, "utf8"), "hello");
});

test("runner codeq8 helper downloads GitHub issue attachments through backend contract", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeq8-runner-cli-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const output = createOutputCapture();
  const calls = [];
  await handleRunnerCodeq8Cli({
    argv: [
      "github",
      "issue",
      "attachments",
      "1711",
      "--comments",
      "--output-dir",
      "github-issue-1711",
    ],
    env: testEnv(),
    stdout: output.stream,
    cwd: tempDir,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        issue: {
          repository: "Codeq8/Codeq8",
          number: 1711,
          title: "Screenshot issue",
          url: "https://github.com/Codeq8/Codeq8/issues/1711",
        },
        attachments: [
          {
            name: "image",
            content_type: "image/png",
            size_bytes: 5,
            source: { issue_number: 1711, ordinal: 1 },
            file_contents_base64url: Buffer.from("image").toString("base64url"),
          },
        ],
        skipped: [],
      });
    },
  });

  const url = new URL(calls[0]?.url);
  assert.equal(url.origin, "https://codeq8.example");
  assert.equal(url.pathname, "/api/chat/runs/github/issue-attachments");
  assert.equal(url.searchParams.get("workspace_repository"), "Codeq8/Codeq8");
  assert.equal(url.searchParams.get("thread_id"), "wct_parent");
  assert.equal(url.searchParams.get("run_id"), "wcr_parent");
  assert.equal(url.searchParams.get("issue"), "1711");
  assert.equal(url.searchParams.get("repository"), "Codeq8/Codeq8");
  assert.equal(url.searchParams.get("comments"), "1");
  assert.equal(calls[0]?.init?.headers?.Authorization, "Bearer header.payload.signature");
  assert.equal(calls[0]?.init?.headers?.Cookie, "code_github_session=session_cookie");

  const payload = output.readJson();
  assert.equal(payload.attachments.length, 1);
  assert.equal(
    payload.attachments[0].path,
    path.join(tempDir, "github-issue-1711", "image.png"),
  );
  assert.equal(await fs.readFile(payload.attachments[0].path, "utf8"), "image");
  assert.equal(JSON.stringify(payload).includes("file_contents_base64url"), false);
});
