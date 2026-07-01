import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import initCodeq8PlaywrightMcpAuth, {
  exposeCodeq8McpRunTokenRouteProbe,
  isCodeq8McpAuthHostAllowed,
  isCodeq8McpRunTokenRouteAllowed,
  listCodeq8McpAuthOrigins,
  normalizeCodeq8McpAuthCookie,
  readCodeq8McpAuthCookie,
  readCodeq8McpRunToken,
  requestCodeq8McpRunTokenRoute,
  seedCodeq8McpAuthCookie,
} from "../plugins/codeq8/playwright-mcp-auth-init.ts";

const REPO_ROOT = process.cwd();

function createPage({ currentUrl = "about:blank" } = {}) {
  const cookies = [];
  const events = new Map();
  const exposedFunctions = new Map();
  let reloadCount = 0;
  return {
    cookies,
    events,
    exposedFunctions,
    get reloadCount() {
      return reloadCount;
    },
    page: {
      context() {
        return {
          async addCookies(nextCookies) {
            cookies.push(...nextCookies);
          },
        };
      },
      on(eventName, callback) {
        events.set(eventName, callback);
      },
      async exposeFunction(functionName, callback) {
        exposedFunctions.set(functionName, callback);
      },
      async reload() {
        reloadCount += 1;
      },
      url() {
        return currentUrl;
      },
    },
  };
}

function mainFrame(url) {
  return {
    parentFrame() {
      return null;
    },
    url() {
      return url;
    },
  };
}

test("Playwright MCP auth init reads the first available signed web session cookie", () => {
  assert.equal(
    readCodeq8McpAuthCookie({
      CODEQ8_E2E_GITHUB_WEB_SESSION_COOKIE: "",
      CODEQ8_GITHUB_WEB_SESSION_COOKIE: "code_github_session=from-header; Path=/",
      CODEQ8_TRIGGERING_GITHUB_WEB_SESSION_COOKIE: "from-trigger",
    }),
    "from-header",
  );
  assert.equal(normalizeCodeq8McpAuthCookie("raw-cookie-value"), "raw-cookie-value");
  assert.equal(
    normalizeCodeq8McpAuthCookie("other=1; code_github_session=abc=def; Path=/"),
    "abc=def",
  );
});

test("Playwright MCP auth init allows Codeq8 previews and local targets by default", () => {
  assert.equal(
    isCodeq8McpAuthHostAllowed({
      env: {},
      host: "https://codeq8-git-cache-listener-health-validity-iscoot.vercel.app",
    }),
    true,
  );
  assert.equal(
    isCodeq8McpAuthHostAllowed({ env: {}, host: "http://localhost:3000" }),
    true,
  );
  assert.equal(
    isCodeq8McpAuthHostAllowed({ env: {}, host: "https://codeq8.com" }),
    false,
  );
  assert.equal(
    isCodeq8McpAuthHostAllowed({ env: {}, host: "https://evil.vercel.app" }),
    false,
  );
});

test("Playwright MCP auth init requires an explicit host grant for non-preview targets", () => {
  const env = {
    CODEQ8_MCP_AUTH_HOSTS: "staging.codeq8.com, .codeq8.dev, *.example.test",
  };

  assert.equal(
    isCodeq8McpAuthHostAllowed({ env, host: "https://staging.codeq8.com" }),
    true,
  );
  assert.equal(
    isCodeq8McpAuthHostAllowed({ env, host: "https://app.codeq8.dev" }),
    true,
  );
  assert.equal(
    isCodeq8McpAuthHostAllowed({ env, host: "https://pr-2474.example.test" }),
    true,
  );
  assert.equal(
    isCodeq8McpAuthHostAllowed({ env, host: "https://codeq8.com" }),
    false,
  );
});

test("Playwright MCP auth init lists only allowed seed origins", () => {
  assert.deepEqual(
    listCodeq8McpAuthOrigins({
      CODE_DEPLOYED_PUBLIC_URL:
        "https://codeq8-git-cache-listener-health-validity-iscoot.vercel.app/work",
      PLAYWRIGHT_TEST_BASE_URL: "https://codeq8.com",
    }),
    ["https://codeq8-git-cache-listener-health-validity-iscoot.vercel.app"],
  );
});

