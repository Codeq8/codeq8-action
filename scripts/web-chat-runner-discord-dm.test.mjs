import assert from "node:assert/strict";
import test from "node:test";

import {
  handleRunnerDiscordDmCli,
  listRunnerDiscordDmMessages,
  sendRunnerDiscordDmMessage,
} from "./web-chat-runner-discord-dm.mjs";

test("listRunnerDiscordDmMessages posts to the runner Discord DM list route", async () => {
  const calls = [];
  const payload = await listRunnerDiscordDmMessages(
    {
      limit: 5,
      beforeCreatedAt: 123,
      beforeEventId: "evt_123",
    },
    {
      env: {
        CODE_PUBLIC_BASE_URL: "https://codeq8.example.com",
        CODE_WEB_CHAT_RUN_TOKEN: "header.payload.signature",
        CODE_WORKSPACE_REPOSITORY: "Codeq8/Codeq8",
        CODE_CHAT_THREAD_ID: "wct_123",
        CODE_CHAT_RUN_ID: "wcr_123",
      },
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method || "GET",
          headers: new Headers(init?.headers || {}),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json({
          ok: true,
          contract_version: "web_chat_runner_runtime_v1",
          messages: [
            {
              event_id: "evt_123",
              message_id: "1234567890",
              event_kind: "discord_message",
              direction: "inbound",
              created_at: 123,
              content_text: "Need clarification",
              transcript_text: "",
            },
          ],
          page_count: 1,
          has_more: true,
          next_before_created_at: 122,
          next_before_event_id: "evt_122",
        });
      },
    },
  );

  assert.equal(payload.messages.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://codeq8.example.com/api/chat/runs/discord-dm/list");
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer header.payload.signature");
  assert.deepEqual(calls[0]?.body, {
    workspace_repository: "Codeq8/Codeq8",
    thread_id: "wct_123",
    run_id: "wcr_123",
    limit: 5,
    before_created_at: 123,
    before_event_id: "evt_123",
  });
});

test("sendRunnerDiscordDmMessage posts to the runner Discord DM send route", async () => {
  const calls = [];
  const payload = await sendRunnerDiscordDmMessage(
    {
      content: "Can you confirm the desired behavior?",
    },
    {
      env: {
        CODE_PUBLIC_BASE_URL: "https://codeq8.example.com",
        CODE_WEB_CHAT_RUN_TOKEN: "header.payload.signature",
        CODE_WORKSPACE_REPOSITORY: "Codeq8/Codeq8",
        CODE_CHAT_THREAD_ID: "wct_123",
        CODE_CHAT_RUN_ID: "wcr_123",
      },
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json({
          ok: true,
          contract_version: "web_chat_runner_runtime_v1",
          sent: true,
          recorded: true,
          skipped: false,
          reason: "",
          message_id: "987654321",
          event_id: "evt_sent",
        });
      },
    },
  );

  assert.equal(payload.sent, true);
  assert.equal(calls[0]?.url, "https://codeq8.example.com/api/chat/runs/discord-dm/send");
  assert.deepEqual(calls[0]?.body, {
    workspace_repository: "Codeq8/Codeq8",
    thread_id: "wct_123",
    run_id: "wcr_123",
    content: "Can you confirm the desired behavior?",
  });
});

test("handleRunnerDiscordDmCli prints paginated list output", async (t) => {
  const stdout = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    stdout.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stdout.write = originalWrite;
  });

  const exitCode = await handleRunnerDiscordDmCli(
    ["list"],
    {
      env: {
        CODE_PUBLIC_BASE_URL: "https://codeq8.example.com",
        CODE_WEB_CHAT_RUN_TOKEN: "header.payload.signature",
        CODE_WORKSPACE_REPOSITORY: "Codeq8/Codeq8",
        CODE_CHAT_THREAD_ID: "wct_123",
        CODE_CHAT_RUN_ID: "wcr_123",
      },
      fetchImpl: async () =>
        Response.json({
          ok: true,
          contract_version: "web_chat_runner_runtime_v1",
          messages: [
            {
              event_id: "evt_voice",
              message_id: "987654321",
              event_kind: "discord_voice_memo",
              direction: "inbound",
              created_at: 123,
              content_text: "",
              transcript_text: "Voice transcript",
            },
          ],
          page_count: 1,
          has_more: true,
          next_before_created_at: 100,
          next_before_event_id: "evt_prev",
        }),
    },
  );

  assert.equal(exitCode, 0);
  const text = stdout.join("");
  assert.match(text, /\[voice\]/);
  assert.match(text, /Voice transcript/);
  assert.match(text, /next_before_created_at=100/);
  assert.match(text, /next_before_event_id=evt_prev/);
});
