import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { handleRunnerCodeq8Cli } from "./web-chat-runner-codeq8-cli.mjs";

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

test("runner codeq8 helper searches threads with scoped auth and parent fields", async () => {
  const output = createOutputCapture();
  const calls = [];
  const exitCode = await handleRunnerCodeq8Cli({
    argv: ["threads", "search", "--search", "staging", "--status", "all", "--limit", "5"],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({ ok: true, threads: [{ thread_id: "wct_found" }] });
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]?.url);
  assert.equal(url.origin, "https://codeq8.example");
  assert.equal(url.pathname, "/api/chat/runs/thread-search");
  assert.equal(url.searchParams.get("workspace_repository"), "Codeq8/Codeq8");
  assert.equal(url.searchParams.get("thread_id"), "wct_parent");
  assert.equal(url.searchParams.get("run_id"), "wcr_parent");
  assert.equal(url.searchParams.get("search"), "staging");
  assert.equal(url.searchParams.get("status"), "all");
  assert.equal(calls[0]?.init?.headers?.Authorization, "Bearer header.payload.signature");
  assert.equal(calls[0]?.init?.headers?.Cookie, "code_github_session=session_cookie");
  assert.deepEqual(output.readJson().threads, [{ thread_id: "wct_found" }]);
});

test("runner codeq8 helper lists current-user threads with compact safe output", async () => {
  const output = createOutputCapture();
  const calls = [];
  const exitCode = await handleRunnerCodeq8Cli({
    argv: ["threads", "mine", "--status", "active", "--limit", "5"],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        repository: "Codeq8/Codeq8",
        assigned_to_github_login: "abdul",
        threads: [
          {
            thread_id: "wct_mine",
            status: "active",
            title: "Fanout audit",
            latest_run_status: "running",
            assigned_to_github_login: "abdul",
            updated_at: 1700000000000,
            branch_context: {
              pull_request_number: 2499,
            },
            thread_stream_token: "secret_stream_token",
            thread_record_handoff: "secret_handoff_token",
          },
        ],
        page_count: 1,
        has_more: true,
        next_before_updated_at: 1699999999999,
        next_before_thread_id: "wct_cursor",
      });
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]?.url);
  assert.equal(url.origin, "https://codeq8.example");
  assert.equal(url.pathname, "/api/chat/runs/thread-search");
  assert.equal(url.searchParams.get("workspace_repository"), "Codeq8/Codeq8");
  assert.equal(url.searchParams.get("thread_id"), "wct_parent");
  assert.equal(url.searchParams.get("run_id"), "wcr_parent");
  assert.equal(url.searchParams.get("assigned_to"), "me");
  assert.equal(url.searchParams.get("status"), "active");
  assert.equal(url.searchParams.get("limit"), "5");

  const text = output.readText();
  assert.match(text, /Repository: Codeq8\/Codeq8/);
  assert.match(text, /Assigned: me/);
  assert.match(text, /wct_mine\tactive\trunning\t#2499\t2023-11-14T22:13:20\.000Z\tFanout audit/);
  assert.match(text, /Next: --before-updated-at 1699999999999 --before-thread-id wct_cursor/);
  assert.doesNotMatch(text, /secret_stream_token/);
  assert.doesNotMatch(text, /secret_handoff_token/);
});

test("runner codeq8 helper inspects one delegated thread with compact redacted output", async () => {
  const output = createOutputCapture();
  const calls = [];
  const exitCode = await handleRunnerCodeq8Cli({
    argv: ["threads", "inspect", "wct_child", "--limit", "7"],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        parent_thread_id: "wct_parent",
        parent_run_id: "wcr_parent",
        parent_workspace_repository: "Codeq8/Codeq8",
        child_thread_id: "wct_child",
        thread: {
          thread_id: "wct_child",
          workspace_repository: "Codeq8/Codeq8",
          title: "Investigate checks",
          status: "active",
          aggregate_status: "loading",
          source_type: "pull_request",
          assigned_to_kind: "github_user",
          assigned_to_github_login: "abdul",
          latest_run_id: "wcr_latest",
          latest_run_status: "running",
          latest_run_started_at: 1700000000000,
          last_run_at: 1700000060000,
          latest_check_state: "pending",
          latest_message_role: "assistant",
          latest_message_preview: "I am checking the failing job.",
          last_message_at: 1700000050000,
          branch_context: {
            pull_request_number: 42,
            pull_request_url: "https://github.com/Codeq8/Codeq8/pull/42",
            pull_request_head_branch: "fix/checks",
            pull_request_base_branch: "main",
          },
          live_status: {
            status: "in_progress",
            label: "Inspecting CI logs with token=secret_progress_token",
            events: [
              {
                item_type: "assistant_reasoning",
                label: "Comparing check state",
                created_at: 1700000040000,
              },
            ],
          },
          thread_stream_token: "secret_stream_token",
          thread_record_handoff: "secret_handoff_token",
          codex_session_state: {
            bundle_storage_key: "secret_bundle_key",
          },
        },
        messages: [
          {
            message_id: "wcm_user",
            role: "user",
            content: "Please inspect this thread.",
            created_at: 1700000010000,
            metadata: {
              thread_record_handoff: "secret_message_handoff",
            },
          },
          {
            message_id: "wcm_assistant",
            role: "assistant",
            content: "Working through thread_stream_token=secret_message_token now.",
            created_at: 1700000020000,
          },
        ],
        page_count: 2,
        has_more: false,
      });
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]?.url);
  assert.equal(url.origin, "https://codeq8.example");
  assert.equal(url.pathname, "/api/chat/runs/delegated-thread-state");
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(url.searchParams.get("workspace_repository"), "Codeq8/Codeq8");
  assert.equal(url.searchParams.get("thread_id"), "wct_parent");
  assert.equal(url.searchParams.get("run_id"), "wcr_parent");
  assert.equal(url.searchParams.get("child_thread_id"), "wct_child");
  assert.equal(url.searchParams.get("limit"), "7");

  const text = output.readText();
  assert.match(text, /Thread: wct_child/);
  assert.match(text, /Title: Investigate checks/);
  assert.match(text, /State: status=active aggregate=loading/);
  assert.match(text, /Source: PR #42 https:\/\/github\.com\/Codeq8\/Codeq8\/pull\/42/);
  assert.match(text, /Run: wcr_latest running/);
  assert.match(text, /Checks: pending/);
  assert.match(text, /Progress: status=in_progress \| Inspecting CI logs with token=\[redacted\]/);
  assert.match(text, /assistant: Working through thread_stream_token=\[redacted\] now\./);
  assert.match(text, /Follow-up: codeq8 threads message wct_child --text "\.\.\."/);
  assert.match(text, /Page: 2 message\(s\), has more: no/);
  assert.ok(text.length < 2200);
  assert.doesNotMatch(text, /secret_stream_token/);
  assert.doesNotMatch(text, /secret_handoff_token/);
  assert.doesNotMatch(text, /secret_bundle_key/);
  assert.doesNotMatch(text, /secret_message_handoff/);
  assert.doesNotMatch(text, /secret_message_token/);
  assert.doesNotMatch(text, /secret_progress_token/);
});

