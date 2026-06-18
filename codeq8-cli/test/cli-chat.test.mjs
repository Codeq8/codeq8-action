import test from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, runCli, withMockServer, withTempConfig } from "./cli-test-helpers.mjs";

test("chat thread show returns thread details", async () => {
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
      });
      return;
    }
    if (request.method === "GET" && request.url === "/api/cli/chat/threads/wct_123") {
      jsonResponse(response, 200, {
        ok: true,
        thread: {
          thread_id: "wct_123",
          workspace_repository: "iScoot-LLC/Codeq8",
          title: "PR thread",
          status: "active",
          source_type: "pull_request",
          branch_context: {
            context_branch: "feature/test",
            base_branch: "main",
            pull_request_number: 91,
            write_mode: "direct_push",
          },
          codex_session_state: {
            status: "ready",
          },
        },
      });
      return;
    }
    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
    };
    await runCli(["login", "--with-token", "--token", "ghp_test"], { env });

    const shown = await runCli(["chat", "thread", "show", "wct_123"], { env });
    assert.equal(shown.status, 0);
    assert.match(shown.stdout, /Thread: wct_123/);
    assert.match(shown.stdout, /Repository: iScoot-LLC\/Codeq8/);
    assert.match(shown.stdout, /Pull request: #91/);
  } finally {
    await mock.close();
  }
});

test("chat thread list returns paginated thread summaries", async () => {
  let requestedUrl = "";
  let requestedAuthorization = "";
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
      });
      return;
    }
    if (request.method === "GET" && request.url.startsWith("/api/cli/chat/threads?")) {
      requestedUrl = String(request.url || "");
      requestedAuthorization = String(request.headers.authorization || "");
      jsonResponse(response, 200, {
        ok: true,
        repository: "iScoot-LLC/Codeq8",
        threads: [
          {
            thread_id: "wct_123",
            workspace_repository: "iScoot-LLC/Codeq8",
            title: "PR thread",
            status: "active",
            source_type: "pull_request",
            updated_at: 1700000000000,
            branch_context: {
              context_branch: "feature/test",
              pull_request_number: 91,
            },
          },
          {
            thread_id: "wct_124",
            workspace_repository: "iScoot-LLC/Codeq8",
            title: "Branch thread",
            status: "active",
            source_type: "branch",
            updated_at: 1700000000100,
            branch_context: {
              context_branch: "feature/queue",
            },
          },
        ],
        page_count: 2,
        has_more: true,
        next_before_updated_at: 1699999999999,
        next_before_thread_id: "wct_prev",
      });
      return;
    }
    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
    };
    await runCli(["login", "--with-token", "--token", "ghp_test"], { env });

    const listed = await runCli(
      [
        "chat",
        "thread",
        "list",
        "--repo",
        "iScoot-LLC/Codeq8",
        "--status",
        "active",
        "--limit",
        "25",
        "--before-updated-at",
        "1700000000200",
        "--before-thread-id",
        "wct_999",
      ],
      { env },
    );
    assert.equal(listed.status, 0);
    assert.equal(requestedAuthorization, "Bearer session-token");
    assert.match(requestedUrl, /workspace_repository=iScoot-LLC%2FCodeq8/);
    assert.match(requestedUrl, /status=active/);
    assert.match(requestedUrl, /limit=25/);
    assert.match(requestedUrl, /before_updated_at=1700000000200/);
    assert.match(requestedUrl, /before_thread_id=wct_999/);
    assert.match(listed.stdout, /Repository: iScoot-LLC\/Codeq8/);
    assert.match(listed.stdout, /wct_123\tactive\tpull_request\t#91\tPR thread/);
    assert.match(listed.stdout, /wct_124\tactive\tbranch\tfeature\/queue\tBranch thread/);
    assert.match(listed.stdout, /Has more: yes/);
    assert.match(listed.stdout, /Next before updated_at: 1699999999999/);
    assert.match(listed.stdout, /Next before thread_id: wct_prev/);
  } finally {
    await mock.close();
  }
});

