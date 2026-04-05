import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  buildGitHubDeviceAuthStepSummary,
  decodeJwtClaims,
  formatDeviceAuthFailureReason,
  parseDeviceAuthProgress,
  readAuthCommandEnv,
  readCodexAuthBootstrapBundle,
  summarizeDeviceAuthOutput,
} from "./web-chat-account-auth-runner.mjs";

function createUnsignedJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

test("parseDeviceAuthProgress extracts the verification URL, code, and expiry", () => {
  const progress = parseDeviceAuthProgress(`
Welcome to Codex [v0.114.0]

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   T8JW-2RNWY
`);

  assert.equal(progress.verificationUri, "https://auth.openai.com/codex/device");
  assert.equal(progress.userCode, "T8JW-2RNWY");
  assert.equal(progress.expiresInMinutes, 15);
});

test("parseDeviceAuthProgress handles ANSI-colored device-auth output", () => {
  const progress = parseDeviceAuthProgress(`
Welcome to Codex [v\u001b[90m0.114.0\u001b[0m]
\u001b[90mOpenAI's command-line coding agent\u001b[0m

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m

2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m
   \u001b[94mTHKC-LBUFL\u001b[0m
`);

  assert.equal(progress.verificationUri, "https://auth.openai.com/codex/device");
  assert.equal(progress.userCode, "THKC-LBUFL");
  assert.equal(progress.expiresInMinutes, 15);
});

test("buildGitHubDeviceAuthStepSummary renders the workflow-facing device auth instructions", () => {
  const summary = buildGitHubDeviceAuthStepSummary({
    sessionId: "session_123",
    verificationUri: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
    expiresInMinutes: 15,
  });

  assert.match(summary, /### ChatGPT device sign-in/);
  assert.match(summary, /session_123/);
  assert.match(summary, /https:\/\/auth\.openai\.com\/codex\/device/);
  assert.match(summary, /ABCD-EFGH/);
  assert.match(summary, /Expires in approximately 15 minutes\./);
});

test("decodeJwtClaims ignores invalid tokens and parses unsigned payloads", () => {
  assert.deepEqual(decodeJwtClaims("not-a-jwt"), {});

  const claims = decodeJwtClaims(
    createUnsignedJwt({
      sub: "user_123",
      email: "abdul@example.com",
      name: "Abdul",
    }),
  );
  assert.equal(claims.sub, "user_123");
  assert.equal(claims.email, "abdul@example.com");
  assert.equal(claims.name, "Abdul");
});

test("readAuthCommandEnv forces an isolated Codex auth environment", () => {
  const env = readAuthCommandEnv({
    homePath: "/tmp/codeq8-auth-home",
    codexHome: "/tmp/codeq8-auth-home/.codex",
  });

  assert.equal(env.HOME, "/tmp/codeq8-auth-home");
  assert.equal(env.CODEX_HOME, "/tmp/codeq8-auth-home/.codex");
  assert.equal(env.OPENAI_API_KEY, "");
  assert.equal(env.OPENAI_BASE_URL, "");
});

test("summarizeDeviceAuthOutput keeps the last meaningful lines", () => {
  const summary = summarizeDeviceAuthOutput(`

warning

Error loading configuration
CODEX_HOME points somewhere invalid

`, 2);

  assert.equal(summary, "Error loading configuration | CODEX_HOME points somewhere invalid");
});

test("formatDeviceAuthFailureReason includes the codex output tail", () => {
  const reason = formatDeviceAuthFailureReason({
    code: 1,
    signal: "none",
    output: `
WARNING: proceeding
Error loading configuration: CODEX_HOME points to "/tmp/.codex", but that path does not exist
`,
  });

  assert.match(reason, /code=1/);
  assert.match(reason, /Error loading configuration/);
  assert.match(reason, /CODEX_HOME points to/);
});

test("readCodexAuthBootstrapBundle reads auth files and derives account metadata", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codeq8-auth-bundle-test-"));
  const codexHome = path.join(tempRoot, ".codex");
  try {
    await mkdir(codexHome, { recursive: true });
    const idToken = createUnsignedJwt({
      sub: "user_123",
      email: "abdul@example.com",
      name: "Abdul",
    });
    await writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          tokens: {
            account_id: "acct_123",
            id_token: idToken,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-5.4"\n', "utf8");

    const bundle = await readCodexAuthBootstrapBundle(codexHome);
    assert.equal(bundle.accountId, "acct_123");
    assert.equal(bundle.authMode, "chatgpt");
    assert.equal(bundle.displayName, "Abdul");
    assert.equal(bundle.email, "abdul@example.com");
    assert.equal(bundle.subject, "user_123");
    assert.equal(typeof bundle.files["auth.json"], "string");
    assert.equal(typeof bundle.files["config.toml"], "string");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