test("runner codeq8 helper inspect json returns a redacted snapshot contract", async () => {
  const output = createOutputCapture();
  await handleRunnerCodeq8Cli({
    argv: ["threads", "inspect", "wct_child", "--json"],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async () =>
      Response.json({
        ok: true,
        child_thread_id: "wct_child",
        thread: {
          thread_id: "wct_child",
          workspace_repository: "Codeq8/Codeq8",
          title: "Review PR",
          status: "active",
          latest_run_id: "wcr_review",
          latest_run_status: "completed",
          latest_check_state: "success",
          branch_context: {
            pull_request_number: 77,
            pull_request_head_branch: "review/fix",
            pull_request_base_branch: "main",
          },
          thread_stream_token: "secret_stream_token",
          thread_record_handoff: "secret_handoff_token",
          codex_session_state: {
            session_id: "secret_session_id",
            bundle_storage_key: "secret_bundle_key",
          },
        },
        messages: [
          {
            message_id: "wcm_latest",
            role: "assistant",
            content: "Completed the change.",
            created_at: 1700000000000,
            metadata: {
              cookie: "secret_cookie",
              session_bundle_key: "secret_session_bundle",
            },
          },
        ],
        total_count: 1,
        page_count: 1,
      }),
  });

  const snapshot = output.readJson();
  assert.equal(snapshot.inspected, true);
  assert.equal(snapshot.target_thread_id, "wct_child");
  assert.equal(snapshot.thread.repository, "Codeq8/Codeq8");
  assert.equal(snapshot.run.run_id, "wcr_review");
  assert.equal(snapshot.run.status, "completed");
  assert.equal(snapshot.checks.latest_state, "success");
  assert.equal(snapshot.pull_request.number, 77);
  assert.equal(snapshot.recent_messages[0].preview, "Completed the change.");
  assert.equal(
    snapshot.follow_up_command,
    'codeq8 threads message wct_child --text "..."',
  );

  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /thread_stream_token/);
  assert.doesNotMatch(serialized, /thread_record_handoff/);
  assert.doesNotMatch(serialized, /codex_session_state/);
  assert.doesNotMatch(serialized, /metadata/);
  assert.doesNotMatch(serialized, /secret_stream_token/);
  assert.doesNotMatch(serialized, /secret_handoff_token/);
  assert.doesNotMatch(serialized, /secret_bundle_key/);
  assert.doesNotMatch(serialized, /secret_cookie/);
  assert.doesNotMatch(serialized, /secret_session_bundle/);
});

test("runner codeq8 helper exposes inspect and message without a threads steer command", async () => {
  const output = createOutputCapture();
  const exitCode = await handleRunnerCodeq8Cli({
    argv: ["threads", "--help"],
    stdout: output.stream,
    fetchImpl: async () => {
      throw new Error("help must not fetch");
    },
  });

  assert.equal(exitCode, 0);
  const text = output.readText();
  assert.match(text, /codeq8 threads inspect <thread-id> \[--limit 12\] \[--json\]/);
  assert.match(text, /codeq8 threads message <thread-id> --text text/);
  assert.match(text, /codeq8 threads archive <thread-id>\s+\(alias: close\)/);
  assert.doesNotMatch(text, /threads steer/);

  const cliSource = await fs.readFile(
    new URL("./web-chat-runner-codeq8-cli.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(cliSource, /command === "steer"/);
  assert.doesNotMatch(cliSource, /threads steer/);
});

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
  assert.doesNotMatch(text, /secret_stream_token/);
  assert.doesNotMatch(text, /secret_handoff_token/);
});

test("runner codeq8 helper creates delegated threads through backend contract", async () => {
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
      return Response.json({ ok: true, thread: { thread_id: "wct_child" } });
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
  assert.equal(output.readJson().thread.thread_id, "wct_child");
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
        codex_goal_state: {
          objective: "Keep this goal visible",
          status: "paused",
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
