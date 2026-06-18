import test from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, runCli, withMockServer, withTempConfig } from "./cli-test-helpers.mjs";

function runnerEnv(baseUrl) {
  return {
    ...withTempConfig(),
    CODE_PUBLIC_BASE_URL: baseUrl,
    CODE_WORKER_URL: baseUrl,
    CODE_WEB_CHAT_RUN_TOKEN: "runner-token",
    CODE_WORKSPACE_REPOSITORY: "Codeq8/Codeq8",
    CODE_CHAT_THREAD_ID: "wct_parent",
    CODE_CHAT_RUN_ID: "wcr_parent",
  };
}

test("runner helper commands are served by the package CLI with runner auth", async () => {
  let requestedAuthorization = "";
  let requestedBody = null;
  const mock = await withMockServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/chat/runs/thread-title") {
      requestedAuthorization = String(request.headers.authorization || "");
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      requestedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      jsonResponse(response, 200, {
        ok: true,
        titled: true,
        updated: true,
        runner_parent_thread_id: "wct_parent",
        runner_parent_run_id: "wcr_parent",
        runner_parent_workspace_repository: "Codeq8/Codeq8",
        thread: {
          thread_id: "wct_child",
          title: "CLI title",
          title_source: "manual",
          status: "active",
        },
      });
      return;
    }
    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const result = await runCli(["threads", "title", "wct_child", "--title", "CLI title"], {
      env: runnerEnv(mock.baseUrl),
    });

    assert.equal(result.status, 0);
    assert.equal(requestedAuthorization, "Bearer runner-token");
    assert.deepEqual(requestedBody, {
      workspace_repository: "Codeq8/Codeq8",
      thread_id: "wct_parent",
      run_id: "wcr_parent",
      target_thread_id: "wct_child",
      title: "CLI title",
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.target_thread_id, "wct_child");
    assert.equal(payload.runner_parent_thread_id, "wct_parent");
    assert.equal(payload.title, "CLI title");
  } finally {
    await mock.close();
  }
});

test("runner helper commands fail clearly without runner environment", async () => {
  const result = await runCli(["threads", "inspect", "wct_123"], {
    env: {
      ...withTempConfig(),
      CODE_PUBLIC_BASE_URL: "",
      CODE_WORKER_URL: "",
      CODE_WEB_CHAT_RUN_TOKEN: "",
      CODE_WORKSPACE_REPOSITORY: "",
      CODE_CHAT_THREAD_ID: "",
      CODE_CHAT_RUN_ID: "",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires runner-scoped environment variables/);
  assert.match(result.stderr, /codeq8 chat thread/);
});
