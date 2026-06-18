import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { jsonResponse, listAuthFiles, runCli, withMockServer, withTempConfig } from "./cli-test-helpers.mjs";

test("shows help", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Codeq8 CLI/);
  assert.doesNotMatch(result.stdout, /codeq8 run/);
});

test("github help is available by bucket", async () => {
  const result = await runCli(["github", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Codeq8 CLI - github/);
  assert.match(result.stdout, /codeq8 github issue --help/);
  assert.match(result.stdout, /codeq8 github pr --help/);
});

test("github issue help shows issue subcommands", async () => {
  const result = await runCli(["github", "issue", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /codeq8 github issue view/);
  assert.match(result.stdout, /codeq8 github issue create/);
  assert.match(result.stdout, /codeq8 github issue update/);
});

test("auth status reports unauthenticated json", async () => {
  const mock = await withMockServer((request, response) => {
    jsonResponse(response, 401, { ok: false, authenticated: false, error: "Unauthorized." });
  });
  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
    };

    const result = await runCli(["auth", "status", "--json"], { env });
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.authenticated, false);
  } finally {
    await mock.close();
  }
});

test("auth login with --token exchanges and stores session token", async () => {
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "cli-session-token",
        github_login: "aalzanki",
      });
      return;
    }

    if (request.method === "GET" && request.url === "/api/cli/auth/status") {
      const authHeader = String(request.headers.authorization || "");
      if (authHeader !== "Bearer cli-session-token") {
        jsonResponse(response, 401, { ok: false, error: "Unauthorized." });
        return;
      }
      jsonResponse(response, 200, {
        ok: true,
        authenticated: true,
        github_login: "aalzanki",
        expires_at: 9999999999,
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

    const login = await runCli(["auth", "login", "--with-token", "--token", "ghp_test"], {
      env,
    });
    assert.equal(login.status, 0);

    const authFiles = listAuthFiles(env.CODEQ8_CONFIG_HOME);
    assert.equal(authFiles.length, 1);
    const stored = JSON.parse(readFileSync(authFiles[0], "utf8"));
    assert.equal(stored.token, "cli-session-token");

    const status = await runCli(["auth", "status", "--json"], { env });
    assert.equal(status.status, 0);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.authenticated, true);
    assert.equal(payload.github_login, "aalzanki");
  } finally {
    await mock.close();
  }
});

test("auth login reads token from stdin", async () => {
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "stdin-session-token",
        github_login: "aalzanki",
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
    const login = await runCli(["auth", "login", "--with-token"], {
      env,
      input: "ghp_from_stdin\n",
    });

    assert.equal(login.status, 0);
    const authFiles = listAuthFiles(env.CODEQ8_CONFIG_HOME);
    assert.equal(authFiles.length, 1);
    const stored = JSON.parse(readFileSync(authFiles[0], "utf8"));
    assert.equal(stored.token, "stdin-session-token");
  } finally {
    await mock.close();
  }
});

test("auth logout clears token", async () => {
  let logoutAuthorization = "";
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/cli/auth/logout") {
      logoutAuthorization = String(request.headers.authorization || "");
      jsonResponse(response, 200, { ok: true, revoked: true });
      return;
    }
    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
    };
    await runCli(["auth", "login", "--with-token", "--token", "ghp_test"], {
      env,
    });

    const logout = await runCli(["auth", "logout"], {
      env,
    });
    assert.equal(logout.status, 0);
    assert.equal(logoutAuthorization, "Bearer session-token");
    const authFiles = listAuthFiles(env.CODEQ8_CONFIG_HOME);
    assert.equal(authFiles.length, 0);
  } finally {
    await mock.close();
  }
});

test("top-level login status/logout commands work", async () => {
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
        github_login: "aalzanki",
      });
      return;
    }

    if (request.method === "GET" && request.url === "/api/cli/auth/status") {
      const authHeader = String(request.headers.authorization || "");
      if (authHeader !== "Bearer session-token") {
        jsonResponse(response, 401, { ok: false, error: "Unauthorized." });
        return;
      }
      jsonResponse(response, 200, {
        ok: true,
        authenticated: true,
        github_login: "aalzanki",
        expires_at: 9999999999,
      });
      return;
    }

    if (request.method === "POST" && request.url === "/api/cli/auth/logout") {
      jsonResponse(response, 200, { ok: true, revoked: true });
      return;
    }

    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
    };

    const login = await runCli(["login", "--with-token", "--token", "ghp_test"], { env });
    assert.equal(login.status, 0);

    const status = await runCli(["login", "status", "--json"], { env });
    assert.equal(status.status, 0);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.authenticated, true);
    assert.equal(payload.github_login, "aalzanki");

    const logout = await runCli(["logout"], { env });
    assert.equal(logout.status, 0);
    const authFiles = listAuthFiles(env.CODEQ8_CONFIG_HOME);
    assert.equal(authFiles.length, 0);
  } finally {
    await mock.close();
  }
});

test("repo list in non-interactive mode requires explicit login", async () => {
  const env = withTempConfig();
  const listed = await runCli(["repo", "list"], { env });
  assert.equal(listed.status, 1);
  assert.match(listed.stderr, /Not logged in/);
  assert.match(listed.stderr, /Non-interactive mode detected/);
  assert.match(listed.stderr, /codeq8 login --with-token --token <github_token>/);
});

test("repo list clears stale local auth on unauthorized response", async () => {
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "stale-session-token",
      });
      return;
    }

    if (request.method === "GET" && request.url === "/api/cli/repos") {
      jsonResponse(response, 401, { ok: false, error: "Unauthorized." });
      return;
    }

    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
    };

    const login = await runCli(["login", "--with-token", "--token", "ghp_test"], { env });
    assert.equal(login.status, 0);
    assert.equal(listAuthFiles(env.CODEQ8_CONFIG_HOME).length, 1);

    const listed = await runCli(["repo", "list"], { env });
    assert.equal(listed.status, 1);
    assert.match(listed.stderr, /Unauthorized/);
    assert.equal(listAuthFiles(env.CODEQ8_CONFIG_HOME).length, 0);
  } finally {
    await mock.close();
  }
});

test("repo list returns repositories", async () => {
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
      });
      return;
    }
    if (request.method === "GET" && request.url === "/api/cli/repos") {
      jsonResponse(response, 200, {
        ok: true,
        repositories: ["iScoot-LLC/Codeq8", "iScoot-LLC/iScoot"],
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
    await runCli(["auth", "login", "--with-token", "--token", "ghp_test"], { env });

    const listed = await runCli(["repo", "list", "--json"], { env });
    assert.equal(listed.status, 0);
    const payload = JSON.parse(listed.stdout);
    assert.deepEqual(payload.repositories, ["iScoot-LLC/Codeq8", "iScoot-LLC/iScoot"]);
  } finally {
    await mock.close();
  }
});