test("Playwright MCP run-token route probe exposes a read-only run route helper", async () => {
  const requested = [];
  const fetchImpl = async (url, init) => {
    requested.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "application/json" : "";
        },
      },
      async text() {
        return JSON.stringify({
          ok: true,
          thread: {
            thread_id: "wct_target",
            title: "Safe target",
          },
          authorization: "Bearer should-not-return",
          nested: {
            code_github_session: "secret-cookie",
          },
        });
      },
    };
  };
  const state = createPage({
    currentUrl:
      "https://codeq8-git-route-auth-iscoot.vercel.app/Codeq8/Codeq8/thread/wct_parent",
  });

  const exposed = await exposeCodeq8McpRunTokenRouteProbe({
    env: {
      CODE_WEB_CHAT_RUN_TOKEN: "secret-run-token",
      CODE_WORKSPACE_REPOSITORY: "Codeq8/Codeq8",
      CODE_CHAT_THREAD_ID: "wct_parent",
      CODE_CHAT_RUN_ID: "wcr_parent",
    },
    fetchImpl,
    page: state.page,
  });

  assert.equal(exposed, true);
  const probe = state.exposedFunctions.get("__codeq8McpRunTokenRouteProbe");
  assert.equal(typeof probe, "function");
  const result = await probe({
    path: "/api/chat/runs/delegated-thread-state",
    query: {
      target_thread_id: "wct_target",
      limit: 3,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.method, "GET");
  assert.equal(
    result.url,
    "https://codeq8-git-route-auth-iscoot.vercel.app/api/chat/runs/delegated-thread-state?target_thread_id=wct_target&limit=3&workspace_repository=Codeq8%2FCodeq8&thread_id=wct_parent&run_id=wcr_parent",
  );
  assert.equal(result.json.thread.thread_id, "wct_target");
  assert.equal(result.json.authorization, "[redacted]");
  assert.equal(result.json.nested.code_github_session, "[redacted]");
  assert.equal(requested.length, 1);
  assert.equal(requested[0].init.method, "GET");
  assert.equal(requested[0].init.headers.authorization, "Bearer secret-run-token");
  assert.doesNotMatch(JSON.stringify(result), /secret-run-token|secret-cookie|should-not-return/);
});

test("Playwright MCP run-token route probe exposes bounded thread-goal mutation helper", async () => {
  const requested = [];
  const fetchImpl = async (url, init) => {
    requested.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "application/json" : "";
        },
      },
      async text() {
        return JSON.stringify({
          ok: true,
          updated: true,
          target_thread_id: "wct_target",
          codex_goal_state: {
            objective: "Verified through MCP",
            status: "active",
          },
          authorization: "Bearer should-not-return",
        });
      },
    };
  };
  const state = createPage({
    currentUrl:
      "https://codeq8-git-route-auth-iscoot.vercel.app/Codeq8/Codeq8/thread/wct_parent",
  });

  const exposed = await exposeCodeq8McpRunTokenRouteProbe({
    env: {
      CODE_WEB_CHAT_RUN_TOKEN: "secret-run-token",
      CODE_WORKSPACE_REPOSITORY: "Codeq8/Codeq8",
      CODE_CHAT_THREAD_ID: "wct_parent",
      CODE_CHAT_RUN_ID: "wcr_parent",
    },
    fetchImpl,
    page: state.page,
  });

  assert.equal(exposed, true);
  const probe = state.exposedFunctions.get("__codeq8McpRunTokenRouteProbe");
  assert.equal(typeof probe, "function");
  const result = await probe({
    method: "POST",
    path: "/api/chat/runs/thread-goal",
    body: {
      target_thread_id: "wct_target",
      objective: "Verified through MCP",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.method, "POST");
  assert.equal(
    result.url,
    "https://codeq8-git-route-auth-iscoot.vercel.app/api/chat/runs/thread-goal",
  );
  assert.equal(result.json.updated, true);
  assert.equal(result.json.authorization, "[redacted]");
  assert.equal(requested.length, 1);
  assert.equal(requested[0].init.method, "POST");
  assert.equal(requested[0].init.headers.authorization, "Bearer secret-run-token");
  assert.equal(requested[0].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(requested[0].init.body), {
    target_thread_id: "wct_target",
    objective: "Verified through MCP",
    workspace_repository: "Codeq8/Codeq8",
    thread_id: "wct_parent",
    run_id: "wcr_parent",
  });
  assert.doesNotMatch(JSON.stringify(result), /secret-run-token|should-not-return/);
});

