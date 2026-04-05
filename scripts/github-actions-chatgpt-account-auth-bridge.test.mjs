import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatGptAuthRunnerEnv,
  buildGitHubActionsRunUrl,
  normalizeGitHubActionsChatGptAuthPayload,
  readGitHubActionsChatGptAuthPayload,
} from "./github-actions-chatgpt-account-auth-bridge.mjs";

test("readGitHubActionsChatGptAuthPayload reads workflow_dispatch JSON input", async () => {
  const payload = await readGitHubActionsChatGptAuthPayload({
    eventPayload: {
      inputs: {
        run_payload_json: JSON.stringify({
          auth_session_id: "cga_123",
          auth_session_token: "cga_token_123",
          owner_github_login: "Abdul",
        }),
      },
    },
  });

  assert.deepEqual(payload, {
    auth_session_id: "cga_123",
    auth_session_token: "cga_token_123",
    owner_github_login: "Abdul",
  });
});

test("normalizeGitHubActionsChatGptAuthPayload keeps the auth payload shape stable", () => {
  const payload = normalizeGitHubActionsChatGptAuthPayload({
    auth_session_id: "cga_123",
    auth_session_token: "cga_token_123",
    owner_github_login: "Abdul",
    workspace_repository: "iScoot-LLC/Codeq8",
    control_plane_repository: "iScoot-LLC/Codeq8",
  });

  assert.deepEqual(payload, {
    auth_session_id: "cga_123",
    auth_session_token: "cga_token_123",
    owner_github_login: "Abdul",
    workspace_repository: "iScoot-LLC/Codeq8",
    control_plane_repository: "iScoot-LLC/Codeq8",
  });
});

test("buildGitHubActionsRunUrl builds a canonical Actions run URL", () => {
  assert.equal(
    buildGitHubActionsRunUrl({
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "iScoot-LLC/Codeq8",
      GITHUB_RUN_ID: "987654321",
    }),
    "https://github.com/iScoot-LLC/Codeq8/actions/runs/987654321",
  );
});

test("buildChatGptAuthRunnerEnv maps the auth payload onto the runner env", () => {
  const env = buildChatGptAuthRunnerEnv({
    env: {
      GITHUB_REPOSITORY: "iScoot-LLC/Codeq8",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "987654321",
    },
    payload: {
      auth_session_id: "cga_123",
      auth_session_token: "cga_token_123",
      owner_github_login: "Abdul",
      workspace_repository: "iScoot-LLC/Codeq8",
    },
  });

  assert.equal(env.CODE_WORKER_URL, "https://api.codeq8.com");
  assert.equal(env.CODE_WORKER_CANONICAL_URL, "https://api.codeq8.com");
  assert.equal(env.CODE_CHATGPT_AUTH_SESSION_ID, "cga_123");
  assert.equal(env.CODE_CHATGPT_AUTH_SESSION_TOKEN, "cga_token_123");
  assert.equal(env.CODE_CHATGPT_AUTH_SESSION_OWNER_GITHUB_LOGIN, "Abdul");
  assert.equal(env.CODE_CONTROL_PLANE_REPOSITORY, "iScoot-LLC/Codeq8");
  assert.equal(env.CODEQ8_EXECUTION_BACKEND, "github_actions");
  assert.equal(env.CODEQ8_CONTROL_PLANE_RUN_ID, "987654321");
  assert.equal(
    env.CODEQ8_CONTROL_PLANE_URL,
    "https://github.com/iScoot-LLC/Codeq8/actions/runs/987654321",
  );
});
