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
          {
            thread_id: "wct_child_mine",
            parent_thread_id: "wct_parent",
            status: "active",
            title: "Child audit",
            latest_run_status: "queued",
            assigned_to_github_login: "abdul",
            updated_at: 1700000005000,
            branch_context: {
              context_branch: "main",
            },
          },
        ],
        page_count: 2,
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
  assert.match(text, /thread_id\tstatus\trelation\trun\ttarget\tupdated_at\ttitle/);
  assert.match(text, /wct_mine\tactive\ttop-level\trunning\t#2499\t2023-11-14T22:13:20\.000Z\tFanout audit/);
  assert.match(text, /wct_child_mine\tactive\tchild-of:wct_parent\tqueued\tmain\t2023-11-14T22:13:25\.000Z\tChild audit/);
  assert.match(text, /Next: --before-updated-at 1699999999999 --before-thread-id wct_cursor/);
  assert.doesNotMatch(text, /secret_stream_token/);
  assert.doesNotMatch(text, /secret_handoff_token/);
});

test("runner codeq8 helper lists active child threads for the current parent", async () => {
  const output = createOutputCapture();
  const calls = [];
  const exitCode = await handleRunnerCodeq8Cli({
    argv: ["threads", "children", "--limit", "3"],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        repository: "Codeq8/Codeq8",
        children_of_thread_id: "wct_parent",
        matched_by: "parent_thread",
        lifecycle_filter: "active",
        lifecycle_note: "Child thread listing currently supports the active/open lifecycle only.",
        threads: [
          {
            thread_id: "wct_child",
            parent_thread_id: "wct_parent",
            status: "active",
            title: "Child investigation",
            latest_run_status: "completed",
            updated_at: 1700000000000,
            branch_context: {
              context_branch: "child/thread",
            },
            thread_record_handoff: "secret_handoff_token",
          },
        ],
        page_count: 1,
        has_more: false,
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
  assert.equal(url.searchParams.get("children_of_thread_id"), "wct_parent");
  assert.equal(url.searchParams.get("status"), "active");
  assert.equal(url.searchParams.get("limit"), "3");

  const text = output.readText();
  assert.match(text, /Repository: Codeq8\/Codeq8/);
  assert.match(text, /Children of: wct_parent/);
  assert.match(text, /Status: active/);
  assert.match(text, /Lifecycle filter: active/);
  assert.match(text, /Lifecycle note: Child thread listing currently supports the active\/open lifecycle only\./);
  assert.match(text, /wct_child\tactive\tcompleted\tchild\/thread\t2023-11-14T22:13:20\.000Z\tChild investigation/);
  assert.doesNotMatch(text, /secret_handoff_token/);
});

test("runner codeq8 helper rejects non-active child lifecycle filters before fetching", async () => {
  let calls = 0;
  await assert.rejects(
    handleRunnerCodeq8Cli({
      argv: ["threads", "children", "--status", "all"],
      env: testEnv(),
      fetchImpl: async () => {
        calls += 1;
        throw new Error("children --status all should not reach the route");
      },
    }),
    /supports --status active only/,
  );

  assert.equal(calls, 0);
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
        runner_parent_thread_id: "wct_parent",
        runner_parent_run_id: "wcr_parent",
        runner_parent_workspace_repository: "Codeq8/Codeq8",
        target_parent_thread_id: "wct_actual_parent",
        child_thread_id: "wct_child",
        thread: {
          thread_id: "wct_child",
          workspace_repository: "Codeq8/Codeq8",
          parent_thread_id: "wct_actual_parent",
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
  assert.match(text, /Runner parent: wct_parent run=wcr_parent/);
  assert.match(text, /Target parent: wct_actual_parent/);
  assert.match(text, /Source: PR #42 https:\/\/github\.com\/Codeq8\/Codeq8\/pull\/42/);
  assert.match(text, /Run: wcr_latest running/);
  assert.match(text, /Checks: pending/);
  assert.match(text, /Progress: status=in_progress \| Inspecting CI logs with token=\[redacted\]/);
  assert.match(text, /assistant: Working through thread_stream_token=\[redacted\] now\./);
  assert.match(text, /Follow-up: codeq8 threads message wct_child --text "\.\.\."/);
  assert.match(text, /Page: 2 message\(s\), has more: no/);
  assert.ok(text.length < 2200);
  assertNoRawCredentialPayload(text);
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
        parent_thread_id: "wct_parent",
        parent_run_id: "wcr_parent",
        runner_parent_thread_id: "wct_parent",
        runner_parent_run_id: "wcr_parent",
        target_parent_thread_id: "wct_actual_parent",
        child_thread_id: "wct_child",
        thread: {
          thread_id: "wct_child",
          workspace_repository: "Codeq8/Codeq8",
          parent_thread_id: "wct_actual_parent",
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
  assert.equal(snapshot.runner_parent_thread_id, "wct_parent");
  assert.equal(snapshot.runner_parent_run_id, "wcr_parent");
  assert.equal(snapshot.target_parent_thread_id, "wct_actual_parent");
  assert.equal(snapshot.thread.repository, "Codeq8/Codeq8");
  assert.equal(snapshot.thread.parent_thread_id, "wct_actual_parent");
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
  assertNoRawCredentialPayload(serialized);
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

test("runner codeq8 helper thread context fallback redacts raw credential-bearing output", async () => {
  const output = createOutputCapture();
  const calls = [];
  await handleRunnerCodeq8Cli({
    argv: ["threads", "context", "wct_child", "--limit", "3"],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        target_thread_id: "wct_child",
        thread: {
          thread_id: "wct_child",
          title: "Fallback audit",
          thread_stream_token: "secret_stream_token",
          thread_record_handoff: "secret_handoff_token",
          repository_access_handoff: "secret_repository_handoff",
          codex_session_state: {
            session_id: "secret_session_id",
            session_file_relative_path: "secret_session_path.jsonl",
            bundle_storage_key: "secret_bundle_key",
          },
          nested: {
            safe_field: "safe value",
            authorization: "Bearer secret_nested_authorization",
          },
        },
        messages: [
          {
            message_id: "wcm_context",
            role: "assistant",
            content:
              "Authorization: Bearer secret_message_authorization; session_id=secret_message_session; repository_access_handoff=secret_message_repository.",
            metadata: {
              cookie: "secret_cookie",
              github_web_session_cookie: "secret_github_cookie",
              credential: "secret_credential",
            },
          },
        ],
      });
    },
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0]?.url);
  assert.equal(url.pathname, "/api/chat/runs/thread-context");
  assert.equal(url.searchParams.get("target_thread_id"), "wct_child");
  assert.equal(url.searchParams.get("limit"), "3");
  assert.equal(calls[0]?.init?.headers?.Authorization, "Bearer header.payload.signature");
  assert.equal(calls[0]?.init?.headers?.Cookie, "code_github_session=session_cookie");

  const payload = output.readJson();
  assert.equal(payload.thread.thread_id, "wct_child");
  assert.equal(payload.thread.nested.safe_field, "safe value");
  assert.equal(Object.hasOwn(payload.thread, "thread_stream_token"), false);
  assert.equal(Object.hasOwn(payload.thread, "codex_session_state"), false);
  assert.equal(Object.hasOwn(payload.thread.nested, "authorization"), false);
  assert.match(payload.messages[0].content, /Authorization=\[redacted\]/);
  assert.match(payload.messages[0].content, /session_id=\[redacted\]/);
  assert.match(payload.messages[0].content, /repository_access_handoff=\[redacted\]/);
  const text = output.readText();
  assertNoRawCredentialPayload(text);
  assert.doesNotMatch(
    text,
    /secret_(stream|handoff|repository|session|bundle|nested|message|authorization|cookie|github|credential)/,
  );
});

test("runner codeq8 helper delegated state fallback redacts raw credential-bearing output", async () => {
  const output = createOutputCapture();
  const calls = [];
  await handleRunnerCodeq8Cli({
    argv: ["threads", "state", "wct_child", "--limit", "4"],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        child_thread_id: "wct_child",
        thread: {
          thread_id: "wct_child",
          status: "active",
          thread_stream_token: "secret_state_stream",
          thread_record_handoff: "secret_state_handoff",
          codex_session_state: {
            session_id: "secret_state_session",
            session_bundle_key: "secret_state_bundle",
          },
        },
        runs: [
          {
            run_id: "wcr_child",
            status: "running",
            run_record_handoff: "secret_state_run_handoff",
            environment: {
              CODE_WEB_CHAT_RUN_TOKEN: "secret_state_env_token",
              CODEQ8_TRIGGERING_GITHUB_WEB_SESSION_COOKIE: "secret_state_env_cookie",
            },
          },
        ],
        messages: [
          {
            message_id: "wcm_state",
            role: "assistant",
            content:
              "Using cookie=secret_state_message_cookie and token=secret_state_message_token.",
          },
        ],
      });
    },
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0]?.url);
  assert.equal(url.pathname, "/api/chat/runs/delegated-thread-state");
  assert.equal(url.searchParams.get("child_thread_id"), "wct_child");
  assert.equal(url.searchParams.get("limit"), "4");

  const payload = output.readJson();
  assert.equal(payload.child_thread_id, "wct_child");
  assert.equal(payload.thread.status, "active");
  assert.equal(payload.runs[0].run_id, "wcr_child");
  assert.equal(Object.hasOwn(payload.thread, "thread_stream_token"), false);
  assert.equal(Object.hasOwn(payload.thread, "codex_session_state"), false);
  assert.equal(Object.hasOwn(payload.runs[0], "run_record_handoff"), false);
  assert.equal(Object.hasOwn(payload.runs[0].environment, "CODE_WEB_CHAT_RUN_TOKEN"), false);
  assert.equal(
    Object.hasOwn(payload.runs[0].environment, "CODEQ8_TRIGGERING_GITHUB_WEB_SESSION_COOKIE"),
    false,
  );
  assert.equal(
    payload.messages[0].content,
    "Using cookie=[redacted] and token=[redacted]",
  );
  const text = output.readText();
  assertNoRawCredentialPayload(text);
  assert.doesNotMatch(text, /secret_state/);
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
  assert.match(text, /codeq8 threads children \[parent-thread-id\] \[--status active\] \[--limit 25\] \[--json\]/);
  assert.match(text, /Assigned thread lists label child rows as child-of:<parent-thread-id>\./);
  assert.match(text, /currently supports the active\/open lifecycle only/);
  assert.match(text, /codeq8 threads message <thread-id> --text text/);
  assert.match(text, /codeq8 threads title <thread-id> --title text/);
  assert.match(text, /codeq8 threads archive <thread-id>\s+\(alias: close\)/);
  assert.match(text, /codeq8 threads reopen <thread-id>/);
  assert.doesNotMatch(text, /threads steer/);

  const cliSource = await fs.readFile(
    new URL("../src/runner-helper.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(cliSource, /command === "steer"/);
  assert.doesNotMatch(cliSource, /threads steer/);
});

