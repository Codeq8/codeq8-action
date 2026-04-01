#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { readCodexAuthBundle } from "./codex-auth-bundle.mjs";
import {
  parseDeviceAuthProgress,
  stripAnsi,
} from "../lib/chatgpt-auth-session-reconcile.mjs";

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeBaseUrl(value) {
  const normalized = normalizeText(value).replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }
  return /^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`;
}

function log(message, extra = "") {
  const suffix = normalizeText(extra);
  const timestamp = new Date().toISOString();
  console.log(
    `[chatgpt-auth-runner ${timestamp}] ${message}${suffix ? ` | ${suffix}` : ""}`,
  );
}

function escapeGitHubWorkflowCommand(value) {
  return String(value || "")
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

async function appendGitHubStepSummary(markdown) {
  const summaryPath = normalizeText(process.env.GITHUB_STEP_SUMMARY);
  if (!summaryPath || !normalizeText(markdown)) {
    return;
  }
  await fs.appendFile(summaryPath, `${markdown}\n`, "utf8");
}

export function buildGitHubDeviceAuthStepSummary({
  sessionId,
  verificationUri,
  userCode,
  expiresInMinutes,
}) {
  const normalizedUrl = normalizeText(verificationUri);
  const normalizedCode = normalizeText(userCode);
  const normalizedExpiry =
    Number.isFinite(Number(expiresInMinutes)) && Number(expiresInMinutes) > 0
      ? Number(expiresInMinutes)
      : 0;
  if (!normalizedUrl || !normalizedCode) {
    return "";
  }

  const expiryLine = normalizedExpiry
    ? `- Expires in approximately ${normalizedExpiry} minute${normalizedExpiry === 1 ? "" : "s"}.`
    : "";
  return [
    "### ChatGPT device sign-in",
    "",
    `- Session: \`${sessionId}\``,
    `- Verification URL: ${normalizedUrl}`,
    `- One-time code: \`${normalizedCode}\``,
    ...(expiryLine ? [expiryLine] : []),
    "",
    "Open ChatGPT, enter the code above, and complete the sign-in there.",
    "",
  ].join("\n");
}