test("chat thread messages returns paginated thread history", async () => {
  let requestedUrl = "";
  let requestedAuthorization = "";
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
      });
      return;
    }
    if (request.method === "GET" && request.url.startsWith("/api/cli/chat/threads/wct_123/messages?")) {
      requestedUrl = String(request.url || "");
      requestedAuthorization = String(request.headers.authorization || "");
      jsonResponse(response, 200, {
        ok: true,
        thread: {
          thread_id: "wct_123",
          workspace_repository: "iScoot-LLC/Codeq8",
          title: "PR thread",
        },
        messages: [
          {
            message_id: "wcm_1",
            thread_id: "wct_123",
            role: "user",
            content: "hello",
            github_login: "aalzanki",
            metadata: {},
            created_at: 1700000000000,
          },
          {
            message_id: "wcm_2",
            thread_id: "wct_123",
            role: "assistant",
            content: "hi there",
            github_login: "codeq8",
            metadata: {
              attachments: [{ name: "notes.txt" }],
            },
            created_at: 1700000000001,
          },
        ],
        page_count: 2,
        has_more: true,
        next_before_created_at: 1699999999999,
        next_before_message_id: "wcm_prev",
      });
      return;
    }
    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
    };
    await runCli(["login", "--with-token", "--token", "ghp_test"], { env });

    const listed = await runCli(
      [
        "chat",
        "thread",
        "messages",
        "wct_123",
        "--limit",
        "30",
        "--before-created-at",
        "1700000000002",
        "--before-message-id",
        "wcm_3",
      ],
      { env },
    );
    assert.equal(listed.status, 0);
    assert.equal(requestedAuthorization, "Bearer session-token");
    assert.match(requestedUrl, /limit=30/);
    assert.match(requestedUrl, /before_created_at=1700000000002/);
    assert.match(requestedUrl, /before_message_id=wcm_3/);
    assert.match(listed.stdout, /Thread: wct_123/);
    assert.match(listed.stdout, /Repository: iScoot-LLC\/Codeq8/);
    assert.match(listed.stdout, /\[user aalzanki @ 1700000000000\]/);
    assert.match(listed.stdout, /attachment: notes\.txt/);
    assert.match(listed.stdout, /Has more: yes/);
    assert.match(listed.stdout, /Next before created_at: 1699999999999/);
    assert.match(listed.stdout, /Next before message_id: wcm_prev/);
  } finally {
    await mock.close();
  }
});

test("chat thread messages --json preserves cursor fields and thread identity", async () => {
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
      });
      return;
    }
    if (request.method === "GET" && request.url.startsWith("/api/cli/chat/threads/wct_legacy/messages?")) {
      jsonResponse(response, 200, {
        ok: true,
        thread: {
          thread_id: "wct_legacy",
          workspace_repository: "iScoot-LLC/iScoot",
          workspace_owner_login: "iScoot-LLC",
          title: "PR #789",
        },
        messages: [
          {
            message_id: "wcm_legacy_1",
            thread_id: "wct_legacy",
            role: "user",
            content: "CLI pagination turn two",
            github_login: "abdul",
            metadata: {},
            created_at: 1700000000200,
          },
          {
            message_id: "wcm_legacy_2",
            thread_id: "wct_legacy",
            role: "assistant",
            content: "Fixture resume reply: CLI pagination turn two",
            github_login: "codeq8",
            metadata: {},
            created_at: 1700000000201,
          },
        ],
        page_count: 2,
        has_more: true,
        next_before_created_at: 1700000000100,
        next_before_message_id: "wcm_legacy_prev",
      });
      return;
    }
    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
    };
    await runCli(["login", "--with-token", "--token", "ghp_test"], { env });

    const listed = await runCli(
      ["chat", "thread", "messages", "wct_legacy", "--json"],
      { env },
    );
    assert.equal(listed.status, 0);
    const payload = JSON.parse(listed.stdout);
    assert.equal(payload.thread.thread_id, "wct_legacy");
    assert.equal(payload.thread.workspace_repository, "iScoot-LLC/iScoot");
    assert.equal(payload.thread.workspace_owner_login, "iScoot-LLC");
    assert.equal(payload.thread.title, "PR #789");
    assert.equal(payload.page_count, 2);
    assert.equal(payload.has_more, true);
    assert.equal(payload.next_before_created_at, 1700000000100);
    assert.equal(payload.next_before_message_id, "wcm_legacy_prev");
    assert.deepEqual(
      payload.messages.map((message) => message.content),
      [
        "CLI pagination turn two",
        "Fixture resume reply: CLI pagination turn two",
      ],
    );
  } finally {
    await mock.close();
  }
});