test("Playwright MCP run-token route probe exposes bounded delegated create and archive helpers", async () => {
  const requested = [];
  const fetchImpl = async (url, init) => {
    requested.push({ url, init });
    const pathname = new URL(url).pathname;
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "application/json" : "";
        },
      },
      async text() {
        if (pathname.endsWith("/delegated-threads")) {
          return JSON.stringify({
            ok: true,
            delegated: true,
            target_thread_id: "wct_target",
            authorization: "Bearer should-not-return",
            nested: {
              code_github_session: "secret-cookie",
            },
          });
        }
        return JSON.stringify({
          ok: true,
          archived: true,
          target_thread_id: "wct_target",
          cookie: "secret-cookie",
        });
      },
    };
  };
  const state = createPage({
    currentUrl:
      "https://codeq8-git-route-auth-iscoot.vercel.app/Codeq8/Codeq8/thread/wct_parent",
  });

  await exposeCodeq8McpRunTokenRouteProbe({
    env: {
      CODE_WEB_CHAT_RUN_TOKEN: "secret-run-token",
      CODEQ8_TRIGGERING_GITHUB_WEB_SESSION_COOKIE: "secret-cookie",
      CODE_WORKSPACE_REPOSITORY: "Codeq8/Codeq8",
      CODE_CHAT_THREAD_ID: "wct_parent",
      CODE_CHAT_RUN_ID: "wcr_parent",
    },
    fetchImpl,
    page: state.page,
  });

  const probe = state.exposedFunctions.get("__codeq8McpRunTokenRouteProbe");
  const createResult = await probe({
    method: "POST",
    path: "/api/chat/runs/delegated-threads",
    body: {
      mcp_probe: true,
      title: "Disposable MCP delegated smoke",
      assigned_to_kind: "codeq8",
      idempotency_key: "mcp-smoke-1",
      initial_message: {
        role: "user",
        content: "Disposable MCP smoke.",
        metadata: {
          dispatch: false,
        },
      },
    },
  });
  const archiveResult = await probe({
    method: "POST",
    path: "/api/chat/runs/thread-archive",
    body: {
      mcp_probe: true,
      target_thread_id: "wct_target",
    },
  });

  assert.equal(createResult.ok, true);
  assert.equal(createResult.json.target_thread_id, "wct_target");
  assert.equal(createResult.json.authorization, "[redacted]");
  assert.equal(createResult.json.nested.code_github_session, "[redacted]");
  assert.equal(archiveResult.ok, true);
  assert.equal(archiveResult.json.archived, true);
  assert.equal(archiveResult.json.cookie, "[redacted]");
  assert.equal(requested.length, 2);
  assert.deepEqual(JSON.parse(requested[0].init.body), {
    mcp_probe: true,
    title: "Disposable MCP delegated smoke",
    assigned_to_kind: "codeq8",
    idempotency_key: "mcp-smoke-1",
    initial_message: {
      role: "user",
      content: "Disposable MCP smoke.",
      metadata: {
        dispatch: false,
      },
    },
    workspace_repository: "Codeq8/Codeq8",
    thread_id: "wct_parent",
    run_id: "wcr_parent",
  });
  assert.deepEqual(JSON.parse(requested[1].init.body), {
    mcp_probe: true,
    target_thread_id: "wct_target",
    workspace_repository: "Codeq8/Codeq8",
    thread_id: "wct_parent",
    run_id: "wcr_parent",
  });
  for (const request of requested) {
    assert.equal(request.init.headers.authorization, "Bearer secret-run-token");
    assert.equal(request.init.headers.cookie, "code_github_session=secret-cookie");
    assert.equal(request.init.headers["content-type"], "application/json");
  }
  assert.doesNotMatch(
    JSON.stringify({ createResult, archiveResult }),
    /secret-run-token|secret-cookie|should-not-return/,
  );
});