async function publishGitHubDeviceAuthInstructions({
  sessionId,
  verificationUri,
  userCode,
  expiresInMinutes,
}) {
  const normalizedUrl = normalizeText(verificationUri);
  const normalizedCode = normalizeText(userCode);
  const normalizedExpiry =
    Number.isFinite(Number(expiresInMinutes)) && Number(expiresInMinutes) > 0
      ? Number(expiresInMinutes)
      : 0;
  if (!normalizedUrl || !normalizedCode) {
    return;
  }

  console.log(
    `::notice title=ChatGPT device sign-in code::Open ${escapeGitHubWorkflowCommand(
      normalizedUrl,
    )} and enter ${escapeGitHubWorkflowCommand(normalizedCode)}.`,
  );
  log(
    "ChatGPT device sign-in",
    `session_id=${sessionId} verification_uri=${normalizedUrl} user_code=${normalizedCode}${normalizedExpiry ? ` expires_in_minutes=${normalizedExpiry}` : ""}`,
  );
  await appendGitHubStepSummary(
    buildGitHubDeviceAuthStepSummary({
      sessionId,
      verificationUri: normalizedUrl,
      userCode: normalizedCode,
      expiresInMinutes: normalizedExpiry,
    }),
  );
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function ensureDirectory(targetPath) {
  const normalized = normalizeText(targetPath);
  if (!normalized) {
    return;
  }
  await fs.mkdir(normalized, { recursive: true });
}

async function isFile(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

function summarizeDeviceAuthOutput(output, lineCount = 8) {
  const normalized = stripAnsi(String(output || ""))
    .split(/\r?\n/g)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  if (normalized.length === 0) {
    return "";
  }
  return normalized.slice(-Math.max(1, Number(lineCount) || 1)).join(" | ");
}

export function formatDeviceAuthFailureReason({ code, signal, output }) {
  const normalizedOutput = summarizeDeviceAuthOutput(output, 10);
  const codeLabel =
    Number.isFinite(Number(code)) && Number(code) >= 0
      ? `code=${Number(code)}`
      : "code=unknown";
  const signalLabel = normalizeText(signal) && normalizeText(signal) !== "none"
    ? ` signal=${normalizeText(signal)}`
    : "";
  if (!normalizedOutput) {
    return `Codex device auth exited with ${codeLabel}.${signalLabel}`.trim();
  }
  return `Codex device auth exited with ${codeLabel}.${signalLabel} Output: ${normalizedOutput}`.trim();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  return {
    ok: response.ok,
    status: response.status,
    payload: normalizeObject(payload),
  };
}

async function workerJsonRequest({ workerUrl, authSessionToken, path, method, query, body }) {
  const normalizedWorkerUrl = normalizeBaseUrl(workerUrl);
  const normalizedToken = normalizeText(authSessionToken);
  if (!normalizedWorkerUrl) {
    throw new Error("CODE_WORKER_URL is required.");
  }
  if (!normalizedToken) {
    throw new Error("CODE_CHATGPT_AUTH_SESSION_TOKEN is required.");
  }
  const url = new URL(path, normalizedWorkerUrl);
  if (query) {
    url.search = query.toString();
  }
  return await fetchJson(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${normalizedToken}`,
      ...(method === "POST" ? { "Content-Type": "application/json; charset=utf-8" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(body || {}) } : {}),
  });
}

function decodeJwtClaims(token = "") {
  const normalized = normalizeText(token);
  const segments = normalized.split(".");
  if (segments.length < 2) {
    return {};
  }
  const payloadSegment = segments[1]
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(segments[1].length / 4) * 4, "=");
  try {
    const decoded = Buffer.from(payloadSegment, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return normalizeObject(parsed);
  } catch {
    return {};
  }
}

function readAuthCommandEnv({ homePath, codexHome }) {
  return {
    PATH: String(process.env.PATH || ""),
    HOME: path.resolve(homePath),
    CODEX_HOME: path.resolve(codexHome),
    LANG: process.env.LANG || "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
    TERM: process.env.TERM || "xterm-256color",
    OPENAI_API_KEY: "",
    OPENAI_BASE_URL: "",
    OPENAI_ORG_ID: "",
    OPENAI_PROJECT: "",
    OPENAI_PROJECT_ID: "",
  };
}

async function resolveCodexPath(commandEnv) {
  const candidates = [
    normalizeText(process.env.CODEX_PATH),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }

  const which = await new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", "command -v codex"], {
      env: commandEnv,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.on("close", () => resolve(normalizeText(stdout)));
    child.on("error", () => resolve(""));
  });
  if (normalizeText(which) && (await isFile(which))) {
    return which;
  }
  throw new Error("codex executable was not found.");
}

const readCodexAuthBootstrapBundle = readCodexAuthBundle;

async function createAuthRuntime(sessionId) {
  const prefix =
    normalizeText(sessionId).toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "chatgpt-auth";
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), `codeq8-${prefix}-`));
  const codexHome = path.join(homePath, ".codex");
  await ensureDirectory(codexHome);
  return {
    homePath,
    codexHome,
  };
}

async function cleanupAuthRuntime(runtime) {
  if (!runtime?.homePath) {
    return;
  }
  try {
    await fs.rm(runtime.homePath, { recursive: true, force: true });
  } catch (error) {
    log(
      "Unable to clean auth runtime",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function upsertAuthSession({
  workerUrl,
  authSessionToken,
  sessionId,
  ownerGithubLogin,
  updates,
}) {
  const response = await workerJsonRequest({
    workerUrl,
    authSessionToken,
    path: "/chatgpt-accounts/auth-sessions/upsert",
    method: "POST",
    body: {
      session_id: sessionId,
      owner_github_login: ownerGithubLogin,
      ...updates,
    },
  });
  if (!response.ok || response.payload.ok === false) {
    throw new Error(
      normalizeText(response.payload.error || "") ||
        `Unable to update ChatGPT auth session (${response.status}).`,
    );
  }
  return response.payload.session;
}

async function upsertChatGptAccount({
  workerUrl,
  authSessionToken,
  ownerGithubLogin,
  bundle,
}) {
  const response = await workerJsonRequest({
    workerUrl,
    authSessionToken,
    path: "/chatgpt-accounts/upsert",
    method: "POST",
    body: {
      owner_github_login: ownerGithubLogin,
      account_id: bundle.accountId,
      auth_mode: bundle.authMode,
      display_name: bundle.displayName,
      email: bundle.email,
      subject: bundle.subject,
      bundle: {
        account_id: bundle.accountId,
        auth_mode: bundle.authMode,
        display_name: bundle.displayName,
        email: bundle.email,
        subject: bundle.subject,
        files: bundle.files,
      },
    },
  });
  if (!response.ok || response.payload.ok === false) {
    throw new Error(
      normalizeText(response.payload.error || "") ||
        `Unable to persist ChatGPT account (${response.status}).`,
    );
  }
  return response.payload.account;
}

async function runDeviceAuth({
  codexPath,
  commandEnv,
  cwd,
  onProgress,
}) {
  return await new Promise((resolve) => {
    const child = spawn(codexPath, ["login", "--device-auth"], {
      cwd,
      env: commandEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let combinedOutput = "";
    let lastProgressKey = "";
    const handleChunk = async (chunk) => {
      combinedOutput += String(chunk || "");
      const progress = parseDeviceAuthProgress(combinedOutput);
      if (!progress.verificationUri || !progress.userCode) {
        return;
      }
      const progressKey = `${progress.verificationUri}::${progress.userCode}`;
      if (progressKey === lastProgressKey) {
        return;
      }
      lastProgressKey = progressKey;
      try {
        await onProgress(progress);
      } catch (error) {
        log(
          "Unable to publish device auth progress",
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    child.stdout?.on("data", (chunk) => {
      void handleChunk(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      void handleChunk(chunk);
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        code: -1,
        signal: "error",
        output: combinedOutput,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (code, signal) => {
      resolve({
        ok: Number(code || 0) === 0,
        code: Number.isFinite(code) ? Number(code) : -1,
        signal: signal || "none",
        output: combinedOutput,
        reason:
          Number(code || 0) === 0
            ? ""
            : formatDeviceAuthFailureReason({
                code: Number.isFinite(code) ? Number(code) : -1,
                signal: signal || "none",
                output: combinedOutput,
              }),
      });
    });
  });
}

async function main() {
  const workerUrl =
    normalizeText(process.env.CODE_WORKER_CANONICAL_URL) ||
    normalizeText(process.env.CODE_WORKER_URL);
  const authSessionToken = normalizeText(process.env.CODE_CHATGPT_AUTH_SESSION_TOKEN);
  const sessionId = normalizeText(process.env.CODE_CHATGPT_AUTH_SESSION_ID);
  const ownerGithubLogin = normalizeText(
    process.env.CODE_CHATGPT_AUTH_SESSION_OWNER_GITHUB_LOGIN,
  );
  if (!workerUrl || !authSessionToken || !sessionId || !ownerGithubLogin) {
    throw new Error(
      "CODE_WORKER_CANONICAL_URL or CODE_WORKER_URL, CODE_CHATGPT_AUTH_SESSION_TOKEN, CODE_CHATGPT_AUTH_SESSION_ID, and CODE_CHATGPT_AUTH_SESSION_OWNER_GITHUB_LOGIN are required.",
    );
  }

  let runtime = null;
  let publishedDeviceCode = "";
  try {
    runtime = await createAuthRuntime(sessionId);
    const commandEnv = readAuthCommandEnv({
      homePath: runtime.homePath,
      codexHome: runtime.codexHome,
    });

    await upsertAuthSession({
      workerUrl,
      authSessionToken,
      sessionId,
      ownerGithubLogin,
      updates: {
        status: "starting",
      },
    });

    const codexPath = await resolveCodexPath(commandEnv);
    log("Starting Codex device auth", `session_id=${sessionId} owner=${ownerGithubLogin}`);

    const execution = await runDeviceAuth({
      codexPath,
      commandEnv,
      cwd: runtime.homePath,
      onProgress: async ({ verificationUri, userCode, expiresInMinutes }) => {
        await upsertAuthSession({
          workerUrl,
          authSessionToken,
          sessionId,
          ownerGithubLogin,
          updates: {
            status: "awaiting_device",
            verification_uri: verificationUri,
            user_code: userCode,
            code_expires_at:
              expiresInMinutes > 0 ? Date.now() + expiresInMinutes * 60 * 1000 : 0,
          },
        });
        if (normalizeText(userCode) && normalizeText(userCode) !== publishedDeviceCode) {
          publishedDeviceCode = normalizeText(userCode);
          await publishGitHubDeviceAuthInstructions({
            sessionId,
            verificationUri,
            userCode,
            expiresInMinutes,
          });
        }
        log("Published device auth code", `session_id=${sessionId}`);
      },
    });

    if (!execution.ok) {
      const normalizedOutput = stripAnsi(execution.output || "");
      const terminalStatus =
        /expired/i.test(normalizedOutput) || /timed out/i.test(normalizedOutput)
          ? "expired"
          : "failed";
      await upsertAuthSession({
        workerUrl,
        authSessionToken,
        sessionId,
        ownerGithubLogin,
        updates: {
          status: terminalStatus,
          error:
            normalizeText(execution.reason || "", 1024) ||
            normalizeText(normalizedOutput.split(/\r?\n/g).slice(-6).join(" "), 1024) ||
            "Codex device auth failed.",
        },
      });
      throw new Error(execution.reason || "Codex device auth failed.");
    }

    const bundle = await readCodexAuthBootstrapBundle(runtime.codexHome);
    const persistedAccount = await upsertChatGptAccount({
      workerUrl,
      authSessionToken,
      ownerGithubLogin,
      bundle,
    });
    await upsertAuthSession({
      workerUrl,
      authSessionToken,
      sessionId,
      ownerGithubLogin,
      updates: {
        status: "completed",
        account_id: persistedAccount.account_id || bundle.accountId,
        display_name: bundle.displayName,
        email: bundle.email,
        completed_at: Date.now(),
      },
    });
    log(
      "Completed ChatGPT account auth",
      `session_id=${sessionId} account_id=${persistedAccount.account_id || bundle.accountId}`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to complete ChatGPT account auth.";
    log("ChatGPT account auth failed", message);
    try {
      await upsertAuthSession({
        workerUrl,
        authSessionToken,
        sessionId,
        ownerGithubLogin,
        updates: {
          status: "failed",
          error: normalizeText(message, 1024),
        },
      });
    } catch (sessionError) {
      log(
        "Unable to persist auth failure",
        sessionError instanceof Error ? sessionError.message : String(sessionError),
      );
    }
    process.exitCode = 1;
  } finally {
    await sleep(25);
    await cleanupAuthRuntime(runtime);
  }
}

export {
  decodeJwtClaims,
  parseDeviceAuthProgress,
  readAuthCommandEnv,
  readCodexAuthBootstrapBundle,
  summarizeDeviceAuthOutput,
};

const executedAsScript =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (executedAsScript) {
  await main();
}
