import test from "node:test";
import assert from "node:assert/strict";
import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { jsonResponse, runCli, withMockServer, withTempConfig } from "./cli-test-helpers.mjs";

test("legacy run command is removed", async () => {
  const result = await runCli(["run", "--help"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: run/);
});

test("auth login tightens token file permissions", { skip: process.platform === "win32" }, async () => {
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "new-token",
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

    const authPath = path.join(env.CODEQ8_CONFIG_HOME, "auth-127.0.0.1_" + new URL(mock.baseUrl).port + ".json");
    writeFileSync(authPath, "{\"token\":\"old\"}\n", { encoding: "utf8", mode: 0o644 });

    const login = await runCli(["auth", "login", "--with-token", "--token", "ghp_test"], {
      env,
    });
    assert.equal(login.status, 0);

    const mode = statSync(authPath).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await mock.close();
  }
});
