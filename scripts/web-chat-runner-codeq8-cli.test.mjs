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
            thread_id: "wct_managed_mine",
            status: "active",
            title: "Managed audit",
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
  assert.match(text, /thread_id\tstatus\trun\ttarget\tupdated_at\ttitle/);
  assert.match(text, /wct_mine\tactive\trunning\t#2499\t2023-11-14T22:13:20\.000Z\tFanout audit/);
  assert.match(text, /wct_managed_mine\tactive\tqueued\tmain\t2023-11-14T22:13:25\.000Z\tManaged audit/);
  assert.doesNotMatch(text, /child-of:/);
  assert.match(text, /Next: --before-updated-at 1699999999999 --before-thread-id wct_cursor/);
  assert.doesNotMatch(text, /secret_stream_token/);
  assert.doesNotMatch(text, /secret_handoff_token/);
});

test("runner codeq8 helper does not expose child thread listing", async () => {
  let calls = 0;
  await assert.rejects(
    handleRunnerCodeq8Cli({
      argv: ["threads", "children", "--limit", "3"],
      env: testEnv(),
      fetchImpl: async () => {
        calls += 1;
        throw new Error("children should not reach the route");
      },
    }),
    /Unknown threads command: children/,
  );

  assert.equal(calls, 0);
});

test("runner codeq8 helper lists scheduled chats with web-session auth only", async () => {
  const output = createOutputCapture();
  const calls = [];
  const exitCode = await handleRunnerCodeq8Cli({
    argv: ["scheduled", "list", "--repository", "iScoot-LLC/iScoot"],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        scheduled_chats: [
          {
            scheduled_chat_id: "wcs_daily",
            workspace_repository: "iScoot-LLC/iScoot",
            title: "Daily error check",
            assigned_to_github_login: "dami",
            prompt: "Check the production errors.",
            cadence: "every_3_days",
            status: "active",
            next_run_at: 1700000000000,
          },
        ],
        has_more: false,
      });
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]?.url);
  assert.equal(url.origin, "https://codeq8.example");
  assert.equal(url.pathname, "/api/scheduled-chats");
  assert.equal(url.searchParams.get("workspace_repository"), "iScoot-LLC/iScoot");
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[0]?.init?.headers?.Authorization, undefined);
  assert.equal(calls[0]?.init?.headers?.Cookie, "code_github_session=session_cookie");

  const text = output.readText();
  assert.match(text, /Repository: iScoot-LLC\/iScoot/);
  assert.match(text, /scheduled_chat_id\tstatus\tassigned_to\tcadence\tnext_run_at\ttitle/);
  assert.match(text, /wcs_daily\tactive\t@dami\tOnce every 3 days\t2023-11-14T22:13:20\.000Z\tDaily error check/);
});

test("runner codeq8 helper creates scheduled chats with custom day cadence", async () => {
  const output = createOutputCapture();
  const calls = [];
  const exitCode = await handleRunnerCodeq8Cli({
    argv: [
      "scheduled",
      "create",
      "--title",
      "Weekly status",
      "--message",
      "Summarize unresolved runner errors.",
      "--every",
      "99d",
      "--json",
    ],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        scheduled_chat: {
          scheduled_chat_id: "wcs_custom",
          workspace_repository: "Codeq8/Codeq8",
          title: "Weekly status",
          assigned_to_github_login: "aalzanki",
          prompt: "Summarize unresolved runner errors.",
          cadence: "every_99_days",
          status: "active",
          next_run_at: 1700604800000,
        },
      });
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]?.url);
  assert.equal(url.origin, "https://codeq8.example");
  assert.equal(url.pathname, "/api/scheduled-chats");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.headers?.Authorization, undefined);
  assert.equal(calls[0]?.init?.headers?.Cookie, "code_github_session=session_cookie");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body || "{}")), {
    workspace_repository: "Codeq8/Codeq8",
    title: "Weekly status",
    prompt: "Summarize unresolved runner errors.",
    cadence: "every_99_days",
  });

  const payload = output.readJson();
  assert.equal(payload.ok, true);
  assert.equal(payload.scheduled_chat.scheduled_chat_id, "wcs_custom");
  assert.equal(payload.scheduled_chat.cadence, "every_99_days");
  assert.equal(payload.scheduled_chat.assigned_to_github_login, "aalzanki");
  assert.equal(payload.scheduled_chat.prompt_preview, "Summarize unresolved runner errors.");
});

