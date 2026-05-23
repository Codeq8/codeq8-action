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