test("chat thread create posts canonical payload and infers pull request threads", async () => {
  let requestedAuthorization = "";
  let requestBody = null;
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/cli/chat/threads") {
      requestedAuthorization = String(request.headers.authorization || "");
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        requestBody = JSON.parse(raw || "{}");
        jsonResponse(response, 200, {
          ok: true,
          created: true,
          thread: {
            thread_id: "wct_456",
            workspace_repository: "iScoot-LLC/Codeq8",
            title: "PR orchestration thread",
            status: "active",
            source_type: "pull_request",
            branch_context: {
              context_branch: "feature/test",
              base_branch: "main",
              pull_request_number: 91,
              write_mode: "branch_and_pr",
            },
          },
        });
      });
      return;
    }
    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
      CODE_WORKSPACE_REPOSITORY: "iScoot-LLC/Codeq8",
    };
    await runCli(["login", "--with-token", "--token", "ghp_test"], { env });

    const created = await runCli(
      [
        "chat",
        "thread",
        "create",
        "--title",
        "PR orchestration thread",
        "--pull-request",
        "91",
        "--json",
      ],
      { env },
    );
    assert.equal(created.status, 0);
    assert.equal(requestedAuthorization, "Bearer session-token");
    assert.deepEqual(requestBody, {
      repository: "iScoot-LLC/Codeq8",
      title: "PR orchestration thread",
      source_type: "pull_request",
      pull_request: "91",
    });
    const payload = JSON.parse(created.stdout);
    assert.equal(payload.created, true);
    assert.equal(payload.thread.thread_id, "wct_456");
    assert.equal(payload.thread.source_type, "pull_request");
    assert.equal(payload.thread.branch_context.pull_request_number, 91);
  } finally {
    await mock.close();
  }
});

test("chat thread target-pr posts canonical PR retarget request", async () => {
  let requestedAuthorization = "";
  let requestBody = null;
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/cli/chat/threads/wct_123") {
      requestedAuthorization = String(request.headers.authorization || "");
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        requestBody = JSON.parse(raw || "{}");
        jsonResponse(response, 200, {
          ok: true,
          updated: true,
          action: "target_pr",
          target: "pr:91",
          thread: {
            thread_id: "wct_123",
            workspace_repository: "iScoot-LLC/Codeq8",
            title: "PR thread",
            status: "active",
            source_type: "pull_request",
            branch_context: {
              context_branch: "feature/test",
              base_branch: "main",
              pull_request_number: 91,
              write_mode: "direct_push",
            },
            codex_session_state: {
              status: "ready",
            },
          },
        });
      });
      return;
    }
    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
    };
    await runCli(["login", "--with-token", "--token", "ghp_test"], { env });

    const updated = await runCli(
      ["chat", "thread", "target-pr", "wct_123", "91", "--json"],
      { env },
    );
    assert.equal(updated.status, 0);
    assert.equal(requestedAuthorization, "Bearer session-token");
    assert.deepEqual(requestBody, {
      action: "target_pr",
      pull_request: "91",
    });
    const payload = JSON.parse(updated.stdout);
    assert.equal(payload.action, "target_pr");
    assert.equal(payload.target, "pr:91");
    assert.equal(payload.thread.source_type, "pull_request");
  } finally {
    await mock.close();
  }
});