test("runner codeq8 helper rejects custom day cadence above ninety-nine days", async () => {
  const output = createOutputCapture();
  await assert.rejects(
    () =>
      handleRunnerCodeq8Cli({
        argv: [
          "scheduled",
          "create",
          "--message",
          "Summarize unresolved runner errors.",
          "--every",
          "100d",
        ],
        env: testEnv(),
        stdout: output.stream,
        fetchImpl: async () => {
          throw new Error("invalid cadence must not fetch");
        },
      }),
    /1-99 day interval/,
  );
  assert.equal(output.readText(), "");
});

test("runner codeq8 helper pauses resumes updates and deletes scheduled chats", async () => {
  const calls = [];
  const env = testEnv();

  await handleRunnerCodeq8Cli({
    argv: ["scheduled", "pause", "wcs_daily", "--json"],
    env,
    stdout: createOutputCapture().stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        scheduled_chat: {
          scheduled_chat_id: "wcs_daily",
          workspace_repository: "Codeq8/Codeq8",
          title: "Daily status",
          prompt: "Check errors.",
          cadence: "day",
          status: "paused",
        },
      });
    },
  });
  await handleRunnerCodeq8Cli({
    argv: ["scheduled", "resume", "wcs_daily", "--json"],
    env,
    stdout: createOutputCapture().stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        scheduled_chat: {
          scheduled_chat_id: "wcs_daily",
          workspace_repository: "Codeq8/Codeq8",
          title: "Daily status",
          prompt: "Check errors.",
          cadence: "day",
          status: "active",
        },
      });
    },
  });
  await handleRunnerCodeq8Cli({
    argv: ["scheduled", "update", "wcs_daily", "--every", "month", "--message", "Check monthly errors.", "--assigned-to", "dami"],
    env,
    stdout: createOutputCapture().stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        scheduled_chat: {
          scheduled_chat_id: "wcs_daily",
          workspace_repository: "Codeq8/Codeq8",
          title: "Daily status",
          assigned_to_github_login: "dami",
          prompt: "Check monthly errors.",
          cadence: "month",
          status: "active",
        },
      });
    },
  });
  await handleRunnerCodeq8Cli({
    argv: ["scheduled", "delete", "wcs_daily"],
    env,
    stdout: createOutputCapture().stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({ ok: true, scheduled_chat: null });
    },
  });

  assert.deepEqual(
    calls.map((call) => {
      const url = new URL(call.url);
      return {
        path: url.pathname,
        method: call.init?.method,
        authorization: call.init?.headers?.Authorization,
        cookie: call.init?.headers?.Cookie,
        body: call.init?.body ? JSON.parse(String(call.init.body)) : null,
      };
    }),
    [
      {
        path: "/api/scheduled-chats/wcs_daily",
        method: "PATCH",
        authorization: undefined,
        cookie: "code_github_session=session_cookie",
        body: { status: "paused" },
      },
      {
        path: "/api/scheduled-chats/wcs_daily",
        method: "PATCH",
        authorization: undefined,
        cookie: "code_github_session=session_cookie",
        body: { status: "active" },
      },
      {
        path: "/api/scheduled-chats/wcs_daily",
        method: "PATCH",
        authorization: undefined,
        cookie: "code_github_session=session_cookie",
        body: {
          prompt: "Check monthly errors.",
          cadence: "month",
          assigned_to_github_login: "dami",
        },
      },
      {
        path: "/api/scheduled-chats/wcs_daily",
        method: "DELETE",
        authorization: undefined,
        cookie: "code_github_session=session_cookie",
        body: null,
      },
    ],
  );
});

test("runner codeq8 helper updates scheduled chat next run controls", async () => {
  const calls = [];
  const env = testEnv();
  const originalNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    await handleRunnerCodeq8Cli({
      argv: ["scheduled", "update", "wcs_daily", "--run-in", "3m", "--json"],
      env,
      stdout: createOutputCapture().stream,
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return Response.json({
          ok: true,
          scheduled_chat: {
            scheduled_chat_id: "wcs_daily",
            workspace_repository: "Codeq8/Codeq8",
            title: "Daily status",
            prompt: "Check errors.",
            cadence: "day",
            status: "active",
            next_run_at: 1_180_000,
          },
        });
      },
    });
    await handleRunnerCodeq8Cli({
      argv: [
        "scheduled",
        "update",
        "wcs_daily",
        "--next-run-at",
        "1970-01-01T00:20:00.000Z",
        "--json",
      ],
      env,
      stdout: createOutputCapture().stream,
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return Response.json({
          ok: true,
          scheduled_chat: {
            scheduled_chat_id: "wcs_daily",
            workspace_repository: "Codeq8/Codeq8",
            title: "Daily status",
            prompt: "Check errors.",
            cadence: "day",
            status: "active",
            next_run_at: 1_200_000,
          },
        });
      },
    });
  } finally {
    Date.now = originalNow;
  }

  assert.deepEqual(
    calls.map((call) => {
      const url = new URL(call.url);
      return {
        path: url.pathname,
        method: call.init?.method,
        authorization: call.init?.headers?.Authorization,
        cookie: call.init?.headers?.Cookie,
        body: call.init?.body ? JSON.parse(String(call.init.body)) : null,
      };
    }),
    [
      {
        path: "/api/scheduled-chats/wcs_daily",
        method: "PATCH",
        authorization: undefined,
        cookie: "code_github_session=session_cookie",
        body: { next_run_at: 1_180_000 },
      },
      {
        path: "/api/scheduled-chats/wcs_daily",
        method: "PATCH",
        authorization: undefined,
        cookie: "code_github_session=session_cookie",
        body: { next_run_at: 1_200_000 },
      },
    ],
  );
});

