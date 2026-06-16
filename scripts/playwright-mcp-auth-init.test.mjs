import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import initCodeq8PlaywrightMcpAuth, {
  isCodeq8McpAuthHostAllowed,
  listCodeq8McpAuthOrigins,
  normalizeCodeq8McpAuthCookie,
  readCodeq8McpAuthCookie,
  seedCodeq8McpAuthCookie,
} from "../plugins/codeq8/playwright-mcp-auth-init.ts";

const REPO_ROOT = process.cwd();

function createPage({ currentUrl = "about:blank" } = {}) {
  const cookies = [];
  const events = new Map();
  let reloadCount = 0;
  return {
    cookies,
    events,
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

test("Playwright MCP auth init does not leak cookie values through logging or storage state", () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "plugins", "codeq8", "playwright-mcp-auth-init.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /console\.(log|warn|error|info|debug)/);
  assert.doesNotMatch(source, /storage-state|storageState/);
  assert.doesNotMatch(source, /writeFile|appendFile|createWriteStream/);
});