test("chat thread send posts canonical message payload", async () => {
  let requestedAuthorization = "";
  let requestBody = null;
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/cli/chat/threads/wct_123/messages") {
      requestedAuthorization = String(request.headers.authorization || "");
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        requestBody = JSON.parse(raw || "{}");
        jsonResponse(response, 200, {
          ok: true,
          created: true,
          dispatched: false,
          thread: {
            thread_id: "wct_123",
            workspace_repository: "iScoot-LLC/Codeq8",
            title: "Manager thread",
            status: "active",
            source_type: "branch",
            branch_context: {
              context_branch: "feature/test",
              base_branch: "main",
              write_mode: "branch_and_pr",
            },
          },
          message: {
            message_id: "wcm_123",
            thread_id: "wct_123",
            role: "user",
            content: "Please review child thread",
            github_login: "aalzanki",
            metadata: {
              dispatch: false,
            },
            created_at: 1700000000200,
          },
        });
      });
      return;
    }
    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
    };
    await runCli(["login", "--with-token", "--token", "ghp_test"], { env });

    const sent = await runCli(
      [
        "chat",
        "thread",
        "send",
        "wct_123",
        "--no-dispatch",
        "Please",
        "review",
        "child",
        "thread",
      ],
      { env },
    );
    assert.equal(sent.status, 0);
    assert.equal(requestedAuthorization, "Bearer session-token");
    assert.deepEqual(requestBody, {
      content: "Please review child thread",
      metadata: {
        dispatch: false,
      },
    });
    assert.match(sent.stdout, /Sent thread message wcm_123\./);
    assert.match(sent.stdout, /Thread: wct_123/);
    assert.match(sent.stdout, /Repository: iScoot-LLC\/Codeq8/);
  } finally {
    await mock.close();
  }
});

test("chat thread set-title posts a human-readable thread title mutation", async () => {
  let requestBody = null;
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/cli/chat/threads/wct_123") {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        requestBody = JSON.parse(raw || "{}");
        jsonResponse(response, 200, {
          ok: true,
          updated: true,
          action: "set_title",
          target: "Improve challenge authoring infrastructure",
          thread: {
            thread_id: "wct_123",
            workspace_repository: "iScoot-LLC/Codeq8",
            title: "Improve challenge authoring infrastructure",
            status: "active",
            source_type: "branch",
            branch_context: {
              context_branch: "feature/test",
              base_branch: "main",
              pull_request_number: 0,
              write_mode: "direct_push",
            },
            codex_session_state: {
              status: "ready",
            },
          },
        });
      });
      return;
    }
    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
    };
    await runCli(["login", "--with-token", "--token", "ghp_test"], { env });

    const updated = await runCli(
      ["chat", "thread", "set-title", "wct_123", "Improve", "challenge", "authoring", "infrastructure"],
      { env },
    );
    assert.equal(updated.status, 0);
    assert.deepEqual(requestBody, {
      action: "set_title",
      title: "Improve challenge authoring infrastructure",
    });
    assert.match(updated.stdout, /Updated thread title -> Improve challenge authoring infrastructure/);
  } finally {
    await mock.close();
  }
});

test("chat thread target-branch and clear-target post canonical thread mutations", async () => {
  const requests = [];
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/cli/chat/threads/wct_123") {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(raw || "{}"));
        jsonResponse(response, 200, {
          ok: true,
          updated: true,
          action: requests.length === 1 ? "target_branch" : "clear_target",
          target: requests.length === 1 ? "branch:feature/test" : "default:main",
          thread: {
            thread_id: "wct_123",
            workspace_repository: "iScoot-LLC/Codeq8",
            title: "Thread",
            status: "active",
            source_type: requests.length === 1 ? "branch" : "default_branch",
            branch_context: {
              context_branch: requests.length === 1 ? "feature/test" : "main",
              base_branch: requests.length === 1 ? "" : "main",
              pull_request_number: 0,
              write_mode: requests.length === 1 ? "direct_push" : "branch_and_pr",
            },
            codex_session_state: {
              status: "missing",
            },
          },
        });
      });
      return;
    }
    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
    };
    await runCli(["login", "--with-token", "--token", "ghp_test"], { env });

    const branchTarget = await runCli(
      ["chat", "thread", "target-branch", "wct_123", "feature/test"],
      { env },
    );
    assert.equal(branchTarget.status, 0);
    assert.match(branchTarget.stdout, /Updated thread target via target-branch -> branch:feature\/test/);

    const cleared = await runCli(["chat", "thread", "clear-target", "wct_123", "--json"], {
      env,
    });
    assert.equal(cleared.status, 0);
    assert.deepEqual(requests, [
      {
        action: "target_branch",
        branch: "feature/test",
      },
      {
        action: "clear_target",
      },
    ]);
    const payload = JSON.parse(cleared.stdout);
    assert.equal(payload.action, "clear_target");
    assert.equal(payload.thread.source_type, "default_branch");
  } finally {
    await mock.close();
  }
});