test("runner codeq8 helper reassigns scheduled chats", async () => {
  const output = createOutputCapture();
  const calls = [];
  const exitCode = await handleRunnerCodeq8Cli({
    argv: ["scheduled", "reassign", "wcs_daily", "--to", "dami"],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        scheduled_chat: {
          scheduled_chat_id: "wcs_daily",
          workspace_repository: "Codeq8/Codeq8",
          title: "Daily status",
          assigned_to_github_login: "dami",
          prompt: "Check errors.",
          cadence: "day",
          status: "active",
        },
      });
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]?.url);
  assert.equal(url.pathname, "/api/scheduled-chats/wcs_daily");
  assert.equal(calls[0]?.init?.method, "PATCH");
  assert.equal(calls[0]?.init?.headers?.Authorization, undefined);
  assert.equal(calls[0]?.init?.headers?.Cookie, "code_github_session=session_cookie");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body || "{}")), {
    assigned_to_github_login: "dami",
  });

  const text = output.readText();
  assert.match(text, /Scheduled chat: wcs_daily/);
  assert.match(text, /Assigned to: @dami/);
});

test("runner codeq8 helper inspects one delegated thread with compact redacted output", async () => {
  const output = createOutputCapture();
  const calls = [];
  const exitCode = await handleRunnerCodeq8Cli({
    argv: ["threads", "inspect", "wct_managed", "--limit", "7"],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        runner_parent_thread_id: "wct_parent",
        runner_parent_run_id: "wcr_parent",
        runner_parent_workspace_repository: "Codeq8/Codeq8",
        target_thread_id: "wct_managed",
        thread: {
          thread_id: "wct_managed",
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
  assert.equal(url.searchParams.get("target_thread_id"), "wct_managed");
  assert.equal(url.searchParams.get("limit"), "7");

  const text = output.readText();
  assert.match(text, /Thread: wct_managed/);
  assert.match(text, /Title: Investigate checks/);
  assert.match(text, /State: status=active aggregate=loading/);
  assert.match(text, /Runner parent: wct_parent run=wcr_parent/);
  assert.doesNotMatch(text, /Target parent:/);
  assert.match(text, /Source: PR #42 https:\/\/github\.com\/Codeq8\/Codeq8\/pull\/42/);
  assert.match(text, /Run: wcr_latest running/);
  assert.match(text, /Checks: pending/);
  assert.match(text, /Progress: status=in_progress \| Inspecting CI logs with token=\[redacted\]/);
  assert.match(text, /assistant: Working through thread_stream_token=\[redacted\] now\./);
  assert.match(text, /Follow-up: codeq8 threads message wct_managed --text "\.\.\."/);
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

test("runner codeq8 helper reads paged run details with compact redacted output", async () => {
  const output = createOutputCapture();
  const calls = [];
  const exitCode = await handleRunnerCodeq8Cli({
    argv: [
      "threads",
      "details",
      "wct_managed",
      "--run",
      "wcr_details",
      "--limit",
      "2",
      "--before-at",
      "1700000002000",
      "--before-event-key",
      "ev_cursor",
    ],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        runner_parent_thread_id: "wct_parent",
        runner_parent_run_id: "wcr_parent",
        runner_parent_workspace_repository: "Codeq8/Codeq8",
        target_thread_id: "wct_managed",
        target_run_id: "wcr_details",
        progress_history: {
          available: true,
          event_count: 3,
          latest_event_at: 1700000003000,
        },
        events: [
          {
            event_id: "evt_1",
            event_key: "ev_1",
            kind: "item",
            item_type: "assistant_reasoning",
            label: "Reading token=secret_details_token",
            status: "completed",
            at: 1700000001000,
            recorded_at: 1700000001500,
          },
          {
            event_id: "evt_2",
            event_key: "ev_2",
            kind: "item",
            item_type: "agent_message_progress",
            label: "Checking the next page cursor",
            status: "completed",
            at: 1700000002000,
            recorded_at: 1700000002500,
          },
        ],
        page_count: 2,
        has_more: true,
        next_before_at: 1700000001000,
        next_before_event_key: "ev_1",
      });
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]?.url);
  assert.equal(url.origin, "https://codeq8.example");
  assert.equal(url.pathname, "/api/chat/runs/thread-run-details");
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(url.searchParams.get("workspace_repository"), "Codeq8/Codeq8");
  assert.equal(url.searchParams.get("thread_id"), "wct_parent");
  assert.equal(url.searchParams.get("run_id"), "wcr_parent");
  assert.equal(url.searchParams.get("target_thread_id"), "wct_managed");
  assert.equal(url.searchParams.get("target_run_id"), "wcr_details");
  assert.equal(url.searchParams.get("limit"), "2");
  assert.equal(url.searchParams.get("before_at"), "1700000002000");
  assert.equal(url.searchParams.get("before_event_key"), "ev_cursor");

  const text = output.readText();
  assert.match(text, /Thread: wct_managed/);
  assert.match(text, /Run: wcr_details/);
  assert.match(text, /Saved details: 3/);
  assert.match(text, /assistant_reasoning completed: Reading token=\[redacted\]/);
  assert.match(text, /agent_message_progress completed: Checking the next page cursor/);
  assert.match(text, /Page: 2 event\(s\), has more: yes/);
  assert.match(text, /Next: --before-at 1700000001000 --before-event-key ev_1/);
  assert.ok(text.length < 1600);
  assertNoRawCredentialPayload(text);
  assert.doesNotMatch(text, /secret_details_token/);
});

test("runner codeq8 helper requires a run id for details", async () => {
  let calls = 0;
  await assert.rejects(
    handleRunnerCodeq8Cli({
      argv: ["threads", "details", "wct_managed"],
      env: testEnv(),
      fetchImpl: async () => {
        calls += 1;
        throw new Error("details should not fetch without --run");
      },
    }),
    /--run is required/,
  );
  assert.equal(calls, 0);
});

test("runner codeq8 helper inspect json returns a redacted snapshot contract", async () => {
  const output = createOutputCapture();
  await handleRunnerCodeq8Cli({
    argv: ["threads", "inspect", "wct_managed", "--json"],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async () =>
      Response.json({
        ok: true,
        runner_parent_thread_id: "wct_parent",
        runner_parent_run_id: "wcr_parent",
        target_thread_id: "wct_managed",
        thread: {
          thread_id: "wct_managed",
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
  assert.equal(snapshot.target_thread_id, "wct_managed");
  assert.equal(snapshot.runner_parent_thread_id, "wct_parent");
  assert.equal(snapshot.runner_parent_run_id, "wcr_parent");
  assert.equal(snapshot.thread.repository, "Codeq8/Codeq8");
  assert.equal(snapshot.run.run_id, "wcr_review");
  assert.equal(snapshot.run.status, "completed");
  assert.equal(snapshot.checks.latest_state, "success");
  assert.equal(snapshot.pull_request.number, 77);
  assert.equal(snapshot.recent_messages[0].preview, "Completed the change.");
  assert.equal(
    snapshot.follow_up_command,
    'codeq8 threads message wct_managed --text "..."',
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
    argv: ["threads", "context", "wct_managed", "--limit", "3"],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        target_thread_id: "wct_managed",
        thread: {
          thread_id: "wct_managed",
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
  assert.equal(url.searchParams.get("target_thread_id"), "wct_managed");
  assert.equal(url.searchParams.get("limit"), "3");
  assert.equal(calls[0]?.init?.headers?.Authorization, "Bearer header.payload.signature");
  assert.equal(calls[0]?.init?.headers?.Cookie, "code_github_session=session_cookie");

  const payload = output.readJson();
  assert.equal(payload.thread.thread_id, "wct_managed");
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
    argv: ["threads", "state", "wct_managed", "--limit", "4"],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        target_thread_id: "wct_managed",
        thread: {
          thread_id: "wct_managed",
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
            run_id: "wcr_managed",
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
  assert.equal(url.searchParams.get("target_thread_id"), "wct_managed");
  assert.equal(url.searchParams.get("limit"), "4");

  const payload = output.readJson();
  assert.equal(payload.target_thread_id, "wct_managed");
  assert.equal(payload.thread.status, "active");
  assert.equal(payload.runs[0].run_id, "wcr_managed");
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
  assert.match(text, /codeq8 threads details <thread-id> --run <run-id> \[--limit 20\] \[--json\]/);
  assert.doesNotMatch(text, /codeq8 threads children/);
  assert.doesNotMatch(text, /child rows|child-of|Child thread/i);
  assert.match(text, /codeq8 threads message <thread-id> --text text/);
  assert.match(text, /codeq8 threads title <thread-id> --title text/);
  assert.match(
    text,
    /codeq8 threads pull-request <thread-id> --pull-request-number n\|--pull-request-url url/,
  );
  assert.match(text, /codeq8 threads archive <thread-id>\s+\(alias: close\)/);
  assert.match(text, /codeq8 threads reopen <thread-id>/);
  assert.match(text, /codeq8 scheduled list \[--repository owner\/repo\] \[--json\]/);
  assert.match(
    text,
    /codeq8 scheduled create --message text --every day\|week\|month\|Nd/,
  );
  assert.match(text, /--run-in 3m\|--next-run-at iso-or-ms/);
  assert.match(text, /codeq8 scheduled reassign <scheduled-chat-id> --to github-login/);
  assert.match(text, /codeq8 scheduled pause\|resume\|delete <scheduled-chat-id>/);
  assert.doesNotMatch(text, /threads steer/);

  const cliSource = await fs.readFile(
    new URL("./web-chat-runner-codeq8-cli.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(cliSource, /command === "steer"/);
  assert.doesNotMatch(cliSource, /threads steer/);
  assert.doesNotMatch(cliSource, /command === "children"/);
  assert.doesNotMatch(cliSource, /children_of_thread_id/);
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

test("runner codeq8 helper associates threads with pull requests through backend contract", async () => {
  const output = createOutputCapture();
  const calls = [];
  await handleRunnerCodeq8Cli({
    argv: ["threads", "pull-request", "wct_target", "--pull-request-number", "2573"],
    env: testEnv(),
    stdout: output.stream,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        associated: true,
        updated: true,
        target_thread_id: "wct_target",
        pull_request_number: 2573,
        pull_request_url: "https://github.com/Codeq8/Codeq8/pull/2573",
        thread: {
          thread_id: "wct_target",
          workspace_repository: "Codeq8/Codeq8",
          title: "Retarget PR thread",
          source_type: "branch",
          branch_context: {
            context_branch: "feature/thread-pr",
            write_branch: "feature/thread-pr",
            base_branch: "main",
            pull_request_number: 2573,
            pull_request_url: "https://github.com/Codeq8/Codeq8/pull/2573",
            pull_request_head_branch: "feature/thread-pr",
            pull_request_base_branch: "main",
          },
          github_context: {
            pull_request: {
              number: 2573,
              html_url: "https://github.com/Codeq8/Codeq8/pull/2573",
              head: { ref: "feature/thread-pr" },
              base: { ref: "main" },
            },
          },
          thread_stream_token: "secret_pr_stream",
          thread_record_handoff: "secret_pr_handoff",
        },
      });
    },
  });

  assert.equal(new URL(calls[0]?.url).pathname, "/api/chat/runs/thread-pull-request");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.headers?.Authorization, "Bearer header.payload.signature");
  assert.equal(calls[0]?.init?.headers?.Cookie, "code_github_session=session_cookie");
  const body = JSON.parse(String(calls[0]?.init?.body || "{}"));
  assert.equal(body.workspace_repository, "Codeq8/Codeq8");
  assert.equal(body.thread_id, "wct_parent");
  assert.equal(body.run_id, "wcr_parent");
  assert.equal(body.target_thread_id, "wct_target");
  assert.equal(body.pull_request_number, "2573");
  assert.equal(Object.hasOwn(body, "pull_request_url"), false);
  const payload = output.readJson();
  assert.equal(payload.ok, true);
  assert.equal(payload.associated, true);
  assert.equal(payload.updated, true);
  assert.equal(payload.target_thread_id, "wct_target");
  assert.deepEqual(payload.pull_request, {
    number: 2573,
    url: "https://github.com/Codeq8/Codeq8/pull/2573",
    head_branch: "feature/thread-pr",
    base_branch: "main",
  });
  assert.deepEqual(payload.branch, {
    context_branch: "feature/thread-pr",
    write_branch: "feature/thread-pr",
    base_branch: "main",
  });
  assert.equal(payload.thread.source_type, "branch");
  assertNoRawCredentialPayload(output.readText());
  assert.doesNotMatch(output.readText(), /secret_pr_/);
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