test("Playwright MCP run-token route probe rejects missing token, unsafe routes, and unapproved mutating methods", async () => {
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    throw new Error("fetch should not run for rejected probe requests");
  };
  const pageUrl =
    "https://codeq8-git-route-auth-iscoot.vercel.app/Codeq8/Codeq8/thread/wct_parent";

  assert.equal(readCodeq8McpRunToken({ CODE_WEB_CHAT_RUN_TOKEN: "run-token" }), "run-token");
  assert.equal(
    isCodeq8McpRunTokenRouteAllowed({
      method: "GET",
      targetUrl:
        "https://codeq8-git-route-auth-iscoot.vercel.app/api/chat/runs/delegated-thread-state",
    }),
    true,
  );
  assert.equal(
    isCodeq8McpRunTokenRouteAllowed({
      method: "POST",
      targetUrl:
        "https://codeq8-git-route-auth-iscoot.vercel.app/api/chat/runs/delegated-thread-state",
    }),
    false,
  );
  assert.equal(
    isCodeq8McpRunTokenRouteAllowed({
      method: "POST",
      targetUrl:
        "https://codeq8-git-route-auth-iscoot.vercel.app/api/chat/runs/thread-goal",
    }),
    true,
  );
  assert.equal(
    isCodeq8McpRunTokenRouteAllowed({
      method: "POST",
      targetUrl:
        "https://codeq8-git-route-auth-iscoot.vercel.app/api/chat/runs/delegated-threads",
    }),
    true,
  );
  assert.equal(
    isCodeq8McpRunTokenRouteAllowed({
      method: "POST",
      targetUrl:
        "https://codeq8-git-route-auth-iscoot.vercel.app/api/chat/runs/thread-archive",
    }),
    true,
  );
  assert.equal(
    isCodeq8McpRunTokenRouteAllowed({
      method: "GET",
      targetUrl: "https://codeq8.com/api/chat/runs/delegated-thread-state",
    }),
    false,
  );
  assert.equal(
    isCodeq8McpRunTokenRouteAllowed({
      method: "GET",
      targetUrl: "https://codeq8-git-route-auth-iscoot.vercel.app/api/chat/threads",
    }),
    false,
  );

  assert.deepEqual(
    await requestCodeq8McpRunTokenRoute({
      env: {},
      fetchImpl,
      input: { path: "/api/chat/runs/delegated-thread-state" },
      pageUrl,
    }),
    {
      ok: false,
      blocked: true,
      error: "CODE_WEB_CHAT_RUN_TOKEN is unavailable to the Codeq8 MCP route probe.",
    },
  );

  const rejectedMethod = await requestCodeq8McpRunTokenRoute({
    env: { CODE_WEB_CHAT_RUN_TOKEN: "run-token" },
    fetchImpl,
    input: {
      method: "POST",
      path: "/api/chat/runs/delegated-thread-state",
    },
    pageUrl,
  });
  assert.equal(rejectedMethod.ok, false);
  assert.equal(rejectedMethod.blocked, true);
  assert.match(rejectedMethod.error, /not an allowed run-token route/);

  const rejectedRoute = await requestCodeq8McpRunTokenRoute({
    env: { CODE_WEB_CHAT_RUN_TOKEN: "run-token" },
    fetchImpl,
    input: {
      path: "/api/chat/threads",
    },
    pageUrl,
  });
  assert.equal(rejectedRoute.ok, false);
  assert.equal(rejectedRoute.blocked, true);

  const rejectedDelegatedCreate = await requestCodeq8McpRunTokenRoute({
    env: { CODE_WEB_CHAT_RUN_TOKEN: "run-token" },
    fetchImpl,
    input: {
      method: "POST",
      path: "/api/chat/runs/delegated-threads",
      body: {
        mcp_probe: true,
        assigned_to_kind: "github_user",
        idempotency_key: "mcp-smoke-1",
        initial_message: {
          content: "Unsafe smoke.",
          metadata: {
            dispatch: true,
          },
        },
      },
    },
    pageUrl,
  });
  assert.equal(rejectedDelegatedCreate.ok, false);
  assert.equal(rejectedDelegatedCreate.blocked, true);
  assert.match(rejectedDelegatedCreate.error, /Delegated thread create probes/);

  const rejectedArchiveParent = await requestCodeq8McpRunTokenRoute({
    env: {
      CODE_WEB_CHAT_RUN_TOKEN: "run-token",
      CODE_CHAT_THREAD_ID: "wct_parent",
    },
    fetchImpl,
    input: {
      method: "POST",
      path: "/api/chat/runs/thread-archive",
      body: {
        mcp_probe: true,
        target_thread_id: "wct_parent",
      },
    },
    pageUrl,
  });
  assert.equal(rejectedArchiveParent.ok, false);
  assert.equal(rejectedArchiveParent.blocked, true);
  assert.match(rejectedArchiveParent.error, /target a non-parent thread id/);

  assert.equal(fetchCount, 0);
});

test("Playwright MCP auth init seeds the signed cookie for an allowed target", async () => {
  const { cookies, page } = createPage();
  const seeded = await seedCodeq8McpAuthCookie({
    env: {
      CODEQ8_GITHUB_WEB_SESSION_COOKIE: "signed-session",
    },
    page,
    targetUrl:
      "https://codeq8-git-cache-listener-health-validity-iscoot.vercel.app/chat",
  });

  assert.equal(seeded, true);
  assert.deepEqual(cookies, [
    {
      httpOnly: true,
      name: "code_github_session",
      sameSite: "Lax",
      secure: true,
      url: "https://codeq8-git-cache-listener-health-validity-iscoot.vercel.app",
      value: "signed-session",
    },
  ]);
});

test("Playwright MCP auth init does not seed disallowed or unauthenticated targets", async () => {
  const unauthenticated = createPage();
  assert.equal(
    await seedCodeq8McpAuthCookie({
      env: {},
      page: unauthenticated.page,
      targetUrl:
        "https://codeq8-git-cache-listener-health-validity-iscoot.vercel.app",
    }),
    false,
  );
  assert.deepEqual(unauthenticated.cookies, []);

  const disallowed = createPage();
  assert.equal(
    await seedCodeq8McpAuthCookie({
      env: {
        CODEQ8_GITHUB_WEB_SESSION_COOKIE: "signed-session",
      },
      page: disallowed.page,
      targetUrl: "https://codeq8.com",
    }),
    false,
  );
  assert.deepEqual(disallowed.cookies, []);
});

test("Playwright MCP auth init can attach on first preview navigation and reload once", async () => {
  const state = createPage();
  const { cookies, events, page } = state;
  await initCodeq8PlaywrightMcpAuth({
    env: {
      CODEQ8_GITHUB_WEB_SESSION_COOKIE: "signed-session",
    },
    page,
  });

  const onFrameNavigated = events.get("framenavigated");
  assert.equal(typeof onFrameNavigated, "function");

  onFrameNavigated(
    mainFrame(
      "https://codeq8-git-cache-listener-health-validity-iscoot.vercel.app/chat",
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cookies.length, 1);
  assert.equal(state.reloadCount, 1);

  onFrameNavigated(
    mainFrame(
      "https://codeq8-git-cache-listener-health-validity-iscoot.vercel.app/chat",
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cookies.length, 1);
  assert.equal(state.reloadCount, 1);
});

test("Playwright MCP auth init exposes run-token route probe without requiring a web session cookie", async () => {
  const state = createPage({
    currentUrl:
      "https://codeq8-git-route-auth-iscoot.vercel.app/Codeq8/Codeq8/thread/wct_parent",
  });
  await initCodeq8PlaywrightMcpAuth({
    env: {
      CODE_WEB_CHAT_RUN_TOKEN: "run-token",
    },
    page: state.page,
  });

  assert.equal(state.exposedFunctions.has("__codeq8McpRunTokenRouteProbe"), true);
  assert.equal(state.cookies.length, 0);
  assert.equal(state.events.size, 0);
});

test("Playwright MCP auth init exposes a blocked route probe when the run token is unavailable", async () => {
  const state = createPage({
    currentUrl:
      "https://codeq8-git-route-auth-iscoot.vercel.app/Codeq8/Codeq8/thread/wct_parent",
  });
  await initCodeq8PlaywrightMcpAuth({
    env: {},
    page: state.page,
  });

  const probe = state.exposedFunctions.get("__codeq8McpRunTokenRouteProbe");
  assert.equal(typeof probe, "function");
  assert.deepEqual(
    await probe({
      path: "/api/chat/runs/delegated-thread-state",
      query: {
        target_thread_id: "wct_target",
      },
    }),
    {
      ok: false,
      blocked: true,
      error: "CODE_WEB_CHAT_RUN_TOKEN is unavailable to the Codeq8 MCP route probe.",
    },
  );
  assert.equal(state.cookies.length, 0);
  assert.equal(state.events.size, 0);
});

test("Playwright MCP auth init does not leak cookie values through logging or storage state", () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "plugins", "codeq8", "playwright-mcp-auth-init.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /console\.(log|warn|error|info|debug)/);
  assert.doesNotMatch(source, /storage-state|storageState/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  assert.doesNotMatch(source, /writeFile|appendFile|createWriteStream/);
});
