#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { ensureRunnerGlobalCliTools } from "./runner-global-cli-tools.mjs";
import { readCodexAuthBundle } from "./codex-auth-bundle.mjs";
import {
  buildControlPlaneRequestAuthorizationHeader,
  resolveControlPlaneRequestAuthSecret,
} from "../lib/control-plane-request-auth.mjs";
import {
  executeWorkspaceBootstrapCommands,
  loadWorkspaceCodeq8Config,
  readBootstrapInstallCommands,
} from "../lib/workspace-bootstrap.mjs";
import {
  DEFAULT_CODE_WORKER_BASE_URL,
  resolveChatGptAccountWorkerBaseUrl,
  resolveWorkerBaseUrl,
} from "../lib/code-worker-url.mjs";
const DEFAULT_CODE_PUBLIC_URL = "https://codeq8.com";
const DEFAULT_CODEX_MODEL = "gpt-5.4";
const DEFAULT_CODEX_REASONING_EFFORT = "xhigh";
const DEFAULT_TIMEOUT_SECONDS = 6 * 60 * 60;
const DEFAULT_GIT_HTTP_LOW_SPEED_LIMIT = "1";
const DEFAULT_GIT_HTTP_LOW_SPEED_TIME = "45";
const MAX_CONTEXT_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 2000;
const MAX_OUTPUT_CHARS = 120000;
const MAX_REFERENCED_THREAD_MESSAGES = 8;
const MAX_THREAD_TARGET_RESTARTS = 2;
const MAX_CHATGPT_ACCOUNT_RECOVERY_ATTEMPTS = 8;
const MAX_CODEX_RESUME_RECOVERY_ATTEMPTS = 1;
const CHATGPT_ACCOUNT_AUTH_PRECHECK_TIMEOUT_SECONDS = 45;
const CODEX_SESSION_COMPACTION_TYPES = new Set([
  "compaction",
  "context_compacted",
  "compacted",
]);
const WEB_CHAT_THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const WEB_CHAT_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CODEX_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CODEX_SESSION_RELATIVE_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const RUN_EXECUTION_BACKEND_VALUES = new Set(["runner_pool", "github_actions"]);

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizePromptBlockText(value) {
  return normalizeText(value).replace(/\r\n/g, "\n");
}

function stripLeadingThreadSpecPromptText(promptText, threadSpecText) {
  const normalizedPromptText = normalizePromptBlockText(promptText);
  const normalizedThreadSpecText = normalizePromptBlockText(threadSpecText);
  if (!normalizedPromptText || !normalizedThreadSpecText) {
    return normalizedPromptText;
  }
  const threadSpecPrefix = `Thread spec:\n${normalizedThreadSpecText}`;
  if (normalizedPromptText === threadSpecPrefix) {
    return "";
  }
  if (normalizedPromptText.startsWith(`${threadSpecPrefix}\n\n`)) {
    return normalizePromptBlockText(
      normalizedPromptText.slice(threadSpecPrefix.length + 2),
    );
  }
  return normalizedPromptText;
}

function extractErrorMessage(value, fallback = "") {
  const normalizedFallback = normalizeText(fallback);
  if (value instanceof Error) {
    return extractErrorMessage(value.message, normalizedFallback);
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return normalizeText(value);
  }
  if (Array.isArray(value)) {
    return (
      normalizeText(value.map((entry) => extractErrorMessage(entry)).filter(Boolean).join("\n")) ||
      normalizedFallback
    );
  }
  const normalizedObject = normalizeObject(value);
  if (Object.keys(normalizedObject).length > 0) {
    for (const candidate of [
      normalizedObject.error,
      normalizedObject.message,
      normalizedObject.reason,
      normalizedObject.detail,
      normalizedObject.details,
      normalizedObject.cause,
    ]) {
      const extracted = extractErrorMessage(candidate);
      if (extracted) {
        return extracted;
      }
    }
    try {
      return normalizeText(JSON.stringify(normalizedObject)) || normalizedFallback;
    } catch {
      return normalizedFallback;
    }
  }
  return normalizedFallback;
}

function resolveWebChatRunnerAdminToken(env = process.env) {
  const requestAuthSecret = normalizeText(resolveControlPlaneRequestAuthSecret(env));
  if (requestAuthSecret) {
    return requestAuthSecret;
  }
  return normalizeText(env.CODE_WEB_CHAT_RUN_TOKEN);
}

function resolveWebChatRunToken(env = process.env) {
  return normalizeText(env.CODE_WEB_CHAT_RUN_TOKEN);
}

function normalizeRunExecutionBackend(value) {
  const normalized = normalizeText(value).toLowerCase();
  return RUN_EXECUTION_BACKEND_VALUES.has(normalized) ? normalized : "";
}

function buildCodexRunMetadata({ model = "", mode = "", extra = {} }) {
  const normalizedModel = normalizeText(model);
  const normalizedMode = normalizeText(mode);
  return {
    ...(normalizedModel ? { model: normalizedModel } : {}),
    reasoning_effort: DEFAULT_CODEX_REASONING_EFFORT,
    ...(normalizedMode ? { codex_session_mode: normalizedMode } : {}),
    ...extra,
  };
}

function normalizeRepository(value) {
  const normalized = normalizeText(value);
  if (!normalized || !REPOSITORY_PATTERN.test(normalized)) {
    return "";
  }
  return normalized;
}

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeBaseUrl(value) {
  const normalized = normalizeText(value).replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }
  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }
  return `https://${normalized}`;
}

function normalizeCodePublicBaseUrl(value) {
  const normalized = normalizeText(value).replace(/\/+$/, "");
  if (!normalized) {
    return DEFAULT_CODE_PUBLIC_URL;
  }
  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }
  return `https://${normalized}`;
}

function normalizeChatGptAccountId(value) {
  const normalized = normalizeText(value);
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9._:@=-]{0,254}$/.test(normalized)) {
    return "";
  }
  return normalized;
}

function normalizeThreadId(value) {
  const normalized = normalizeText(value);
  if (!normalized || !WEB_CHAT_THREAD_ID_PATTERN.test(normalized)) {
    return "";
  }
  return normalized;
}

function normalizeRunId(value) {
  const normalized = normalizeText(value);
  if (!normalized || !WEB_CHAT_RUN_ID_PATTERN.test(normalized)) {
    return "";
  }
  return normalized;
}

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function truncate(value, maxChars = 4000) {
  const text = String(value || "");
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
}

function quoteShellArgument(value) {
  return `'${String(value ?? "").replace(/'/g, `'\"'\"'`)}'`;
}

function isCodexTransportNoiseLine(line = "", { afterTokensUsed = false } = {}) {
  const normalized = normalizeText(line);
  if (!normalized) {
    return false;
  }
  if (afterTokensUsed && /^[\d,]+$/.test(normalized)) {
    return true;
  }
  return [
    /^ERROR:\s*stream disconnected before completion:/i,
    /^You can retry your request, or contact us through our help center at help\.openai\.com/i,
    /^Warning:\s*no last agent message;/i,
    /^tokens used$/i,
    /request ID .* in your message\.?\)?$/i,
    /an error occurred while processing your request/i,
  ].some((pattern) => pattern.test(normalized));
}

function stripLeadingCodexTransportNoise(value = "") {
  const lines = String(value || "").split(/\r?\n/);
  let index = 0;
  let removedNoise = false;
  let afterTokensUsed = false;
  while (index < lines.length) {
    const normalizedLine = normalizeText(lines[index]);
    if (!normalizedLine) {
      if (removedNoise || index === 0) {
        index += 1;
        continue;
      }
      break;
    }
    if (isCodexTransportNoiseLine(normalizedLine, { afterTokensUsed })) {
      afterTokensUsed = /^tokens used$/i.test(normalizedLine);
      removedNoise = true;
      index += 1;
      continue;
    }
    break;
  }
  return normalizeText(lines.slice(index).join("\n"));
}

function isRecoverableCodexTransportFailure({ reason = "", output = "" } = {}) {
  const haystack = normalizeText(`${reason}\n${output}`);
  if (!haystack) {
    return false;
  }
  return [
    /stream disconnected before completion/i,
    /no last agent message/i,
    /request ID .* in your message/i,
    /help\.openai\.com/i,
    /an error occurred while processing your request/i,
  ].some((pattern) => pattern.test(haystack));
}

function shouldTreatCodexFailureAsCompleted({
  execution = null,
  assistantMessage = "",
  persistenceResult = null,
  persistenceSummary = "",
} = {}) {
  if (!execution || execution.ok) {
    return false;
  }
  if (
    !isRecoverableCodexTransportFailure({
      reason: execution.reason,
      output: execution.diagnosticOutput || execution.output,
    })
  ) {
    return false;
  }
  if (normalizeText(stripLeadingCodexTransportNoise(assistantMessage))) {
    return true;
  }
  if (normalizeText(persistenceSummary)) {
    return true;
  }
  return Boolean(
    persistenceResult &&
      (persistenceResult.pushed ||
        parsePositiveInteger(persistenceResult.pullRequestNumber, 0) > 0 ||
        normalizeText(persistenceResult.pullRequestUrl)),
  );
}

function toUserVisibleRunnerFailureMessage(value) {
  const message = extractErrorMessage(value);
  if (!message) {
    return "I couldn't complete that run.";
  }
  if (/chatgpt account/i.test(message)) {
    return "I couldn't load the assigned ChatGPT account for this run. Reconnect that account or add another one, then retry.";
  }
  if (
    /failed to refresh token/i.test(message) ||
    /refresh_token_reused/i.test(message) ||
    /access token could not be refreshed/i.test(message) ||
    /please try signing in again/i.test(message)
  ) {
    return "The assigned ChatGPT account needs to be reconnected. Reconnect that account or add another one, then retry.";
  }
  if (/protected branch/i.test(message)) {
    return "I stopped before persisting changes because the work was still on a protected branch.";
  }
  if (/unable to push branch/i.test(message)) {
    return "I finished the work locally, but I couldn't push the branch.";
  }
  if (/unable to checkout working branch/i.test(message)) {
    return "I couldn't restore the working branch for this thread on the runner.";
  }
  if (/session persistence failed/i.test(message)) {
    return "I couldn't save the conversation state after the run, so I marked this run failed.";
  }
  if (/web chat runner failed/i.test(message)) {
    return "I couldn't complete that run.";
  }
  return message;
}

function extractChatGptAccountReauthFailureReason(value) {
  const message = extractErrorMessage(value);
  if (!isChatGptAccountReauthFailure(message)) {
    return "";
  }
  return "The assigned ChatGPT account needs to be reconnected. Reconnect that account or add another one, then retry.";
}

function normalizeBranchName(value) {
  const raw = normalizeText(value).replace(/^refs\/heads\//, "");
  if (!raw || raw.length > 255 || !BRANCH_NAME_PATTERN.test(raw)) {
    return "";
  }
  return raw;
}

function parseBranchList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeBranchName(entry)).filter(Boolean);
  }
  const raw = normalizeText(value);
  if (!raw) {
    return [];
  }
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => normalizeBranchName(entry)).filter(Boolean);
      }
    } catch {
      // fall back to comma-separated parsing
    }
  }
  return raw
    .split(",")
    .map((entry) => normalizeBranchName(entry))
    .filter(Boolean);
}

function normalizeCodexSessionId(value) {
  const normalized = normalizeText(value);
  if (!normalized || !CODEX_SESSION_ID_PATTERN.test(normalized)) {
    return "";
  }
  return normalized;
}

function normalizeCodexSessionRelativePath(value) {
  const normalized = normalizeText(value).replace(/^\/+/, "");
  if (
    !normalized ||
    normalized.includes("..") ||
    !CODEX_SESSION_RELATIVE_PATH_PATTERN.test(normalized)
  ) {
    return "";
  }
  return normalized;
}

function normalizeCodexSessionStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "ready" || normalized === "error") {
    return normalized;
  }
  return "missing";
}

function isRecoverableCodexSessionErrorState(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }
  return (
    /failed to update web chat codex session state/i.test(normalized) ||
    /web chat codex session revision conflict/i.test(normalized) ||
    /codex run finished without creating a session bundle/i.test(normalized) ||
    /web_chat_session_bundles/i.test(normalized) ||
    /unexpected non-whitespace character after JSON at position/i.test(normalized) ||
    /stored codex session bundle is still wrapped in the encrypted storage envelope/i.test(
      normalized,
    ) ||
    /stored codex session bundle is not a valid codex session file/i.test(normalized) ||
    /failed to parse thread ID from rollout file/i.test(normalized)
  );
}

function isInvalidCodexSessionBundleError(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }
  return (
    /stored codex session bundle is still wrapped in the encrypted storage envelope/i.test(
      normalized,
    ) ||
    /stored codex session bundle is not a valid codex session file/i.test(normalized) ||
    /failed to parse thread ID from rollout file/i.test(normalized)
  );
}

function isRecoverableCodexResumeFailure({ reason = "", output = "" } = {}) {
  const normalized = normalizeText(`${reason}\n${output}`);
  if (!normalized) {
    return false;
  }
  return (
    /thread\/resume/i.test(normalized) &&
    /failed to load rollout/i.test(normalized) &&
    /failed to parse thread ID from rollout file/i.test(normalized)
  );
}

function isRetryableCodexSessionPersistenceError(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }
  return (
    /failed to update web chat codex session state/i.test(normalized) ||
    /web chat codex session revision conflict/i.test(normalized) ||
    /codex run finished without creating a session bundle/i.test(normalized) ||
    /timed out/i.test(normalized) ||
    /timeout/i.test(normalized) ||
    /temporary/i.test(normalized) ||
    /upstream/i.test(normalized) ||
    /network/i.test(normalized) ||
    /fetch failed/i.test(normalized)
  );
}

function buildFreshStartCodexSessionState(existingState) {
  const normalized = normalizeCodexSessionState(existingState);
  return normalizeCodexSessionState({
    ...normalized,
    status: "missing",
    session_id: "",
    session_file_relative_path: "",
    bundle_storage_key: "",
    storage_bucket: "",
    storage_backend: "",
    bundle_size_bytes: 0,
    bundle_compressed_size_bytes: 0,
    target_signature: "",
    cli_version: "",
    model: "",
    last_run_id: "",
    last_uploaded_at: 0,
    last_resumed_at: 0,
    last_error: "",
  });
}

function normalizeAttachmentName(value) {
  const normalized = String(value || "")
    .replace(/[\\/]+/g, "-")
    .replace(/[\u0000-\u001f]/g, "")
    .trim();
  return (normalized || "attachment").slice(0, 255);
}

function normalizeAttachmentContentType(value) {
  return String(value || "application/octet-stream")
    .trim()
    .toLowerCase()
    .slice(0, 120);
}

function normalizeAttachmentRecord(value) {
  const normalized = normalizeObject(value);
  const attachmentId = normalizeText(
    normalized.attachment_id || normalized.attachmentId || normalized.id || "",
  );
  const name = normalizeAttachmentName(
    normalized.name || normalized.file_name || normalized.fileName || "",
  );
  if (!attachmentId || !name) {
    return null;
  }
  return {
    attachment_id: attachmentId,
    name,
    content_type: normalizeAttachmentContentType(
      normalized.content_type || normalized.contentType || "",
    ),
    size_bytes: parsePositiveInteger(
      normalized.size_bytes || normalized.sizeBytes || 0,
      0,
    ),
  };
}

function parseAttachmentList(value) {
  const candidates =
    typeof value === "string"
      ? (() => {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : Array.isArray(value)
        ? value
        : [];
  return candidates
    .map((entry) => normalizeAttachmentRecord(entry))
    .filter(Boolean);
}

function normalizePromptAttachmentRecord(value) {
  const normalized = normalizeObject(value);
  const name = normalizeAttachmentName(
    normalized.name || normalized.file_name || normalized.fileName || "",
  );
  if (!name) {
    return null;
  }
  return { name };
}

function parsePromptAttachmentList(value) {
  const candidates =
    typeof value === "string"
      ? (() => {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : Array.isArray(value)
        ? value
        : [];
  return candidates
    .map((entry) => normalizePromptAttachmentRecord(entry))
    .filter(Boolean);
}

function normalizeReferencedThreadMessageRecord(value) {
  const normalized = normalizeObject(value);
  const messageId = normalizeText(normalized.message_id || normalized.messageId || "");
  const role = normalizeText(normalized.role).toLowerCase();
  const content = truncate(normalizeText(normalized.content), MAX_MESSAGE_CHARS);
  const attachments = parsePromptAttachmentList(
    normalized.attachments || normalizeObject(normalized.metadata).attachments || [],
  );
  if ((!content && attachments.length === 0) || (role !== "user" && role !== "assistant")) {
    return null;
  }
  return {
    message_id: messageId,
    role,
    content,
    attachments,
    created_at: parseTimestampMs(normalized.created_at || normalized.createdAt),
  };
}

function normalizeReferencedThreadRecord(value) {
  const normalized = normalizeObject(value);
  const threadId = normalizeThreadId(normalized.thread_id || normalized.threadId || "");
  const repository = normalizeRepository(
    normalized.workspace_repository || normalized.workspaceRepository || normalized.repository,
  );
  if (!threadId || !repository) {
    return null;
  }
  return {
    thread_id: threadId,
    workspace_repository: repository,
    title: normalizeText(normalized.title || ""),
    source_type: normalizeText(normalized.source_type || normalized.sourceType || ""),
    branch_context: normalizeThreadBranchContext(
      normalized.branch_context || normalized.branchContext || {},
    ),
    messages: (
      Array.isArray(normalized.messages) ? normalized.messages : []
    )
      .map((entry) => normalizeReferencedThreadMessageRecord(entry))
      .filter(Boolean)
      .sort((left, right) => {
        const leftCreatedAt = parseTimestampMs(left.created_at);
        const rightCreatedAt = parseTimestampMs(right.created_at);
        if (leftCreatedAt !== rightCreatedAt) {
          return leftCreatedAt - rightCreatedAt;
        }
        return normalizeText(left.message_id).localeCompare(normalizeText(right.message_id));
      })
      .slice(-MAX_REFERENCED_THREAD_MESSAGES),
  };
}

function parseReferencedThreadList(value) {
  const candidates =
    typeof value === "string"
      ? (() => {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : Array.isArray(value)
        ? value
        : [];
  return candidates
    .map((entry) => normalizeReferencedThreadRecord(entry))
    .filter(Boolean);
}

function parseTimestampMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric);
  }
  const parsed = Date.parse(String(value || "").trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function normalizeCodexSessionState(value) {
  const normalized = normalizeObject(value);
  return {
    status: normalizeCodexSessionStatus(normalized.status),
    session_id: normalizeCodexSessionId(normalized.session_id || normalized.sessionId),
    session_file_relative_path: normalizeCodexSessionRelativePath(
      normalized.session_file_relative_path || normalized.sessionFileRelativePath,
    ),
    bundle_storage_key: normalizeText(
      normalized.bundle_storage_key || normalized.bundleStorageKey,
    ),
    bundle_revision: parsePositiveInteger(
      normalized.bundle_revision || normalized.bundleRevision,
      0,
    ),
    storage_bucket: normalizeText(
      normalized.storage_bucket || normalized.storageBucket,
    ),
    storage_backend: normalizeText(
      normalized.storage_backend || normalized.storageBackend,
    ).toLowerCase(),
    bundle_size_bytes: parsePositiveInteger(
      normalized.bundle_size_bytes || normalized.bundleSizeBytes,
      0,
    ),
    bundle_compressed_size_bytes: parsePositiveInteger(
      normalized.bundle_compressed_size_bytes || normalized.bundleCompressedSizeBytes,
      0,
    ),
    target_signature: normalizeText(
      normalized.target_signature || normalized.targetSignature,
    ),
    cli_version: normalizeText(normalized.cli_version || normalized.cliVersion),
    model: normalizeText(normalized.model),
    last_run_id: normalizeText(normalized.last_run_id || normalized.lastRunId),
    last_uploaded_at: parsePositiveInteger(
      normalized.last_uploaded_at || normalized.lastUploadedAt,
      0,
    ),
    last_resumed_at: parsePositiveInteger(
      normalized.last_resumed_at || normalized.lastResumedAt,
      0,
    ),
    last_compaction_observed_at: parsePositiveInteger(
      normalized.last_compaction_observed_at || normalized.lastCompactionObservedAt,
      0,
    ),
    last_error: normalizeText(normalized.last_error || normalized.lastError),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function log(message, details = "") {
  const suffix = normalizeText(details);
  const line = `[web-chat-runner ${nowIso()}] ${message}${suffix ? ` | ${suffix}` : ""}`;
  console.log(line);
}

function sleep(ms) {
  const normalizedMs = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, normalizedMs));
}

async function pathExists(targetPath) {
  const normalizedPath = normalizeText(targetPath);
  if (!normalizedPath) {
    return false;
  }
  try {
    await fs.access(normalizedPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(targetPath) {
  const normalizedPath = normalizeText(targetPath);
  if (!normalizedPath) {
    return false;
  }
  try {
    const stat = await fs.stat(normalizedPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function isExecutableFile(targetPath) {
  const normalizedPath = normalizeText(targetPath);
  if (!normalizedPath) {
    return false;
  }
  try {
    await fs.access(normalizedPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isFile(targetPath) {
  const normalizedPath = normalizeText(targetPath);
  if (!normalizedPath) {
    return false;
  }
  try {
    const stat = await fs.stat(normalizedPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function ensureDirectory(targetPath) {
  const normalizedPath = normalizeText(targetPath);
  if (!normalizedPath) {
    throw new Error("Directory path is required.");
  }
  await fs.mkdir(normalizedPath, { recursive: true });
}

async function runProcessCapture(command, args, { cwd, env, stdinText = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    if (stdinText) {
      child.stdin?.write(String(stdinText));
    }
    child.stdin?.end();
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        ok: code === 0,
        code: Number.isFinite(code) ? Number(code) : -1,
        signal: signal || "",
        stdout,
        stderr,
      });
    });
  });
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });

  let payload = {};
  let textBody = "";
  try {
    payload = await response.json();
  } catch {
    try {
      textBody = await response.text();
    } catch {
      textBody = "";
    }
    payload = {};
  }

  return {
    ok: response.ok,
    status: response.status,
    payload: normalizeObject(payload),
    textBody,
  };
}

function encodeRepositoryPath(repository) {
  return normalizeText(repository)
    .split("/")
    .map((entry) => encodeURIComponent(entry))
    .join("/");
}

async function workerJsonRequest({ workerUrl, adminToken, path, method, query, body }) {
  const normalizedWorkerUrl = normalizeBaseUrl(workerUrl);
  const normalizedToken = normalizeText(adminToken);
  if (!normalizedToken) {
    throw new Error(
      "CODE_WEB_CHAT_RUN_TOKEN or CODE_GITHUB_SESSION_SECRET or GH_OAUTH_STATE_SECRET is required.",
    );
  }
  const url = new URL(path, normalizedWorkerUrl);
  if (query) {
    url.search = query.toString();
  }
  const authorizationHeader =
    normalizedToken.split(".").length === 3
      ? `Bearer ${normalizedToken}`
      : await buildControlPlaneRequestAuthorizationHeader(
          { method, path },
          { CODE_GITHUB_SESSION_SECRET: normalizedToken },
        );

  return fetchJson(url.toString(), {
    method,
    headers: {
      Authorization: authorizationHeader,
      ...(method === "POST" ? { "Content-Type": "application/json; charset=utf-8" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(body || {}) } : {}),
  });
}

async function requestWorkspaceGitToken({
  publicBaseUrl,
  adminToken,
  webChatRunToken,
  workspaceRepository,
  retries = 3,
  retryDelayMs = 750,
}) {
  const normalizedPublicBaseUrl = normalizeCodePublicBaseUrl(publicBaseUrl);
  const normalizedToken = normalizeText(webChatRunToken);
  const normalizedFallbackToken = normalizeText(adminToken);
  const normalizedWorkspaceRepository = normalizeRepository(workspaceRepository);
  const authorizationToken =
    normalizedToken ||
    (normalizedFallbackToken.split(".").length === 3 ? normalizedFallbackToken : "");
  if (!authorizationToken || authorizationToken.split(".").length !== 3) {
    throw new Error(
      "A scoped CODE_WEB_CHAT_RUN_TOKEN is required to mint a GitHub write token for repository writes.",
    );
  }
  if (!normalizedWorkspaceRepository) {
    throw new Error("workspaceRepository is required.");
  }

  const endpoint = new URL("/api/github/workspace-git-token", normalizedPublicBaseUrl);
  const authorizationHeader = `Bearer ${authorizationToken}`;

  let lastError = null;
  const attempts = Math.max(1, parsePositiveInteger(retries, 3) || 3);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchJson(endpoint.toString(), {
      method: "POST",
      headers: {
        Authorization: authorizationHeader,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        workspace_repository: normalizedWorkspaceRepository,
      }),
    });

    const token = normalizeText(response.payload?.token);
    const tokenSource = normalizeText(response.payload?.token_source);
    if (response.ok && response.payload?.ok !== false && token) {
      return {
        token,
        tokenSource,
        gitAuthorName: normalizeText(
          response.payload?.git_author_name || response.payload?.gitAuthorName,
        ),
        gitAuthorEmail: normalizeText(
          response.payload?.git_author_email || response.payload?.gitAuthorEmail,
        ),
        gitCommitterName: normalizeText(
          response.payload?.git_committer_name || response.payload?.gitCommitterName,
        ),
        gitCommitterEmail: normalizeText(
          response.payload?.git_committer_email || response.payload?.gitCommitterEmail,
        ),
      };
    }

    const errorMessage =
      normalizeText(
        response.payload?.error || response.textBody,
      ) || `Unable to load workspace git token (${response.status}).`;
    lastError = new Error(errorMessage);
    const shouldRetry =
      (response.status === 429 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504) &&
      attempt < attempts;
    if (!shouldRetry) {
      break;
    }
    log(
      "Workspace GitHub write token request failed transiently; retrying",
      `repository=${normalizedWorkspaceRepository} attempt=${attempt}/${attempts}`,
    );
    await sleep(retryDelayMs);
  }

  throw lastError || new Error("Unable to load workspace GitHub write token.");
}

async function applyWorkspaceGitToken({
  publicBaseUrl,
  adminToken,
  workspaceRepository,
  commandEnv,
}) {
  const gitToken = await requestWorkspaceGitToken({
    publicBaseUrl,
    adminToken,
    webChatRunToken: resolveWebChatRunToken(commandEnv),
    workspaceRepository,
  });
  commandEnv.CODEX_GITHUB_WRITE_TOKEN = gitToken.token;
  commandEnv.CODEX_GITHUB_WRITE_TOKEN_SOURCE = gitToken.tokenSource;
  if (gitToken.gitAuthorName) {
    commandEnv.CODEX_GIT_AUTHOR_NAME = gitToken.gitAuthorName;
  }
  if (gitToken.gitAuthorEmail) {
    commandEnv.CODEX_GIT_AUTHOR_EMAIL = gitToken.gitAuthorEmail;
  }
  if (gitToken.gitCommitterName) {
    commandEnv.CODEX_GIT_COMMITTER_NAME = gitToken.gitCommitterName;
  }
  if (gitToken.gitCommitterEmail) {
    commandEnv.CODEX_GIT_COMMITTER_EMAIL = gitToken.gitCommitterEmail;
  }
  return gitToken;
}

function resolveWebChatGitHubWriteToken(commandEnv) {
  return normalizeText(commandEnv?.CODEX_GITHUB_WRITE_TOKEN);
}

function requireWebChatGitHubWriteToken(
  commandEnv,
  operation = "GitHub repository writes",
) {
  const githubToken = resolveWebChatGitHubWriteToken(commandEnv);
  if (!githubToken) {
    throw new Error(
      `${operation} require a GitHub write token. Codeq8 could not mint a repository installation token for this run.`,
    );
  }
  return githubToken;
}

function buildWorkspaceGitTokenHelperScript({
  publicBaseUrl,
  workspaceRepository,
}) {
  const normalizedPublicBaseUrl = normalizeCodePublicBaseUrl(publicBaseUrl);
  const normalizedWorkspaceRepository = normalizeRepository(workspaceRepository);
  return [
    "#!/usr/bin/env node",
    `const endpointBaseUrl = ${JSON.stringify(normalizedPublicBaseUrl)};`,
    `const workspaceRepository = ${JSON.stringify(normalizedWorkspaceRepository)};`,
    'function normalizeText(value) { return String(value || "").trim(); }',
    "function normalizeObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }",
    "async function readStdin() {",
    "  const chunks = [];",
    "  for await (const chunk of process.stdin) { chunks.push(String(chunk || '')); }",
    "  return chunks.join('');",
    "}",
    "function parseCredentialRequest(raw) {",
    "  const result = {};",
    "  for (const line of String(raw || '').split(/\\r?\\n/g)) {",
    "    const separatorIndex = line.indexOf('=');",
    "    if (separatorIndex <= 0) { continue; }",
    "    const key = normalizeText(line.slice(0, separatorIndex));",
    "    const value = normalizeText(line.slice(separatorIndex + 1));",
    "    if (key) { result[key] = value; }",
    "  }",
    "  return result;",
    "}",
    "async function fetchGitHubWriteToken() {",
    "  const authorizationToken = normalizeText(process.env.CODE_WEB_CHAT_RUN_TOKEN || '');",
    "  if (!authorizationToken) {",
    "    throw new Error('CODE_WEB_CHAT_RUN_TOKEN is required to mint a GitHub write token.');",
    "  }",
    "  const response = await fetch(new URL('/api/github/workspace-git-token', endpointBaseUrl), {",
    "    method: 'POST',",
    "    headers: {",
    "      Authorization: `Bearer ${authorizationToken}`,",
    "      'Content-Type': 'application/json; charset=utf-8',",
    "    },",
    "    body: JSON.stringify({ workspace_repository: workspaceRepository }),",
    "    cache: 'no-store',",
    "  });",
    "  let payload = {};",
    "  try { payload = normalizeObject(await response.json()); } catch { payload = {}; }",
    "  const token = normalizeText(payload.token);",
    "  if (!response.ok || payload.ok === false || !token) {",
    "    throw new Error(normalizeText(payload.error || payload.message) || `Unable to load workspace git token (${response.status}).`);",
    "  }",
    "  process.env.CODEX_GITHUB_WRITE_TOKEN = token;",
    "  return token;",
    "}",
    "async function main() {",
    "  const operation = normalizeText(process.argv[2] || '').toLowerCase();",
    "  if (operation === 'print-token') {",
    "    process.stdout.write(await fetchGitHubWriteToken());",
    "    return;",
    "  }",
    "  if (operation !== 'get') {",
    "    return;",
    "  }",
    "  const request = parseCredentialRequest(await readStdin());",
    "  const host = normalizeText(request.host || '').toLowerCase();",
    "  if (host && host !== 'github.com') {",
    "    return;",
    "  }",
    "  const token = await fetchGitHubWriteToken();",
    "  process.stdout.write(`username=x-access-token\\npassword=${token}\\n\\n`);",
    "}",
    "main().catch((error) => {",
    "  const message = error instanceof Error ? error.message : String(error);",
    "  if (message) { console.error(message); }",
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
}

async function configureWorkspaceGitCredentialHelper({
  workspacePath,
  commandEnv,
  publicBaseUrl,
  workspaceRepository,
}) {
  const helperPath = path.join(
    path.resolve(workspacePath),
    ".git",
    "codeq8-github-token-helper.mjs",
  );
  await fs.writeFile(
    helperPath,
    buildWorkspaceGitTokenHelperScript({
      publicBaseUrl,
      workspaceRepository,
    }),
    {
      encoding: "utf8",
      mode: 0o755,
    },
  );
  await fs.chmod(helperPath, 0o755);

  const configuredHelper = await runProcessCapture(
    "git",
    ["config", "--local", "credential.helper", helperPath],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );
  if (!configuredHelper.ok) {
    throw new Error("Unable to configure workspace git credential helper.");
  }

  const configuredUseHttpPath = await runProcessCapture(
    "git",
    ["config", "--local", "credential.useHttpPath", "true"],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );
  if (!configuredUseHttpPath.ok) {
    throw new Error("Unable to configure workspace git credential helper path matching.");
  }

  commandEnv.CODEX_GITHUB_TOKEN_HELPER_PATH = helperPath;
  return helperPath;
}


function buildGitHubActionsControlPlaneUrl(env = process.env) {
  const serverUrl = normalizeBaseUrl(env.GITHUB_SERVER_URL || "");
  const repository = normalizeRepository(env.GITHUB_REPOSITORY || "");
  const runId = normalizeText(env.GITHUB_RUN_ID || "");
  if (!serverUrl || !repository || !runId) {
    return "";
  }
  return `${serverUrl}/${encodeRepositoryPath(repository)}/actions/runs/${encodeURIComponent(runId)}`;
}

function resolveRunControlPlaneContext(env = process.env) {
  const explicitExecutionBackend = normalizeRunExecutionBackend(
    env.CODEQ8_EXECUTION_BACKEND || env.CODE_CHAT_EXECUTION_BACKEND || "",
  );
  const executionBackend =
    explicitExecutionBackend ||
    (normalizeText(env.GITHUB_ACTIONS || "").toLowerCase() === "true"
      ? "github_actions"
      : "");
  const controlPlaneRunId =
    normalizeText(env.CODEQ8_CONTROL_PLANE_RUN_ID || "") ||
    (executionBackend === "github_actions"
      ? normalizeText(env.GITHUB_RUN_ID || "")
      : "");
  const controlPlaneUrl =
    normalizeText(env.CODEQ8_CONTROL_PLANE_URL || "") ||
    (executionBackend === "github_actions"
      ? buildGitHubActionsControlPlaneUrl(env)
      : "");
  return {
    execution_backend: executionBackend,
    control_plane_repository:
      normalizeRepository(env.CODEQ8_CONTROL_PLANE_REPOSITORY || "") ||
      (executionBackend === "github_actions"
        ? normalizeRepository(env.GITHUB_REPOSITORY || "")
        : ""),
    control_plane_run_id: controlPlaneRunId,
    control_plane_run_attempt: parsePositiveInteger(
      env.CODEQ8_CONTROL_PLANE_RUN_ATTEMPT || env.GITHUB_RUN_ATTEMPT || "",
      0,
    ),
    control_plane_workflow_name:
      normalizeText(env.CODEQ8_CONTROL_PLANE_WORKFLOW_NAME || "") ||
      (executionBackend === "github_actions" ? normalizeText(env.GITHUB_WORKFLOW || "") : ""),
    control_plane_job_id:
      normalizeText(env.CODEQ8_CONTROL_PLANE_JOB_ID || "") ||
      (executionBackend === "github_actions"
        ? normalizeText(env.GITHUB_JOB || "")
        : ""),
    control_plane_url: controlPlaneUrl,
  };
}

function applyRunControlPlaneContextToCallbackBody(body, env = process.env) {
  const normalizedBody = normalizeObject(body);
  const controlPlaneContext = resolveRunControlPlaneContext(env);
  return {
    ...normalizedBody,
    execution_backend:
      normalizeRunExecutionBackend(
        normalizedBody.execution_backend || normalizedBody.executionBackend || "",
      ) || controlPlaneContext.execution_backend,
    control_plane_repository:
      normalizeRepository(
        normalizedBody.control_plane_repository || normalizedBody.controlPlaneRepository || "",
      ) || controlPlaneContext.control_plane_repository,
    control_plane_run_id:
      normalizeText(
        normalizedBody.control_plane_run_id || normalizedBody.controlPlaneRunId || "",
      ) || controlPlaneContext.control_plane_run_id,
    control_plane_run_attempt:
      parsePositiveInteger(
        normalizedBody.control_plane_run_attempt || normalizedBody.controlPlaneRunAttempt || "",
        0,
      ) || controlPlaneContext.control_plane_run_attempt,
    control_plane_workflow_name:
      normalizeText(
        normalizedBody.control_plane_workflow_name ||
          normalizedBody.controlPlaneWorkflowName ||
          "",
      ) || controlPlaneContext.control_plane_workflow_name,
    control_plane_job_id:
      normalizeText(
        normalizedBody.control_plane_job_id || normalizedBody.controlPlaneJobId || "",
      ) || controlPlaneContext.control_plane_job_id,
    control_plane_url:
      normalizeText(
        normalizedBody.control_plane_url || normalizedBody.controlPlaneUrl || "",
      ) || controlPlaneContext.control_plane_url,
  };
}

async function postRunCallback({ publicBaseUrl, workerUrl, adminToken, body }) {
  const normalizedToken = normalizeText(adminToken);
  if (!normalizedToken) {
    throw new Error(
      "CODE_WEB_CHAT_RUN_TOKEN or CODE_GITHUB_SESSION_SECRET or GH_OAUTH_STATE_SECRET is required.",
    );
  }
  const callbackBody = {
    ...applyRunControlPlaneContextToCallbackBody(body),
    worker_url: normalizeBaseUrl(workerUrl),
  };
  const endpoint = new URL("/api/chat/runs/callback", normalizeCodePublicBaseUrl(publicBaseUrl));
  const authorizationHeader =
    normalizedToken.split(".").length === 3
      ? `Bearer ${normalizedToken}`
      : await buildControlPlaneRequestAuthorizationHeader(
          {
            method: "POST",
            path: endpoint.pathname,
          },
          { CODE_GITHUB_SESSION_SECRET: normalizedToken },
        );
  const response = await fetchJson(endpoint.toString(), {
    method: "POST",
    headers: {
      Authorization: authorizationHeader,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(callbackBody),
  });
  if (!response.ok || response.payload.ok === false) {
    throw new Error(
      extractErrorMessage(response.payload.error) ||
        `Failed to post web chat run callback (${response.status}).`,
    );
  }
  return response.payload;
}

function resolveWorkspacePath({ repository, overridePath }) {
  const normalizedOverride = normalizeText(overridePath);
  if (normalizedOverride) {
    return path.resolve(normalizedOverride);
  }
  const [, repo] = normalizeText(repository).split("/", 2);
  if (!repo) {
    return "";
  }
  return path.resolve(process.cwd(), "..", repo);
}

async function resolveGitIdentityFromGitHubUserToken({
  githubUserToken,
  fetchImpl = fetch,
}) {
  const normalizedToken = normalizeText(githubUserToken);
  if (!normalizedToken) {
    return null;
  }

  let response;
  try {
    response = await fetchImpl("https://api.github.com/user", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${normalizedToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "codeq8-web-chat-runner",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    });
  } catch {
    return null;
  }

  let payload = {};
  try {
    payload = normalizeObject(await response.json());
  } catch {
    payload = {};
  }

  if (!response.ok) {
    return null;
  }

  const login = normalizeText(payload.login);
  if (!login) {
    return null;
  }

  const displayName = normalizeText(payload.name) || login;
  const userId = parsePositiveInteger(payload.id, 0);
  const noreplyEmail = userId
    ? `${userId}+${login}@users.noreply.github.com`
    : `${login}@users.noreply.github.com`;

  return {
    authorName: displayName,
    authorEmail: noreplyEmail,
    committerName: displayName,
    committerEmail: noreplyEmail,
  };
}

function resolveGitIdentity(commandEnv, githubLogin) {
  const fallbackName = normalizeText(githubLogin) || "codeq8";
  const fallbackEmail = `${fallbackName}@users.noreply.github.com`;

  return {
    authorName:
      normalizeText(commandEnv.CODEX_GIT_AUTHOR_NAME) ||
      normalizeText(commandEnv.GIT_AUTHOR_NAME) ||
      fallbackName,
    authorEmail:
      normalizeText(commandEnv.CODEX_GIT_AUTHOR_EMAIL) ||
      normalizeText(commandEnv.GIT_AUTHOR_EMAIL) ||
      fallbackEmail,
    committerName:
      normalizeText(commandEnv.CODEX_GIT_COMMITTER_NAME) ||
      normalizeText(commandEnv.GIT_COMMITTER_NAME) ||
      normalizeText(commandEnv.CODEX_GIT_AUTHOR_NAME) ||
      normalizeText(commandEnv.GIT_AUTHOR_NAME) ||
      fallbackName,
    committerEmail:
      normalizeText(commandEnv.CODEX_GIT_COMMITTER_EMAIL) ||
      normalizeText(commandEnv.GIT_COMMITTER_EMAIL) ||
      normalizeText(commandEnv.CODEX_GIT_AUTHOR_EMAIL) ||
      normalizeText(commandEnv.GIT_AUTHOR_EMAIL) ||
      fallbackEmail,
  };
}

async function resolvePreferredGitIdentity({
  commandEnv,
  githubLogin,
  fetchImpl = fetch,
}) {
  const githubUserIdentity = await resolveGitIdentityFromGitHubUserToken({
    githubUserToken: commandEnv.CODEX_USER_GH_TOKEN,
    fetchImpl,
  });
  if (githubUserIdentity) {
    commandEnv.CODEX_GIT_AUTHOR_NAME = githubUserIdentity.authorName;
    commandEnv.CODEX_GIT_AUTHOR_EMAIL = githubUserIdentity.authorEmail;
    commandEnv.CODEX_GIT_COMMITTER_NAME = githubUserIdentity.committerName;
    commandEnv.CODEX_GIT_COMMITTER_EMAIL = githubUserIdentity.committerEmail;
  }
  return resolveGitIdentity(commandEnv, githubLogin);
}

async function applyWorkspaceGitIdentity({
  workspacePath,
  commandEnv,
  githubLogin,
  fetchImpl = fetch,
}) {
  const identity = await resolvePreferredGitIdentity({
    commandEnv,
    githubLogin,
    fetchImpl,
  });
  commandEnv.GIT_AUTHOR_NAME = identity.authorName;
  commandEnv.GIT_AUTHOR_EMAIL = identity.authorEmail;
  commandEnv.GIT_COMMITTER_NAME = identity.committerName;
  commandEnv.GIT_COMMITTER_EMAIL = identity.committerEmail;

  const assignments = [
    ["user.name", identity.authorName],
    ["user.email", identity.authorEmail],
  ];
  for (const [key, value] of assignments) {
    const configured = await runProcessCapture("git", ["config", "--local", key, value], {
      cwd: workspacePath,
      env: commandEnv,
    });
    if (!configured.ok) {
      throw new Error(`Unable to configure git ${key} for workspace.`);
    }
  }
}

function buildGithubCloneUrl(repository, token) {
  const normalizedRepository = normalizeText(repository);
  if (!normalizedRepository) {
    return "";
  }
  const normalizedToken = normalizeText(token);
  if (!normalizedToken) {
    return `https://github.com/${normalizedRepository}.git`;
  }
  const encodedToken = encodeURIComponent(normalizedToken);
  return `https://x-access-token:${encodedToken}@github.com/${normalizedRepository}.git`;
}

async function resolveOriginDefaultBranch({ workspacePath, commandEnv }) {
  const symbolicRef = await runProcessCapture(
    "git",
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );
  if (symbolicRef.ok) {
    const branch = normalizeText(symbolicRef.stdout).replace(/^origin\//, "");
    if (branch) {
      return branch;
    }
  }

  const remoteShow = await runProcessCapture("git", ["remote", "show", "origin"], {
    cwd: workspacePath,
    env: commandEnv,
  });
  if (remoteShow.ok) {
    const lines = String(remoteShow.stdout || "").split(/\r?\n/g);
    for (const line of lines) {
      const match = /HEAD branch:\s*(.+)$/i.exec(line);
      if (!match) {
        continue;
      }
      const branch = normalizeText(match[1]);
      if (branch) {
        return branch;
      }
    }
  }

  return "";
}

async function remoteBranchExists({ workspacePath, commandEnv, branch }) {
  const normalizedBranch = normalizeBranchName(branch);
  if (!normalizedBranch) {
    return false;
  }

  await runProcessCapture(
    "git",
    [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${normalizedBranch}:refs/remotes/origin/${normalizedBranch}`,
    ],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );

  const remoteBranch = await runProcessCapture(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${normalizedBranch}`],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );
  return remoteBranch.ok;
}

async function readBranchDivergenceCounts({ workspacePath, commandEnv, branch }) {
  const normalizedBranch = normalizeBranchName(branch);
  if (!normalizedBranch) {
    return { behind: 0, ahead: 0 };
  }

  const result = await runProcessCapture(
    "git",
    [
      "rev-list",
      "--left-right",
      "--count",
      `origin/${normalizedBranch}...refs/heads/${normalizedBranch}`,
    ],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );
  if (!result.ok) {
    return { behind: 0, ahead: 0 };
  }

  const [behindText, aheadText] = normalizeText(result.stdout).split(/\s+/, 2);
  return {
    behind: parsePositiveInteger(behindText, 0),
    ahead: parsePositiveInteger(aheadText, 0),
  };
}

async function readHeadCommitSha({ workspacePath, commandEnv }) {
  const result = await runProcessCapture("git", ["rev-parse", "HEAD"], {
    cwd: workspacePath,
    env: commandEnv,
  });
  if (!result.ok) {
    return "";
  }
  return normalizeText(result.stdout);
}

async function readWorkspacePersistenceState({
  workspacePath,
  commandEnv,
  branch,
}) {
  const normalizedBranch = normalizeBranchName(branch);
  const hasWorkingTreeChanges = await workingTreeHasChanges({
    workspacePath,
    commandEnv,
  }).catch(() => false);
  const hasRemoteBranch = normalizedBranch
    ? await remoteBranchExists({
        workspacePath,
        commandEnv,
        branch: normalizedBranch,
      }).catch(() => false)
    : false;
  const aheadCount =
    normalizedBranch && hasRemoteBranch
      ? await branchAheadCount({
          workspacePath,
          commandEnv,
          branch: normalizedBranch,
        }).catch(() => 0)
      : 0;
  const headCommitSha = await readHeadCommitSha({
    workspacePath,
    commandEnv,
  }).catch(() => "");
  const statusFingerprint = await runProcessCapture("git", ["status", "--porcelain"], {
    cwd: workspacePath,
    env: commandEnv,
  })
    .then((result) => normalizeText(result.stdout))
    .catch(() => "");

  return {
    branch: normalizedBranch,
    hasWorkingTreeChanges,
    hasRemoteBranch,
    aheadCount,
    headCommitSha,
    statusFingerprint,
  };
}

async function checkoutOriginBranch({
  workspacePath,
  commandEnv,
  branch,
}) {
  const normalizedBranch = normalizeBranchName(branch);
  if (!normalizedBranch) {
    return {
      ok: false,
      error: "Working branch name is empty.",
    };
  }
  const exists = await remoteBranchExists({
    workspacePath,
    commandEnv,
    branch: normalizedBranch,
  });
  if (!exists) {
    return {
      ok: false,
      error: `Remote branch origin/${normalizedBranch} does not exist.`,
    };
  }

  await clearGitOperationState({ workspacePath, commandEnv });

  const checkout = await runProcessCapture(
    "git",
    ["checkout", "--force", "-B", normalizedBranch, `origin/${normalizedBranch}`],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );
  if (!checkout.ok) {
    return {
      ok: false,
      error: `Unable to checkout ${normalizedBranch} from origin/${normalizedBranch}: ${summarizeGitProcessFailure(checkout)}`,
    };
  }

  const reset = await runProcessCapture(
    "git",
    ["reset", "--hard", `origin/${normalizedBranch}`],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );
  if (!reset.ok) {
    return {
      ok: false,
      error: `Unable to reset ${normalizedBranch} to origin/${normalizedBranch}: ${summarizeGitProcessFailure(reset)}`,
    };
  }

  const clean = await runProcessCapture("git", ["clean", "-df"], {
    cwd: workspacePath,
    env: commandEnv,
  });
  if (!clean.ok) {
    return {
      ok: false,
      error: `Unable to clean workspace on ${normalizedBranch}: ${summarizeGitProcessFailure(clean)}`,
    };
  }
  return { ok: true, error: "" };
}

async function checkoutPreparedWorkspaceBranch({
  workspacePath,
  commandEnv,
  effectiveWriteBranch,
  originBranch,
}) {
  const normalizedWriteBranch = normalizeBranchName(effectiveWriteBranch);
  const normalizedOriginBranch = normalizeBranchName(originBranch);
  if (!normalizedWriteBranch || !normalizedOriginBranch) {
    return {
      ok: false,
      error: "Working branch or origin base branch is empty.",
    };
  }

  const writeBranchExistsRemotely = await remoteBranchExists({
    workspacePath,
    commandEnv,
    branch: normalizedWriteBranch,
  });
  if (writeBranchExistsRemotely) {
    return checkoutOriginBranch({
      workspacePath,
      commandEnv,
      branch: normalizedWriteBranch,
    });
  }

  if (normalizedWriteBranch === normalizedOriginBranch) {
    return checkoutOriginBranch({
      workspacePath,
      commandEnv,
      branch: normalizedOriginBranch,
    });
  }

  return createBranchFromOrigin({
    workspacePath,
    commandEnv,
    branch: normalizedWriteBranch,
    originBranch: normalizedOriginBranch,
  });
}

async function createBranchFromOrigin({
  workspacePath,
  commandEnv,
  branch,
  originBranch,
}) {
  const normalizedBranch = normalizeBranchName(branch);
  const normalizedOriginBranch = normalizeBranchName(originBranch);
  if (!normalizedBranch || !normalizedOriginBranch) {
    return {
      ok: false,
      error: "Working branch or origin base branch is empty.",
    };
  }

  const exists = await remoteBranchExists({
    workspacePath,
    commandEnv,
    branch: normalizedOriginBranch,
  });
  if (!exists) {
    return {
      ok: false,
      error: `Remote base branch origin/${normalizedOriginBranch} does not exist.`,
    };
  }

  await clearGitOperationState({ workspacePath, commandEnv });

  const checkout = await runProcessCapture(
    "git",
    ["checkout", "--force", "-B", normalizedBranch, `origin/${normalizedOriginBranch}`],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );
  if (!checkout.ok) {
    return {
      ok: false,
      error: `Unable to create ${normalizedBranch} from origin/${normalizedOriginBranch}: ${summarizeGitProcessFailure(checkout)}`,
    };
  }

  const reset = await runProcessCapture(
    "git",
    ["reset", "--hard", `origin/${normalizedOriginBranch}`],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );
  if (!reset.ok) {
    return {
      ok: false,
      error: `Unable to reset ${normalizedBranch} to origin/${normalizedOriginBranch}: ${summarizeGitProcessFailure(reset)}`,
    };
  }

  const clean = await runProcessCapture("git", ["clean", "-df"], {
    cwd: workspacePath,
    env: commandEnv,
  });
  if (!clean.ok) {
    return {
      ok: false,
      error: `Unable to clean workspace on ${normalizedBranch}: ${summarizeGitProcessFailure(clean)}`,
    };
  }
  return { ok: true, error: "" };
}

async function configureWorkspacePushPolicy({
  workspacePath,
  commandEnv,
  remoteUrl,
  blockedBranches = [],
}) {
  const normalizedRemoteUrl = normalizeText(remoteUrl);
  const configured = normalizedRemoteUrl
    ? await runProcessCapture(
        "git",
        ["remote", "set-url", "--push", "origin", normalizedRemoteUrl],
        {
          cwd: workspacePath,
          env: commandEnv,
        },
      )
    : { ok: true };
  if (!configured.ok) {
    throw new Error("Unable to configure git push policy for workspace.");
  }

  const normalizedBlockedBranches = Array.from(
    new Set(parseBranchList(blockedBranches).map((entry) => normalizeBranchName(entry)).filter(Boolean)),
  );
  const hookLines = [
    "#!/bin/sh",
    "set -eu",
    "while read local_ref local_sha remote_ref remote_sha",
    "do",
    '  case "$remote_ref" in',
    "    refs/heads/*) branch=${remote_ref#refs/heads/} ;;",
    "    *) continue ;;",
    "  esac",
    '  case "$branch" in',
    ...normalizedBlockedBranches.map(
      (branch) =>
        `    ${JSON.stringify(branch)}) echo "codeq8: refusing push to protected branch ${branch}" >&2; exit 1 ;;`,
    ),
    "    *) ;;",
    "  esac",
    "done",
    "exit 0",
    "",
  ];
  const hookPath = path.join(workspacePath, ".git", "hooks", "pre-push");
  await ensureDirectory(path.dirname(hookPath));
  await fs.writeFile(hookPath, hookLines.join("\n"), {
    encoding: "utf8",
    mode: 0o755,
  });
}

function resolveEffectiveWriteBranch({ sourceType, branchContext }) {
  const normalizedSourceType = normalizeSourceType(sourceType || "");
  const normalizedWriteBranch = normalizeBranchName(branchContext.write_branch);
  const normalizedContextBranch = normalizeBranchName(branchContext.context_branch);
  const normalizedBaseBranch = normalizeBranchName(branchContext.base_branch);
  const normalizedDefaultBranch = normalizeBranchName(branchContext.default_branch);
  const normalizedProtectedBranches = parseBranchList(branchContext.protected_branches || []);
  const rememberedBranch =
    normalizeText(branchContext.write_mode) === "branch_and_pr" &&
    isProtectedBranch(normalizedWriteBranch, [
      ...normalizedProtectedBranches,
      normalizedBaseBranch,
      normalizedDefaultBranch,
    ])
      ? ""
      : normalizedWriteBranch;
  const normalizedPullRequestHeadBranch = normalizeBranchName(
    branchContext.pull_request_head_branch,
  );

  if (
    normalizedSourceType === "pull_request" &&
    normalizeText(branchContext.write_mode) === "direct_push"
  ) {
    return (
      normalizedPullRequestHeadBranch ||
      normalizedContextBranch ||
      rememberedBranch
    );
  }

  if (rememberedBranch) {
    return rememberedBranch;
  }

  return normalizedContextBranch || normalizedBaseBranch || normalizedDefaultBranch;
}

function resolveReviewBaseBranch({ sourceType, branchContext }) {
  const normalizedSourceType = normalizeSourceType(sourceType || "");
  const normalizedBaseBranch = normalizeBranchName(branchContext.base_branch);
  const normalizedContextBranch = normalizeBranchName(branchContext.context_branch);
  const normalizedDefaultBranch = normalizeBranchName(branchContext.default_branch);

  if (normalizedBaseBranch) {
    return normalizedBaseBranch;
  }
  if (normalizedSourceType === "branch") {
    return normalizedDefaultBranch || normalizedContextBranch;
  }
  return normalizedContextBranch || normalizedDefaultBranch;
}

function shouldEnsurePullRequest({
  sourceType = "",
  writeMode = "",
  hasBranchChangesForReview = false,
  meaningfulRepoWork = false,
}) {
  if (!hasBranchChangesForReview) {
    return false;
  }
  if (normalizeText(writeMode) === "branch_and_pr") {
    return true;
  }
  return normalizeSourceType(sourceType) === "branch" && meaningfulRepoWork;
}

function buildRunnerGitOwnershipPromptLines({ branch = "" } = {}) {
  const normalizedBranch = normalizeBranchName(branch);
  const remoteBranch = normalizedBranch ? `origin/${normalizedBranch}` : "the remote branch";
  return [
    "- The runner will not create commits, push branches, or resolve git divergence for you.",
    "- If you make repo changes that should be kept, you are responsible for committing and pushing them at the checkpoints that make sense for the user's request, and before you finish.",
    `- If \`git push\` is rejected because ${remoteBranch} changed, inspect the divergence, merge or rebase deliberately, resolve conflicts, and push again yourself.`,
    "- If those git conflicts require an unclear product decision, stop and explain the blocker instead of guessing.",
  ];
}

function buildLoopStylePromptLines() {
  return [
    "- By default, handle the current user request as a normal single-pass run; do not turn it into open-ended loop-style work unless the user clearly asks for that.",
    "- If the user clearly asks for loop-style or iterative work, you may stay in this run and work through multiple cycles of changes, commits, pushes, checks, and follow-up fixes when that matches the request.",
    "- If the user asks for loop-style work and the intended loop is unclear, stop and ask the user to clarify before you start making repo changes.",
    "- When you are working in a requested loop, stop when you hit a real blocker, when the user's goal is satisfied, or when you judge that the loop has reached a sensible stopping point within this run.",
    "- Do not treat requested loop-style work as permission to create a background or automatically resumed workflow across turns; keep the work bounded to this run unless the user asks again later.",
  ];
}

async function currentBranch({ workspacePath, commandEnv }) {
  const branchResult = await runProcessCapture(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );
  if (!branchResult.ok) {
    return "";
  }
  return normalizeBranchName(branchResult.stdout);
}

function isRecoverableWorkspaceRefRefreshFailure(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("could not parse commit") ||
    normalized.includes("could not read ") ||
    normalized.includes("bad object refs/remotes/origin/") ||
    normalized.includes("did not send all necessary objects")
  );
}

function parseBrokenShallowBoundaryCommits(value) {
  const commits = [];
  const lines = String(value || "").split(/\r?\n/g);
  for (let index = 0; index < lines.length; index += 1) {
    const line = normalizeText(lines[index]);
    const brokenLinkMatch = /^broken link from\s+commit\s+([0-9a-f]{40})$/i.exec(line);
    if (!brokenLinkMatch) {
      continue;
    }
    const nextLine = normalizeText(lines[index + 1]);
    if (!/^to\s+commit\s+[0-9a-f]{40}$/i.test(nextLine)) {
      continue;
    }
    commits.push(brokenLinkMatch[1].toLowerCase());
  }
  return Array.from(new Set(commits));
}

async function repairWorkspaceShallowBoundaries({
  workspacePath,
  commandEnv,
  runProcessCaptureImpl = runProcessCapture,
}) {
  const shallowPath = path.join(workspacePath, ".git", "shallow");
  if (!(await pathExists(shallowPath))) {
    return {
      repaired: false,
      shallowBoundaryCommitsAdded: [],
    };
  }

  const fsckResult = await runProcessCaptureImpl("git", ["fsck", "--full", "--no-dangling"], {
    cwd: workspacePath,
    env: commandEnv,
  });
  const candidateCommits = parseBrokenShallowBoundaryCommits(
    [fsckResult.stdout, fsckResult.stderr].filter(Boolean).join("\n"),
  );
  if (candidateCommits.length === 0) {
    return {
      repaired: false,
      shallowBoundaryCommitsAdded: [],
    };
  }

  const validBoundaryCommits = [];
  for (const commitId of candidateCommits) {
    const commitType = await runProcessCaptureImpl("git", ["cat-file", "-t", commitId], {
      cwd: workspacePath,
      env: commandEnv,
    });
    if (commitType.ok && normalizeText(commitType.stdout).toLowerCase() === "commit") {
      validBoundaryCommits.push(commitId);
    }
  }
  if (validBoundaryCommits.length === 0) {
    return {
      repaired: false,
      shallowBoundaryCommitsAdded: [],
    };
  }

  const shallowContents = await fs.readFile(shallowPath, "utf8").catch(() => "");
  const existingBoundaryCommits = Array.from(
    new Set(
      String(shallowContents || "")
        .split(/\r?\n/g)
        .map((entry) => normalizeText(entry).toLowerCase())
        .filter((entry) => /^[0-9a-f]{40}$/.test(entry)),
    ),
  );
  const existingBoundarySet = new Set(existingBoundaryCommits);
  const shallowBoundaryCommitsAdded = validBoundaryCommits.filter(
    (commitId) => !existingBoundarySet.has(commitId),
  );
  if (shallowBoundaryCommitsAdded.length === 0) {
    return {
      repaired: false,
      shallowBoundaryCommitsAdded: [],
    };
  }

  const mergedBoundaryCommits = Array.from(
    new Set([...existingBoundaryCommits, ...shallowBoundaryCommitsAdded]),
  ).sort();
  await fs.writeFile(shallowPath, `${mergedBoundaryCommits.join("\n")}\n`, "utf8");
  return {
    repaired: true,
    shallowBoundaryCommitsAdded,
  };
}

async function findBrokenRemoteTrackingRefs({
  workspacePath,
  commandEnv,
  runProcessCaptureImpl = runProcessCapture,
}) {
  const listedRefs = await runProcessCaptureImpl(
    "git",
    ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/origin"],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );
  if (!listedRefs.ok) {
    return [];
  }

  const brokenRefs = [];
  const lines = String(listedRefs.stdout || "").split(/\r?\n/g);
  for (const line of lines) {
    const [refName = "", objectId = ""] = normalizeText(line).split(/\s+/, 2);
    if (!normalizeText(refName) || !/^[0-9a-f]{40}$/i.test(normalizeText(objectId))) {
      continue;
    }
    const objectExists = await runProcessCaptureImpl("git", ["cat-file", "-e", objectId], {
      cwd: workspacePath,
      env: commandEnv,
    });
    if (!objectExists.ok) {
      brokenRefs.push({
        refName: normalizeText(refName),
        objectId: normalizeText(objectId),
      });
    }
  }

  return brokenRefs;
}

async function refreshWorkspaceRemoteRefs({
  workspacePath,
  commandEnv,
  runProcessCaptureImpl = runProcessCapture,
}) {
  const fetched = await runProcessCaptureImpl("git", ["fetch", "--prune", "origin"], {
    cwd: workspacePath,
    env: commandEnv,
  });
  if (fetched.ok) {
    return {
      ok: true,
      recovered: false,
      degraded: false,
      brokenRefsRemoved: [],
      shallowBoundaryCommitsAdded: [],
      error: "",
    };
  }

  let fetchError = summarizeGitProcessFailure(fetched);
  const shallowRepair = await repairWorkspaceShallowBoundaries({
    workspacePath,
    commandEnv,
    runProcessCaptureImpl,
  });
  const shallowBoundaryCommitsAdded = shallowRepair.shallowBoundaryCommitsAdded;
  if (shallowRepair.repaired) {
    const shallowFetchRetry = await runProcessCaptureImpl("git", ["fetch", "--prune", "origin"], {
      cwd: workspacePath,
      env: commandEnv,
    });
    if (shallowFetchRetry.ok) {
      return {
        ok: true,
        recovered: true,
        degraded: false,
        brokenRefsRemoved: [],
        shallowBoundaryCommitsAdded,
        error: "",
      };
    }
    fetchError = summarizeGitProcessFailure(shallowFetchRetry);
  }

  const brokenRefs = await findBrokenRemoteTrackingRefs({
    workspacePath,
    commandEnv,
    runProcessCaptureImpl,
  });
  const brokenRefNames = brokenRefs.map((entry) => entry.refName);

  if (brokenRefs.length > 0) {
    for (const brokenRef of brokenRefs) {
      await runProcessCaptureImpl("git", ["update-ref", "-d", brokenRef.refName], {
        cwd: workspacePath,
        env: commandEnv,
      }).catch(() => {});
    }

    const retriedFetch = await runProcessCaptureImpl("git", ["fetch", "--prune", "origin"], {
      cwd: workspacePath,
      env: commandEnv,
    });
    if (retriedFetch.ok) {
      return {
        ok: true,
        recovered: true,
        degraded: false,
        brokenRefsRemoved: brokenRefNames,
        shallowBoundaryCommitsAdded,
        error: "",
      };
    }

    const retryError = summarizeGitProcessFailure(retriedFetch);
    const recoverable = isRecoverableWorkspaceRefRefreshFailure(retryError);
    return {
      ok: recoverable,
      recovered: false,
      degraded: recoverable,
      brokenRefsRemoved: brokenRefNames,
      shallowBoundaryCommitsAdded,
      error: retryError,
    };
  }

  const recoverable = isRecoverableWorkspaceRefRefreshFailure(fetchError);
  return {
    ok: recoverable,
    recovered: false,
    degraded: recoverable,
    brokenRefsRemoved: [],
    shallowBoundaryCommitsAdded,
    error: fetchError,
  };
}

async function ensureWorkspaceRepository({
  workspacePath,
  repository,
  gitToken,
  commandEnv,
  githubLogin,
}) {
  const normalizedWorkspacePath = path.resolve(workspacePath);
  const normalizedRepository = normalizeText(repository);
  const parentDirectory = path.dirname(normalizedWorkspacePath);
  await fs.mkdir(parentDirectory, { recursive: true });

  const workspaceExists = await pathExists(normalizedWorkspacePath);
  const gitDirectoryPath = path.join(normalizedWorkspacePath, ".git");
  const gitDirectoryExists = await pathExists(gitDirectoryPath);
  if (!workspaceExists) {
    const cloneUrl = buildGithubCloneUrl(normalizedRepository, gitToken);
    if (!cloneUrl) {
      throw new Error("Unable to build workspace clone URL.");
    }
    log("Cloning workspace repository", `repository=${normalizedRepository} path=${normalizedWorkspacePath}`);
    const cloned = await runProcessCapture(
      "git",
      ["clone", "--no-tags", "--depth=1", cloneUrl, normalizedWorkspacePath],
      {
        cwd: parentDirectory,
        env: commandEnv,
      },
    );
    if (!cloned.ok) {
      throw new Error(
        `Workspace clone failed for ${normalizedRepository}. ${summarizeGitProcessFailure(cloned)}`,
      );
    }
  } else if (!gitDirectoryExists) {
    throw new Error(`Workspace path exists but is not a git repository: ${normalizedWorkspacePath}`);
  }

  if (!(await isDirectory(normalizedWorkspacePath))) {
    throw new Error(`Workspace path is not a directory: ${normalizedWorkspacePath}`);
  }

  await applyWorkspaceGitIdentity({
    workspacePath: normalizedWorkspacePath,
    commandEnv,
    githubLogin,
  });

  const remoteUrl = buildGithubCloneUrl(normalizedRepository, "");
  if (remoteUrl) {
    await configureWorkspaceGitCredentialHelper({
      workspacePath: normalizedWorkspacePath,
      commandEnv,
      publicBaseUrl: normalizeCodePublicBaseUrl(commandEnv.CODE_PUBLIC_BASE_URL),
      workspaceRepository: normalizedRepository,
    });
    await runProcessCapture("git", ["remote", "set-url", "origin", remoteUrl], {
      cwd: normalizedWorkspacePath,
      env: commandEnv,
    });
  }
  await configureWorkspacePushPolicy({
    workspacePath: normalizedWorkspacePath,
    commandEnv,
    remoteUrl,
    blockedBranches: [],
  });

  const refreshedRefs = await refreshWorkspaceRemoteRefs({
    workspacePath: normalizedWorkspacePath,
    commandEnv,
  });
  if (!refreshedRefs.ok) {
    throw new Error(
      `Failed to fetch latest workspace refs for ${normalizedRepository}: ${normalizeText(refreshedRefs.error) || "Workspace ref refresh failed."}`,
    );
  }
  if (refreshedRefs.recovered) {
    const recoveryDetails = [];
    if (refreshedRefs.shallowBoundaryCommitsAdded.length > 0) {
      recoveryDetails.push(`shallow=${refreshedRefs.shallowBoundaryCommitsAdded.join(", ")}`);
    }
    if (refreshedRefs.brokenRefsRemoved.length > 0) {
      recoveryDetails.push(`refs=${refreshedRefs.brokenRefsRemoved.join(", ")}`);
    }
    log(
      "Recovered workspace git metadata",
      `repository=${normalizedRepository}${recoveryDetails.length > 0 ? ` ${recoveryDetails.join(" ")}` : ""}`,
    );
  } else if (refreshedRefs.degraded) {
    log(
      "WARN",
      `Workspace ref refresh failed, continuing with targeted branch fetches | repository=${normalizedRepository} error=${truncate(refreshedRefs.error, 500)}`,
    );
  }

  return normalizedWorkspacePath;
}

function parseBranchContextFromEnv() {
  return {
    default_branch: normalizeBranchName(process.env.CODE_CHAT_DEFAULT_BRANCH),
    protected_branches: parseBranchList(process.env.CODE_CHAT_PROTECTED_BRANCHES),
    production_branch: normalizeBranchName(process.env.CODE_CHAT_PRODUCTION_BRANCH),
    context_branch: normalizeBranchName(process.env.CODE_CHAT_CONTEXT_BRANCH),
    write_mode: normalizeText(process.env.CODE_CHAT_WRITE_MODE).toLowerCase(),
    write_branch: normalizeBranchName(process.env.CODE_CHAT_WRITE_BRANCH),
    base_branch: normalizeBranchName(process.env.CODE_CHAT_BASE_BRANCH),
    pull_request_number: parsePositiveInteger(process.env.CODE_CHAT_PULL_REQUEST_NUMBER, 0),
    pull_request_url: normalizeText(process.env.CODE_CHAT_PULL_REQUEST_URL),
    pull_request_base_branch: normalizeBranchName(process.env.CODE_CHAT_PULL_REQUEST_BASE_BRANCH),
    pull_request_head_branch: normalizeBranchName(process.env.CODE_CHAT_PULL_REQUEST_HEAD_BRANCH),
  };
}

function normalizeSourceType(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "pull_request" || normalized === "branch" || normalized === "default_branch") {
    return normalized;
  }
  return "default_branch";
}

function normalizeThreadBranchContext(value) {
  const normalized = normalizeObject(value);
  return {
    default_branch: normalizeBranchName(
      normalized.default_branch || normalized.defaultBranch || "",
    ),
    protected_branches: parseBranchList(
      normalized.protected_branches || normalized.protectedBranches || [],
    ),
    production_branch: normalizeBranchName(
      normalized.production_branch || normalized.productionBranch || "",
    ),
    context_branch: normalizeBranchName(
      normalized.context_branch || normalized.contextBranch || "",
    ),
    write_mode: normalizeText(normalized.write_mode || normalized.writeMode || "").toLowerCase(),
    write_branch: normalizeBranchName(
      normalized.write_branch || normalized.writeBranch || "",
    ),
    base_branch: normalizeBranchName(
      normalized.base_branch || normalized.baseBranch || "",
    ),
    pull_request_number: parsePositiveInteger(
      normalized.pull_request_number || normalized.pullRequestNumber,
      0,
    ),
    pull_request_url: normalizeText(
      normalized.pull_request_url || normalized.pullRequestUrl || "",
    ),
    pull_request_base_branch: normalizeBranchName(
      normalized.pull_request_base_branch || normalized.pullRequestBaseBranch || "",
    ),
    pull_request_head_branch: normalizeBranchName(
      normalized.pull_request_head_branch || normalized.pullRequestHeadBranch || "",
    ),
  };
}

function readPullRequestHeadRepository(githubContext) {
  const normalized = normalizeObject(githubContext);
  const pullRequest = normalizeObject(
    normalized.pull_request || normalized.pullRequest || normalized.pr || {},
  );
  const head = normalizeObject(pullRequest.head);
  const repository = normalizeObject(head.repo || head.repository || {});
  return normalizeText(
    repository.full_name ||
      repository.fullName ||
      head.repository_full_name ||
      head.repositoryFullName ||
      "",
  );
}

function normalizeWebChatThread(value) {
  const normalized = normalizeObject(value);
  return {
    thread_id: normalizeText(normalized.thread_id || normalized.threadId || ""),
    workspace_repository: normalizeText(
      normalized.workspace_repository || normalized.workspaceRepository || normalized.repository || "",
    ),
    title: normalizeText(normalized.title || ""),
    source_type: normalizeSourceType(normalized.source_type || normalized.sourceType || ""),
    github_context: normalizeObject(normalized.github_context || normalized.githubContext || {}),
    branch_context: normalizeThreadBranchContext(
      normalized.branch_context || normalized.branchContext || {},
    ),
    codex_session_state: normalizeCodexSessionState(
      normalized.codex_session_state || normalized.codexSessionState || {},
    ),
  };
}

function normalizeThreadExecutionTarget({
  repository,
  sourceType,
  githubContext,
  branchContext,
}) {
  const normalizedSourceType = normalizeSourceType(sourceType);
  const normalizedBranchContext = normalizeThreadBranchContext(branchContext);
  const target = {
    repository: normalizeText(repository),
    source_type: normalizedSourceType,
    default_branch: normalizedBranchContext.default_branch || "",
    production_branch: normalizedBranchContext.production_branch || "",
    context_branch: normalizedBranchContext.context_branch || "",
    write_mode: normalizedBranchContext.write_mode || "",
    base_branch: normalizedBranchContext.base_branch || "",
  };
  if (normalizedSourceType === "pull_request") {
    target.pull_request_number = normalizedBranchContext.pull_request_number || 0;
    target.pull_request_base_branch =
      normalizedBranchContext.pull_request_base_branch || "";
    target.pull_request_head_branch =
      normalizedBranchContext.pull_request_head_branch || "";
    target.pull_request_head_repository = readPullRequestHeadRepository(githubContext);
  }
  return target;
}

function buildThreadExecutionTargetSignature(target) {
  return JSON.stringify(normalizeObject(target));
}

function threadExecutionTargetChanged(previousTarget, nextTarget) {
  return JSON.stringify(previousTarget || {}) !== JSON.stringify(nextTarget || {});
}

function describeThreadExecutionTarget(target) {
  const normalized = normalizeObject(target);
  const sourceType = normalizeSourceType(normalized.source_type);
  if (sourceType === "pull_request" && parsePositiveInteger(normalized.pull_request_number, 0) > 0) {
    return `PR #${parsePositiveInteger(normalized.pull_request_number, 0)}`;
  }
  if (normalizeText(normalized.context_branch)) {
    return `branch ${normalizeText(normalized.context_branch)}`;
  }
  if (normalizeText(normalized.default_branch)) {
    return `default branch ${normalizeText(normalized.default_branch)}`;
  }
  return "updated thread context";
}

function isProtectedBranch(branchName, protectedBranches) {
  const normalizedBranch = normalizeBranchName(branchName);
  if (!normalizedBranch) {
    return false;
  }
  return protectedBranches.some(
    (entry) => normalizeBranchName(entry).toLowerCase() === normalizedBranch.toLowerCase(),
  );
}

async function readWebChatMessages({ workerUrl, adminToken, threadId, limit = 40 }) {
  const response = await workerJsonRequest({
    workerUrl,
    adminToken,
    path: "/web-chat/messages/list",
    method: "GET",
    query: new URLSearchParams({
      thread_id: normalizeText(threadId),
      limit: String(Math.max(1, Math.min(200, limit))),
    }),
  });
  if (!response.ok || response.payload.ok === false) {
    throw new Error(
      extractErrorMessage(response.payload.error) ||
        `Failed to read web chat messages (${response.status}).`,
    );
  }
  return {
    thread: normalizeObject(response.payload.thread),
    messages: Array.isArray(response.payload.messages) ? response.payload.messages : [],
  };
}

async function loadWebChatMessages({
  workerUrl,
  adminToken,
  threadId,
  limit = 40,
  fallbackThread = null,
}) {
  try {
    return await readWebChatMessages({
      workerUrl,
      adminToken,
      threadId,
      limit,
    });
  } catch (error) {
    const message = extractErrorMessage(error);
    if (message !== "web chat thread was not found.") {
      throw error;
    }
    log(
      "WARN",
      "Using fallback web chat message context after lookup failure",
      `thread_id=${normalizeText(threadId)} worker=${normalizeBaseUrl(workerUrl)}`,
    );
    return {
      thread: fallbackThread ? normalizeObject(fallbackThread) : {},
      messages: [],
    };
  }
}

async function readWebChatAttachment({
  workerUrl,
  adminToken,
  threadId,
  attachmentId,
}) {
  const response = await workerJsonRequest({
    workerUrl,
    adminToken,
    path: "/web-chat/attachments/get",
    method: "GET",
    query: new URLSearchParams({
      thread_id: normalizeText(threadId),
      attachment_id: normalizeText(attachmentId),
      include_contents: "1",
    }),
  });
  if (!response.ok || response.payload.ok === false) {
    throw new Error(
      extractErrorMessage(response.payload.error) ||
        `Failed to read web chat attachment (${response.status}).`,
    );
  }
  return {
    attachment: normalizeAttachmentRecord(response.payload.attachment),
    fileContentsBase64Url: normalizeText(
      response.payload.file_contents_base64url || response.payload.fileContentsBase64Url,
    ),
  };
}

async function readWebChatThread({ workerUrl, adminToken, threadId }) {
  const response = await workerJsonRequest({
    workerUrl,
    adminToken,
    path: "/web-chat/threads/get",
    method: "GET",
    query: new URLSearchParams({
      thread_id: normalizeText(threadId),
    }),
  });
  if (!response.ok || response.payload.ok === false) {
    throw new Error(
      extractErrorMessage(response.payload.error) ||
        `Failed to read web chat thread (${response.status}).`,
    );
  }
  const thread = normalizeWebChatThread(response.payload.thread);
  if (!thread.thread_id || !thread.workspace_repository) {
    throw new Error("Web chat thread response was missing canonical thread state.");
  }
  return thread;
}

async function loadWebChatThread({
  workerUrl,
  adminToken,
  threadId,
  retries = 3,
  retryDelayMs = 750,
}) {
  let lastError = null;
  const attempts = Math.max(1, parsePositiveInteger(retries, 3) || 3);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await readWebChatThread({
        workerUrl,
        adminToken,
        threadId,
      });
    } catch (error) {
      lastError = error;
      const message = extractErrorMessage(error);
      const isMissingThread = message === "web chat thread was not found.";
      if (!isMissingThread || attempt >= attempts) {
        break;
      }
      log(
        "WARN",
        "Web chat thread lookup missed; retrying",
        `thread_id=${normalizeText(threadId)} attempt=${attempt}/${attempts} worker=${normalizeBaseUrl(workerUrl)}`,
      );
      await sleep(retryDelayMs);
    }
  }

  throw lastError || new Error("Unable to load web chat thread.");
}

async function readWebChatCodexSessionState({
  workerUrl,
  adminToken,
  threadId,
  includeContents = false,
}) {
  const query = new URLSearchParams({
    thread_id: normalizeText(threadId),
  });
  if (includeContents) {
    query.set("include_contents", "true");
  }
  const response = await workerJsonRequest({
    workerUrl,
    adminToken,
    path: "/web-chat/codex-session/get",
    method: "GET",
    query,
  });
  if (!response.ok || response.payload.ok === false) {
    throw new Error(
      extractErrorMessage(response.payload.error) ||
        `Failed to read web chat codex session state (${response.status}).`,
    );
  }
  return {
    thread: normalizeObject(response.payload.thread),
    codexSessionState: normalizeCodexSessionState(
      response.payload.codex_session_state || response.payload.codexSessionState,
    ),
    sessionFileContents: String(
      response.payload.session_file_contents || response.payload.sessionFileContents || "",
    ),
  };
}

async function loadWebChatCodexSessionState({
  workerUrl,
  adminToken,
  threadId,
  includeContents = false,
  fallbackThread = null,
  retries = 2,
  retryDelayMs = 750,
}) {
  let lastError = null;
  const attempts = Math.max(1, parsePositiveInteger(retries, 2) || 2);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await readWebChatCodexSessionState({
        workerUrl,
        adminToken,
        threadId,
        includeContents,
      });
    } catch (error) {
      lastError = error;
      const message = extractErrorMessage(error);
      const isMissingThread = message === "web chat thread was not found.";
      if (isMissingThread || attempt >= attempts) {
        break;
      }
      log(
        "WARN",
        "Web chat codex session lookup failed; retrying",
        `thread_id=${normalizeText(threadId)} attempt=${attempt}/${attempts} worker=${normalizeBaseUrl(workerUrl)}`,
      );
      await sleep(retryDelayMs);
    }
  }

  const message = extractErrorMessage(lastError);
  if (message !== "web chat thread was not found.") {
    throw lastError;
  }
  log(
    "WARN",
    "Using fallback codex session state after thread lookup failure",
    `thread_id=${normalizeText(threadId)} worker=${normalizeBaseUrl(workerUrl)}`,
  );
  return {
    thread: fallbackThread ? normalizeObject(fallbackThread) : {},
    codexSessionState: normalizeCodexSessionState(null),
    sessionFileContents: "",
  };
}

async function loadCodexSessionStateForExecution({
  workerUrl,
  adminToken,
  threadId,
  thread,
  retries = 2,
  retryDelayMs = 750,
}) {
  const persistedCodexSessionState = normalizeCodexSessionState(
    normalizeObject(thread).codex_session_state || null,
  );
  const expectedBundleRevision = persistedCodexSessionState.bundle_revision || 0;

  try {
    const loadedCodexSession = await loadWebChatCodexSessionState({
      workerUrl,
      adminToken,
      threadId,
      includeContents: true,
      fallbackThread: thread,
      retries,
      retryDelayMs,
    });
    const resolvedCodexSessionState = normalizeCodexSessionState(
      loadedCodexSession.codexSessionState || persistedCodexSessionState,
    );
    if (
      resolvedCodexSessionState.status === "ready" &&
      String(loadedCodexSession.sessionFileContents || "").trim()
    ) {
      const parsedBundle = parseCodexSessionBundleContents({
        sessionFileContents: loadedCodexSession.sessionFileContents,
        fallbackCliVersion: resolvedCodexSessionState.cli_version,
        fallbackModel: resolvedCodexSessionState.model,
      });
      if (
        resolvedCodexSessionState.session_id &&
        parsedBundle.sessionId !== resolvedCodexSessionState.session_id
      ) {
        throw new Error(
          "Stored Codex session bundle session id does not match the persisted session state.",
        );
      }
    }
    return {
      loadedCodexSession,
      codexSessionState: resolvedCodexSessionState,
      persistedCodexSessionState: resolvedCodexSessionState,
      expectedBundleRevision: resolvedCodexSessionState.bundle_revision || expectedBundleRevision,
      continuityWarning: "",
    };
  } catch (error) {
    const message = extractErrorMessage(error);
    if (isInvalidCodexSessionBundleError(message)) {
      try {
        const invalidated = await invalidateWebChatCodexSessionState({
          workerUrl,
          adminToken,
          threadId,
          reason: message,
        });
        const invalidatedState = invalidated.codexSessionState;
        const continuityWarning =
          `Continuing with a fresh Codex session after stored session validation failed: ${message}`;
        log(
          "WARN",
          continuityWarning,
          `thread_id=${normalizeText(threadId)} worker=${normalizeBaseUrl(workerUrl)}`,
        );
        return {
          loadedCodexSession: {
            thread: normalizeObject(invalidated.thread || thread),
            codexSessionState: invalidatedState,
            sessionFileContents: "",
          },
          codexSessionState: invalidatedState,
          persistedCodexSessionState: invalidatedState,
          expectedBundleRevision: invalidatedState.bundle_revision || expectedBundleRevision,
          continuityWarning,
        };
      } catch (invalidateError) {
        log(
          "WARN",
          `Unable to invalidate stored Codex session bundle after validation failure: ${extractErrorMessage(
            invalidateError,
          )}`,
          `thread_id=${normalizeText(threadId)} worker=${normalizeBaseUrl(workerUrl)}`,
        );
      }
    }
    const continuityWarning =
      `Continuing with a fresh Codex session after stored session recovery failed: ${message}`;
    log(
      "WARN",
      continuityWarning,
      `thread_id=${normalizeText(threadId)} worker=${normalizeBaseUrl(workerUrl)}`,
    );
    const freshCodexSessionState = buildFreshStartCodexSessionState(
      persistedCodexSessionState,
    );
    return {
      loadedCodexSession: {
        thread: normalizeObject(thread),
        codexSessionState: freshCodexSessionState,
        sessionFileContents: "",
      },
      codexSessionState: freshCodexSessionState,
      persistedCodexSessionState: freshCodexSessionState,
      expectedBundleRevision,
      continuityWarning,
    };
  }
}

async function upsertWebChatCodexSessionState({
  workerUrl,
  adminToken,
  threadId,
  sessionId = "",
  sessionFileRelativePath = "",
  sessionFileContents = "",
  targetSignature = "",
  cliVersion = "",
  model = "",
  lastRunId = "",
  lastResumedAt = 0,
  lastCompactionObservedAt = 0,
  expectedBundleRevision = null,
  status = "",
  error = "",
}) {
  const body = {
    thread_id: normalizeText(threadId),
    session_id: normalizeCodexSessionId(sessionId),
    session_file_relative_path: normalizeCodexSessionRelativePath(
      sessionFileRelativePath,
    ),
    session_file_contents: String(sessionFileContents || ""),
    target_signature: normalizeText(targetSignature),
    cli_version: normalizeText(cliVersion),
    model: normalizeText(model),
    last_run_id: normalizeText(lastRunId),
    last_resumed_at: parsePositiveInteger(lastResumedAt, 0),
    last_compaction_observed_at: parsePositiveInteger(lastCompactionObservedAt, 0),
    status: normalizeText(status),
    error: normalizeText(error),
  };
  if (expectedBundleRevision !== null && expectedBundleRevision !== undefined) {
    body.expected_bundle_revision = parseNonNegativeInteger(expectedBundleRevision, 0);
  }

  const response = await workerJsonRequest({
    workerUrl,
    adminToken,
    path: "/web-chat/codex-session/upsert",
    method: "POST",
    body,
  });
  if (!response.ok || response.payload.ok === false) {
    throw new Error(
      extractErrorMessage(response.payload.error) ||
        `Failed to update web chat codex session state (${response.status}).`,
    );
  }
  return {
    thread: normalizeObject(response.payload.thread),
    codexSessionState: normalizeCodexSessionState(
      response.payload.codex_session_state || response.payload.codexSessionState,
    ),
  };
}

async function invalidateWebChatCodexSessionState({
  workerUrl,
  adminToken,
  threadId,
  reason = "",
}) {
  const response = await workerJsonRequest({
    workerUrl,
    adminToken,
    path: "/web-chat/codex-session/invalidate",
    method: "POST",
    body: {
      thread_id: normalizeText(threadId),
      reason: normalizeText(reason),
    },
  });
  if (!response.ok || response.payload.ok === false) {
    throw new Error(
      extractErrorMessage(response.payload.error) ||
        `Failed to invalidate web chat codex session state (${response.status}).`,
    );
  }
  return {
    thread: normalizeObject(response.payload.thread),
    codexSessionState: normalizeCodexSessionState(
      response.payload.codex_session_state || response.payload.codexSessionState,
    ),
  };
}

async function safePersistCodexSessionError({
  workerUrl,
  adminToken,
  threadId,
  runId,
  error,
  lastResumedAt = 0,
  expectedBundleRevision = null,
}) {
  const normalizedError = normalizeText(error);
  if (!normalizeText(threadId) || !normalizedError) {
    return;
  }
  try {
    await upsertWebChatCodexSessionState({
      workerUrl,
      adminToken,
      threadId,
      lastRunId: runId,
      lastResumedAt,
      expectedBundleRevision,
      status: "error",
      error: normalizedError,
    });
  } catch (persistError) {
    log(
      "ERROR",
      `Unable to persist web chat codex session error: ${
        persistError instanceof Error ? persistError.message : String(persistError)
      }`,
    );
  }
}

async function persistCapturedCodexSessionBundle({
  workerUrl,
  adminToken,
  threadId,
  runId,
  codexHome,
  existingSessionState,
  model,
  targetSignature,
  expectedBundleRevision = null,
  lastResumedAt = 0,
}) {
  const capturedSessionBundle = await captureCodexSessionBundle({
    codexHome,
    existingSessionState,
    model,
  });
  const persistedSession = await upsertWebChatCodexSessionState({
    workerUrl,
    adminToken,
    threadId,
    sessionId: capturedSessionBundle.sessionId,
    sessionFileRelativePath: capturedSessionBundle.sessionFileRelativePath,
    sessionFileContents: capturedSessionBundle.sessionFileContents,
    targetSignature,
    cliVersion: capturedSessionBundle.cliVersion,
    model: capturedSessionBundle.model || model,
    lastRunId: runId,
    lastResumedAt,
    lastCompactionObservedAt: Math.max(
      capturedSessionBundle.lastCompactionObservedAt,
      normalizeCodexSessionState(existingSessionState).last_compaction_observed_at || 0,
    ),
    expectedBundleRevision,
    status: "ready",
  });
  return persistedSession.codexSessionState;
}

async function persistCapturedCodexSessionBundleWithRetries({
  workerUrl,
  adminToken,
  threadId,
  runId,
  codexHome,
  existingSessionState,
  model,
  targetSignature,
  expectedBundleRevision = null,
  sessionFileSnapshot = null,
  runStartedAt = 0,
  lastResumedAt = 0,
  attempts = 3,
  retryDelayMs = 750,
}) {
  const normalizedAttempts = Math.max(1, parsePositiveInteger(attempts, 3) || 3);
  let lastError = null;

  for (let attempt = 1; attempt <= normalizedAttempts; attempt += 1) {
    try {
      return await persistCapturedCodexSessionBundle({
        workerUrl,
        adminToken,
        threadId,
        runId,
        codexHome,
        existingSessionState,
        model,
        targetSignature,
        expectedBundleRevision,
        sessionFileSnapshot,
        runStartedAt,
        lastResumedAt,
      });
    } catch (error) {
      lastError = error;
      const message = extractErrorMessage(error);
      if (attempt >= normalizedAttempts || !isRetryableCodexSessionPersistenceError(message)) {
        break;
      }
      log(
        "WARN",
        "Retrying web chat codex session persistence",
        `thread_id=${normalizeText(threadId)} run_id=${normalizeText(runId)} attempt=${attempt}/${normalizedAttempts} reason=${truncate(message, 500)}`,
      );
      await sleep(retryDelayMs);
    }
  }

  throw lastError || new Error("Unable to persist web chat codex session state.");
}

async function clearRecoverableCodexSessionErrorState({
  workerUrl,
  adminToken,
  threadId,
  codexSessionState,
}) {
  const normalizedState = normalizeCodexSessionState(codexSessionState);
  if (
    normalizedState.status !== "error" ||
    !normalizeText(threadId) ||
    !isRecoverableCodexSessionErrorState(normalizedState.last_error)
  ) {
    return normalizedState;
  }

  const hasRecoverablePersistedBundle =
    normalizedState.bundle_storage_key &&
    normalizedState.session_id &&
    normalizedState.session_file_relative_path;
  if (hasRecoverablePersistedBundle) {
    try {
      const restoredSession = await upsertWebChatCodexSessionState({
        workerUrl,
        adminToken,
        threadId,
        sessionId: normalizedState.session_id,
        sessionFileRelativePath: normalizedState.session_file_relative_path,
        targetSignature: normalizedState.target_signature,
        cliVersion: normalizedState.cli_version,
        model: normalizedState.model,
        lastRunId: normalizedState.last_run_id,
        lastResumedAt: normalizedState.last_resumed_at,
        lastCompactionObservedAt: normalizedState.last_compaction_observed_at,
        expectedBundleRevision: normalizedState.bundle_revision || 0,
        status: "ready",
        error: "",
      });
      return restoredSession.codexSessionState;
    } catch (restoreError) {
      log(
        "WARN",
        `Unable to restore recoverable web chat codex session state: ${
          restoreError instanceof Error ? restoreError.message : String(restoreError)
        }`,
      );
      return normalizedState;
    }
  }

  try {
    const invalidatedSession = await invalidateWebChatCodexSessionState({
      workerUrl,
      adminToken,
      threadId,
      reason: truncate(
        `Clearing recoverable codex session error state: ${normalizedState.last_error}`,
        500,
      ),
    });
    return invalidatedSession.codexSessionState;
  } catch (invalidateError) {
    log(
      "WARN",
      `Unable to clear recoverable web chat codex session error state: ${
        invalidateError instanceof Error ? invalidateError.message : String(invalidateError)
      }`,
    );
    return buildFreshStartCodexSessionState(normalizedState);
  }
}

function toPromptMessageLine(message) {
  const normalizedMessage = normalizeObject(message);
  const role = normalizeText(normalizedMessage.role).toLowerCase();
  const content = truncate(normalizeText(normalizedMessage.content), MAX_MESSAGE_CHARS);
  const attachments = parseAttachmentList(
    normalizeObject(normalizedMessage.metadata).attachments || [],
  );
  if ((!content && attachments.length === 0) || (role !== "user" && role !== "assistant")) {
    return "";
  }
  const speaker = role === "assistant" ? "Codeq8" : "User";
  const attachmentSuffix =
    attachments.length > 0
      ? ` [attachments: ${attachments.map((entry) => entry.name).join(", ")}]`
      : "";
  return `${speaker}: ${content || "(attached files only)"}${attachmentSuffix}`;
}

function buildFreshPromptHistoryMessages({ messages, currentMessageId }) {
  const normalizedCurrentMessageId = normalizeText(currentMessageId);
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  return messages
    .filter(
      (message) =>
        normalizeText(normalizeObject(message).message_id) !== normalizedCurrentMessageId,
    )
    .slice(-MAX_CONTEXT_MESSAGES);
}

function sanitizeAttachmentFileName(value) {
  const normalized = normalizeAttachmentName(value);
  return normalized.replace(/\s+/g, "-");
}

async function materializeWebChatAttachments({
  attachments,
  attachmentRootPath,
  workerUrl,
  adminToken,
  threadId,
}) {
  const normalizedAttachments = parseAttachmentList(attachments);
  if (normalizedAttachments.length === 0) {
    return [];
  }

  await ensureDirectory(attachmentRootPath);
  const materialized = [];
  for (const attachment of normalizedAttachments) {
    const loaded = await readWebChatAttachment({
      workerUrl,
      adminToken,
      threadId,
      attachmentId: attachment.attachment_id,
    });
    if (!loaded.attachment || !loaded.fileContentsBase64Url) {
      throw new Error(`Attachment ${attachment.name} could not be loaded.`);
    }
    const targetPath = path.join(
      attachmentRootPath,
      `${attachment.attachment_id}-${sanitizeAttachmentFileName(attachment.name)}`,
    );
    await fs.writeFile(targetPath, Buffer.from(loaded.fileContentsBase64Url, "base64url"));
    materialized.push({
      ...loaded.attachment,
      local_path: targetPath,
    });
  }
  return materialized;
}

function buildAttachmentPromptLines(attachments) {
  const normalizedAttachments = Array.isArray(attachments) ? attachments : [];
  if (normalizedAttachments.length === 0) {
    return [];
  }

  return [
    "",
    "Files attached to the latest user request:",
    ...normalizedAttachments.map((attachment) => {
      const sizeSuffix = attachment.size_bytes > 0 ? `, ${attachment.size_bytes} bytes` : "";
      return `- ${attachment.name} (${attachment.content_type || "application/octet-stream"}${sizeSuffix}) at ${attachment.local_path}`;
    }),
    "- Inspect these files directly if they are relevant to the request.",
    "- Do not modify or delete the attached files.",
  ];
}

function buildReferencedThreadPromptLines(referencedThreads) {
  const normalizedReferencedThreads = Array.isArray(referencedThreads)
    ? referencedThreads
    : [];
  if (normalizedReferencedThreads.length === 0) {
    return [];
  }

  const lines = [
    "",
    "Referenced Codeq8 threads mentioned in the pending request:",
  ];
  for (const thread of normalizedReferencedThreads) {
    const normalizedThread = normalizeObject(thread);
    lines.push(
      `- ${normalizeText(normalizedThread.workspace_repository)} thread ${normalizeText(normalizedThread.thread_id)} | title: ${normalizeText(normalizedThread.title) || "Untitled"} | source: ${normalizeText(normalizedThread.source_type) || "default_branch"} | context branch: ${normalizeText(normalizeObject(normalizedThread.branch_context).context_branch) || "<unknown>"}`,
    );
    const threadMessages = Array.isArray(normalizedThread.messages)
      ? normalizedThread.messages
      : [];
    if (threadMessages.length === 0) {
      lines.push("  Recent messages: none loaded.");
      continue;
    }
    lines.push("  Recent messages (oldest to newest):");
    for (const message of threadMessages) {
      const normalizedMessage = normalizeObject(message);
      const role = normalizeText(normalizedMessage.role).toLowerCase();
      const speaker = role === "assistant" ? "Codeq8" : "User";
      const content = truncate(normalizeText(normalizedMessage.content), MAX_MESSAGE_CHARS);
      const attachments = parsePromptAttachmentList(normalizedMessage.attachments || []);
      const attachmentSuffix =
        attachments.length > 0
          ? ` [attachments: ${attachments.map((entry) => entry.name).join(", ")}]`
          : "";
      lines.push(`  ${speaker}: ${content || "(attached files only)"}${attachmentSuffix}`);
    }
  }

  return lines;
}

async function resolveCodeq8Path(commandEnv) {
  const explicit = normalizeText(commandEnv.CODEQ8_PATH || process.env.CODEQ8_PATH);
  if (explicit && (await isExecutableFile(explicit))) {
    return explicit;
  }

  const candidates = [
    "/opt/homebrew/bin/codeq8",
    "/usr/local/bin/codeq8",
  ];
  for (const candidate of candidates) {
    const normalized = normalizeText(candidate);
    if (normalized && (await isExecutableFile(normalized))) {
      return normalized;
    }
  }

  const whichResult = await runProcessCapture("/bin/bash", ["-lc", "command -v codeq8"], {
    cwd: process.cwd(),
    env: commandEnv,
  });
  if (whichResult.ok) {
    const resolved = normalizeText(whichResult.stdout);
    if (resolved && (await isExecutableFile(resolved))) {
      return resolved;
    }
  }

  throw new Error("codeq8 executable was not found. Install @codeq8/codeq8 globally on this runner.");
}

async function resolveGitHubCliPath(commandEnv) {
  const whichResult = await runProcessCapture("/bin/bash", ["-c", "command -v gh"], {
    cwd: process.cwd(),
    env: commandEnv,
  });
  if (whichResult.ok) {
    const resolved = normalizeText(whichResult.stdout);
    if (resolved && (await isExecutableFile(resolved))) {
      return resolved;
    }
  }

  const candidates = [
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
  ];
  for (const candidate of candidates) {
    const normalized = normalizeText(candidate);
    if (normalized && (await isExecutableFile(normalized))) {
      return normalized;
    }
  }

  throw new Error("gh executable was not found. Install GitHub CLI on this runner.");
}

function resolveWebChatGitHubUserToken(commandEnv) {
  return normalizeText(commandEnv?.CODEX_USER_GH_TOKEN);
}

function requireWebChatGitHubUserToken(commandEnv, operation = "GitHub repository writes") {
  const githubToken = resolveWebChatGitHubUserToken(commandEnv);
  if (!githubToken) {
    throw new Error(
      `${operation} require a GitHub user token. Re-authenticate with GitHub and retry.`,
    );
  }
  return githubToken;
}

function applyCodeq8CliRuntimeEnv({
  commandEnv,
  publicBaseUrl,
  runtimeHomePath,
}) {
  const normalizedBaseUrl = normalizeCodePublicBaseUrl(publicBaseUrl);
  commandEnv.CODEQ8_BASE_URL = normalizedBaseUrl;
  commandEnv.CODEQ8_AUTH_STORAGE = "file";
  if (normalizeText(runtimeHomePath)) {
    commandEnv.CODEQ8_CONFIG_HOME = path.join(
      path.resolve(runtimeHomePath),
      "codeq8-config",
    );
  }

  return {
    codeq8BaseUrl: normalizedBaseUrl,
    codeq8ConfigHome: normalizeText(commandEnv.CODEQ8_CONFIG_HOME),
  };
}

async function prepareGitHubCliAuth({
  commandEnv,
  runtimeHomePath,
}) {
  const helperPath = normalizeText(commandEnv.CODEX_GITHUB_TOKEN_HELPER_PATH);
  const githubToken = resolveWebChatGitHubWriteToken(commandEnv);
  if (!helperPath && !githubToken) {
    return {
      available: false,
      reason: "No GitHub write credential was available for gh auth.",
    };
  }

  let ghPath = "";
  try {
    ghPath = await resolveGitHubCliPath(commandEnv);
  } catch (error) {
    return {
      available: false,
      reason: extractErrorMessage(error),
    };
  }

  const normalizedRuntimeHomePath = path.resolve(runtimeHomePath);
  const wrapperBinPath = path.join(normalizedRuntimeHomePath, "bin");
  const wrapperPath = path.join(wrapperBinPath, "gh");
  const ghConfigDir = path.join(normalizedRuntimeHomePath, "gh-config");
  await ensureDirectory(wrapperBinPath);
  await ensureDirectory(ghConfigDir);

  const wrapperScript = [
    "#!/bin/sh",
    'github_token=""',
    'helper_path="${CODEX_GITHUB_TOKEN_HELPER_PATH:-}"',
    'if [ -n "$helper_path" ] && [ -x "$helper_path" ]; then',
    '  github_token=$("$helper_path" print-token 2>/dev/null || printf "")',
    "fi",
    'if [ -z "$github_token" ]; then',
    '  github_token="${CODEX_GITHUB_WRITE_TOKEN:-}"',
    "fi",
    "if [ -n \"$github_token\" ]; then",
    `  exec env GH_TOKEN="$github_token" GITHUB_TOKEN="$github_token" GH_CONFIG_DIR=${quoteShellArgument(
      ghConfigDir,
    )} GH_PROMPT_DISABLED=1 ${quoteShellArgument(ghPath)} "$@"`,
    "fi",
    `exec env GH_CONFIG_DIR=${quoteShellArgument(ghConfigDir)} GH_PROMPT_DISABLED=1 ${quoteShellArgument(
      ghPath,
    )} "$@"`,
    "",
  ].join("\n");
  await fs.writeFile(wrapperPath, wrapperScript, { mode: 0o755 });
  await fs.chmod(wrapperPath, 0o755);

  const currentPath = String(commandEnv.PATH || "");
  commandEnv.PATH = currentPath
    ? `${wrapperBinPath}${path.delimiter}${currentPath}`
    : wrapperBinPath;

  return {
    available: true,
    binPath: ghPath,
    wrapperPath,
  };
}

async function prepareCodeq8Cli({
  commandEnv,
  workspacePath,
  publicBaseUrl,
  expectedGithubLogin = "",
}) {
  try {
    await ensureRunnerGlobalCliTools({
      env: commandEnv,
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
      logger(message, details = "") {
        log(
          "Managed CLI refresh",
          `${message}${normalizeText(details) ? ` | ${normalizeText(details)}` : ""}`,
        );
      },
    });
  } catch (error) {
    return {
      available: false,
      reason:
        error instanceof Error
          ? error.message
          : "Unable to refresh managed global CLI tools for this run.",
    };
  }

  let codeq8Path = "";
  try {
    codeq8Path = await resolveCodeq8Path(commandEnv);
  } catch (error) {
    return {
      available: false,
      reason: extractErrorMessage(error),
    };
  }

  const chatHelpCheck = await runProcessCapture(codeq8Path, ["chat", "thread", "--help"], {
    cwd: workspacePath,
    env: commandEnv,
  });
  const chatHelpOutput =
    `${normalizeText(chatHelpCheck.stdout)}\n${normalizeText(chatHelpCheck.stderr)}`.trim();
  const githubIssueHelpCheck = await runProcessCapture(
    codeq8Path,
    ["github", "issue", "--help"],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );
  const githubIssueHelpOutput =
    `${normalizeText(githubIssueHelpCheck.stdout)}\n${normalizeText(githubIssueHelpCheck.stderr)}`.trim();
  const githubPrHelpCheck = await runProcessCapture(codeq8Path, ["github", "pr", "--help"], {
    cwd: workspacePath,
    env: commandEnv,
  });
  const githubPrHelpOutput =
    `${normalizeText(githubPrHelpCheck.stdout)}\n${normalizeText(githubPrHelpCheck.stderr)}`.trim();
  if (
    !chatHelpCheck.ok ||
    !chatHelpOutput.includes("chat thread list") ||
    !chatHelpOutput.includes("chat thread create") ||
    !chatHelpOutput.includes("chat thread send") ||
    !chatHelpOutput.includes("chat thread target-branch") ||
    !chatHelpOutput.includes("chat thread set-title") ||
    !githubIssueHelpCheck.ok ||
    !githubIssueHelpOutput.includes("github issue view") ||
    !githubIssueHelpOutput.includes("github issue create") ||
    !githubIssueHelpOutput.includes("github issue update") ||
    !githubIssueHelpOutput.includes("github issue comment") ||
    !githubPrHelpCheck.ok ||
    !githubPrHelpOutput.includes("github pr view") ||
    !githubPrHelpOutput.includes("github pr comment")
  ) {
    return {
      available: false,
      reason:
        "Installed codeq8 CLI does not support the required web chat thread and GitHub commands yet.",
    };
  }

  const githubToken = resolveWebChatGitHubWriteToken(commandEnv);
  if (!githubToken) {
    return {
      available: false,
      reason:
        "codeq8 CLI is installed, but the repository GitHub App token was unavailable for login.",
    };
  }

  const login = await runProcessCapture(
    codeq8Path,
    [
      "login",
      "--with-token",
      "--base-url",
      publicBaseUrl,
    ],
    {
      cwd: workspacePath,
      env: commandEnv,
      stdinText: `${githubToken}\n`,
    },
  );
  if (!login.ok) {
    return {
      available: false,
      reason:
        normalizeText(login.stderr) ||
        normalizeText(login.stdout) ||
        login.reason ||
        "Unable to authenticate codeq8 CLI for this run.",
    };
  }

  const status = await runProcessCapture(
    codeq8Path,
    [
      "auth",
      "status",
      "--json",
      "--base-url",
      publicBaseUrl,
    ],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );
  if (!status.ok) {
    return {
      available: false,
      reason:
        normalizeText(status.stderr) ||
        normalizeText(status.stdout) ||
        "codeq8 auth status failed after runner login.",
    };
  }

  let statusPayload = {};
  try {
    statusPayload = JSON.parse(normalizeText(status.stdout) || "{}");
  } catch (error) {
    return {
      available: false,
      reason: `codeq8 auth status returned invalid JSON: ${
        extractErrorMessage(error)
      }`,
    };
  }

  if (!statusPayload || typeof statusPayload !== "object" || Array.isArray(statusPayload)) {
    return {
      available: false,
      reason: "codeq8 auth status returned an invalid payload.",
    };
  }

  if (!statusPayload.authenticated) {
    return {
      available: false,
      reason: normalizeText(statusPayload.error) || "codeq8 auth status reported unauthenticated.",
    };
  }

  const authenticatedGithubLogin = normalizeText(statusPayload.github_login);
  const normalizedExpectedGithubLogin = normalizeText(expectedGithubLogin);
  if (
    normalizedExpectedGithubLogin &&
    authenticatedGithubLogin &&
    authenticatedGithubLogin !== normalizedExpectedGithubLogin
  ) {
    return {
      available: false,
      reason:
        `codeq8 auth status resolved ${authenticatedGithubLogin}, expected ` +
        `${normalizedExpectedGithubLogin}.`,
    };
  }

  return {
    available: true,
    binPath: codeq8Path,
    githubLogin: authenticatedGithubLogin,
  };
}

async function prepareChatGptAccountAuth({
  workerUrl,
  adminToken,
  codexHome,
  ownerGithubLogin,
  accountId,
}) {
  const normalizedOwnerGithubLogin = normalizeText(ownerGithubLogin);
  const normalizedAccountId = normalizeChatGptAccountId(accountId);
  if (!normalizedOwnerGithubLogin || !normalizedAccountId) {
    return {
      available: false,
      reason: "An assigned ChatGPT account is required for web chat runner auth.",
    };
  }

  await ensureDirectory(codexHome);
  const response = await workerJsonRequest({
    workerUrl,
    adminToken,
    path: "/chatgpt-accounts/get",
    method: "GET",
    query: new URLSearchParams({
      owner_github_login: normalizedOwnerGithubLogin,
      account_id: normalizedAccountId,
      include_bundle: "1",
    }),
  });
  const payload = normalizeObject(response.payload);
  const account = normalizeObject(payload.account);
  const bundle = normalizeObject(payload.bundle);
  const files = normalizeObject(bundle.files);
  if (
    !response.ok ||
    payload.ok === false ||
    !normalizeText(account.account_id) ||
    !normalizeText(files["auth.json"])
  ) {
    return {
      available: false,
      reason:
        normalizeText(payload.error || "") ||
        "The assigned ChatGPT account could not be loaded for this run.",
    };
  }

  for (const [relativePath, rawContents] of Object.entries(files)) {
    const normalizedRelativePath = normalizeCodexSessionRelativePath(relativePath);
    if (!normalizedRelativePath) {
      continue;
    }
    const targetPath = path.join(codexHome, normalizedRelativePath);
    await ensureDirectory(path.dirname(targetPath));
    await fs.writeFile(targetPath, String(rawContents ?? ""), "utf8");
  }

  return {
    available: true,
    accountId: normalizedAccountId,
    displayName: normalizeText(account.display_name || account.displayName || ""),
    email: normalizeText(account.email || ""),
  };
}

async function claimNextChatGptAccountForRunner({
  workerUrl,
  adminToken,
  ownerGithubLogin,
}) {
  const normalizedOwnerGithubLogin = normalizeText(ownerGithubLogin);
  if (!normalizedOwnerGithubLogin) {
    return {
      ok: false,
      status: 400,
      error: "A GitHub login is required to select a ChatGPT account.",
    };
  }

  const response = await workerJsonRequest({
    workerUrl,
    adminToken,
    path: "/chatgpt-accounts/selection/claim",
    method: "POST",
    body: {
      owner_github_login: normalizedOwnerGithubLogin,
    },
  });
  const payload = normalizeObject(response.payload);
  const account = normalizeObject(payload.account);
  const accountId = normalizeChatGptAccountId(
    account.account_id || account.accountId || "",
  );
  if (!response.ok || payload.ok === false) {
    return {
      ok: false,
      status: response.status,
      error:
        normalizeText(payload.error || "") ||
        `Unable to claim the next ChatGPT account (${response.status}).`,
    };
  }
  if (!accountId) {
    return {
      ok: false,
      status: 404,
      error: "Reconnect a ChatGPT account before starting a Codex run.",
    };
  }
  return {
    ok: true,
    status: response.status,
    accountId,
    displayName: normalizeText(account.display_name || account.displayName || ""),
    email: normalizeText(account.email || ""),
  };
}

async function syncChatGptAccountAuth({
  workerUrl,
  adminToken,
  codexHome,
  ownerGithubLogin,
  persistedAccountId = "",
  threadId = "",
  runId = "",
}) {
  const bundle = await readCodexAuthBundle(codexHome);
  const normalizedPersistedAccountId = normalizeChatGptAccountId(persistedAccountId);
  const response = await workerJsonRequest({
    workerUrl,
    adminToken,
    path: "/chatgpt-accounts/upsert",
    method: "POST",
    body: {
      thread_id: normalizeThreadId(threadId),
      run_id: normalizeRunId(runId),
      owner_github_login: normalizeText(ownerGithubLogin),
      account_id: normalizedPersistedAccountId || bundle.accountId,
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
  const payload = normalizeObject(response.payload);
  if (!response.ok || payload.ok === false) {
    throw new Error(
      normalizeText(payload.error || "") ||
        `Unable to persist ChatGPT account auth (${response.status}).`,
    );
  }
  return {
    bundle,
    accountId: normalizeChatGptAccountId(
      payload.account?.account_id ||
        payload.account?.accountId ||
        normalizedPersistedAccountId ||
        bundle.accountId,
    ),
  };
}

async function validateChatGptAccountAuth({
  codexPath,
  codexHome,
  workspacePath,
  commandEnv,
  timeoutSeconds = CHATGPT_ACCOUNT_AUTH_PRECHECK_TIMEOUT_SECONDS,
}) {
  const normalizedCodexPath = normalizeText(codexPath);
  const normalizedCodexHome = normalizeText(codexHome);
  const normalizedWorkspacePath = normalizeText(workspacePath);
  if (!normalizedCodexPath) {
    return {
      ok: false,
      reason: "codex executable was not found.",
      output: "",
      timedOut: false,
      reauthRequired: false,
    };
  }
  if (!normalizedCodexHome) {
    return {
      ok: false,
      reason: "CODEX_HOME is required to validate ChatGPT account auth.",
      output: "",
      timedOut: false,
      reauthRequired: false,
    };
  }

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(
      normalizedCodexPath,
      ["login", "status"],
      {
        cwd: normalizedWorkspacePath || process.cwd(),
        env: commandEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );

    const appendOutput = (target, chunk) => {
      const nextChunk = String(chunk || "");
      if (!nextChunk) {
        return target;
      }
      return truncate(`${target}${nextChunk}`, MAX_OUTPUT_CHARS);
    };

    const killChild = (signal) => {
      const pid = parsePositiveInteger(child.pid || 0, 0);
      if (!pid) {
        return;
      }
      try {
        if (process.platform !== "win32") {
          process.kill(-pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          // ignore best-effort kill failures
        }
      }
    };

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk || "");
      if (text) {
        stdout = appendOutput(stdout, text);
      }
    });

    child.stderr?.on("data", (chunk) => {
      const text = String(chunk || "");
      if (text) {
        stderr = appendOutput(stderr, text);
      }
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killChild("SIGTERM");
      setTimeout(() => {
        killChild("SIGKILL");
      }, 2000).unref();
    }, Math.max(5, Number(timeoutSeconds) || 0) * 1000);

    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      resolve({
        ok: false,
        reason: extractErrorMessage(error, "Unable to validate the assigned ChatGPT account."),
        output: truncate(`${stdout}\n${stderr}`.trim(), MAX_OUTPUT_CHARS),
        timedOut,
        reauthRequired: false,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeoutHandle);
      const combinedOutput = truncate(`${stdout}\n${stderr}`.trim(), MAX_OUTPUT_CHARS);
      if (!timedOut && code === 0) {
        resolve({
          ok: true,
          output: combinedOutput,
          timedOut: false,
          reauthRequired: false,
        });
        return;
      }
      const normalizedSignal = normalizeText(signal);
      const reauthRequired =
        isChatGptAccountReauthFailure(combinedOutput) ||
        /not logged in/i.test(combinedOutput);
      const reason = timedOut
        ? "Timed out validating the assigned ChatGPT account."
        : extractChatGptAccountReauthFailureReason(combinedOutput) ||
          truncate(
            combinedOutput ||
              `Codex login status exited with code ${Number.isFinite(Number(code)) ? Number(code) : "unknown"}${normalizedSignal ? ` (${normalizedSignal})` : ""}.`,
            1000,
          );
      resolve({
        ok: false,
        reason,
        output: combinedOutput,
        timedOut,
        reauthRequired,
      });
    });
  });
}

function isChatGptAccountReauthFailure(value) {
  const message = extractErrorMessage(value);
  if (!message) {
    return false;
  }
  return (
    /failed to refresh token/i.test(message) ||
    /refresh_token_reused/i.test(message) ||
    /access token could not be refreshed/i.test(message) ||
    /please try signing in again/i.test(message)
  );
}

async function markChatGptAccountReauthRequired({
  workerUrl,
  adminToken,
  ownerGithubLogin,
  accountId,
  error,
}) {
  const response = await workerJsonRequest({
    workerUrl,
    adminToken,
    path: "/chatgpt-accounts/reauth-required",
    method: "POST",
    body: {
      owner_github_login: normalizeText(ownerGithubLogin),
      account_id: normalizeChatGptAccountId(accountId),
      error: extractErrorMessage(error),
    },
  });
  const payload = normalizeObject(response.payload);
  if (!response.ok || payload.ok === false) {
    throw new Error(
      normalizeText(payload.error || "") ||
        `Unable to mark the ChatGPT account for reauthentication (${response.status}).`,
    );
  }
}

async function recoverFromChatGptAccountReauthFailure({
  workerUrl,
  adminToken,
  ownerGithubLogin,
  accountId,
  error,
  recoveryCount,
}) {
  const normalizedOwnerGithubLogin = normalizeText(ownerGithubLogin);
  const normalizedAccountId = normalizeChatGptAccountId(accountId);
  await markChatGptAccountReauthRequired({
    workerUrl,
    adminToken,
    ownerGithubLogin: normalizedOwnerGithubLogin,
    accountId: normalizedAccountId,
    error,
  });
  log(
    "Marked ChatGPT account for reauthentication during web chat run",
    `account_id=${normalizedAccountId} owner=${normalizedOwnerGithubLogin}`,
  );

  const nextRecoveryCount = Number(recoveryCount) + 1;
  if (nextRecoveryCount > MAX_CHATGPT_ACCOUNT_RECOVERY_ATTEMPTS) {
    return {
      ok: false,
      error:
        "Too many ChatGPT account reauthentication failures happened in one run. Reconnect the failing accounts, then retry.",
    };
  }

  const nextAccountClaim = await claimNextChatGptAccountForRunner({
    workerUrl,
    adminToken,
    ownerGithubLogin: normalizedOwnerGithubLogin,
  });
  if (
    !nextAccountClaim.ok ||
    !normalizeChatGptAccountId(nextAccountClaim.accountId) ||
    normalizeChatGptAccountId(nextAccountClaim.accountId) === normalizedAccountId
  ) {
    return {
      ok: false,
      error:
        nextAccountClaim.ok
          ? extractErrorMessage(error) ||
            "The assigned ChatGPT account needs to be reconnected."
          : nextAccountClaim.error ||
            extractErrorMessage(error) ||
            "The assigned ChatGPT account needs to be reconnected.",
    };
  }

  return {
    ok: true,
    nextAccountId: nextAccountClaim.accountId,
    recoveryCount: nextRecoveryCount,
  };
}

async function finalizeChatGptAccountAuth({
  workerUrl,
  adminToken,
  codexHome,
  ownerGithubLogin,
  accountId,
  threadId = "",
  runId = "",
  runError = null,
}) {
  const normalizedAccountId = normalizeChatGptAccountId(accountId);
  if (isChatGptAccountReauthFailure(runError)) {
    await markChatGptAccountReauthRequired({
      workerUrl,
      adminToken,
      ownerGithubLogin,
      accountId: normalizedAccountId,
      error: runError,
    });
    return {
      accountId: normalizedAccountId,
      status: "reauth_required",
    };
  }

  const synced = await syncChatGptAccountAuth({
    workerUrl,
    adminToken,
    codexHome,
    ownerGithubLogin,
    persistedAccountId: normalizedAccountId,
    threadId,
    runId,
  });
  return {
    accountId: synced.accountId || normalizedAccountId,
    status: "synced",
  };
}

function buildCodexPrompt({
  repository,
  threadTitle,
  threadId,
  sourceType,
  branchContext,
  workspacePersistenceState = null,
  priorMessages,
  threadSpecText = "",
  promptText,
  recentChecksPromptText = "",
  codeq8Cli,
  attachments = [],
  referencedThreads = [],
}) {
  const promptLines = Array.isArray(priorMessages)
    ? priorMessages.map((message) => toPromptMessageLine(message)).filter(Boolean)
    : [];
  const normalizedSourceType = normalizeText(sourceType).toLowerCase();
  const protectedBranches = parseBranchList(branchContext.protected_branches || []);
  const promptBaseBranch =
    normalizeText(branchContext.pull_request_base_branch) ||
    normalizeText(branchContext.base_branch) ||
    normalizeText(branchContext.default_branch);
  const currentWorkingBranch =
    normalizeText(workspacePersistenceState?.branch) ||
    normalizeText(branchContext.pull_request_head_branch) ||
    normalizeText(branchContext.write_branch) ||
    normalizeText(branchContext.context_branch);
  const normalizedThreadSpecText = normalizePromptBlockText(threadSpecText);
  const normalizedPromptText = stripLeadingThreadSpecPromptText(
    promptText,
    normalizedThreadSpecText,
  );
  const lines = [
    "You are Codex responding inside the Codeq8 web chat runner.",
    `Workspace repository: ${normalizeText(repository)}.`,
    `Thread title: ${normalizeText(threadTitle) || "New thread"}.`,
    `Thread source type: ${normalizeText(sourceType) || "default_branch"}.`,
    `Context branch: ${normalizeText(branchContext.context_branch) || "<unknown>"}.`,
    `Write mode: ${normalizeText(branchContext.write_mode) || "<unknown>"}.`,
    `Working branch: ${normalizeText(branchContext.write_branch) || "<none yet>"}.`,
    `Base branch: ${normalizeText(branchContext.base_branch) || "<none>"}.`,
    `Default branch: ${normalizeText(branchContext.default_branch) || "<unknown>"}.`,
    `Protected branches: ${protectedBranches.length > 0 ? protectedBranches.join(", ") : "<none>"}.`,
  ];

  if (normalizeText(branchContext.production_branch)) {
    lines.push(`Production branch: ${normalizeText(branchContext.production_branch)}.`);
  }
  if (branchContext.pull_request_number > 0) {
    lines.push(`Linked pull request: #${branchContext.pull_request_number}.`);
  }
  if (normalizeText(branchContext.pull_request_url)) {
    lines.push(`Pull request URL: ${normalizeText(branchContext.pull_request_url)}.`);
  }

  if (normalizedThreadSpecText) {
    lines.push("");
    lines.push("Thread spec:");
    lines.push(normalizedThreadSpecText);
  }

  lines.push("");
  lines.push("Branch policy instructions:");
  if (normalizeText(branchContext.write_mode) === "branch_and_pr") {
    lines.push(
      `- Never push directly to ${normalizeText(branchContext.base_branch) || normalizeText(branchContext.default_branch)} or any protected branch.`,
    );
    if (normalizeBranchName(branchContext.write_branch)) {
      lines.push(
        `- This thread is already associated with branch ${normalizeText(branchContext.write_branch)}; keep working there unless you intentionally switch the thread to a different branch.`,
      );
      lines.push(
        `- Treat changes for ${normalizeText(branchContext.base_branch) || normalizeText(branchContext.default_branch)} as pull-request work on ${normalizeText(branchContext.write_branch)}; do not treat the protected base branch as a blocker.`,
      );
    } else {
      lines.push(
        `- Start from the checked-out context branch ${normalizeText(workspacePersistenceState?.branch) || normalizeText(branchContext.context_branch) || normalizeText(branchContext.base_branch) || normalizeText(branchContext.default_branch)}.`,
      );
      lines.push(
        `- Treat changes for ${normalizeText(branchContext.base_branch) || normalizeText(branchContext.default_branch)} as pull-request work; if the task needs repo changes, branch first instead of stopping because the base branch is protected.`,
      );
      lines.push(
        "- Before making repo changes, create and switch to a normal git branch with a human-readable name.",
      );
      lines.push(
        "- Do the work on that branch and push it at the checkpoints that make sense for the user's request, and before you finish, so the runner can remember it for this thread and open or update the PR.",
      );
    }
  } else {
    lines.push(`- Writes are allowed directly on ${normalizeText(branchContext.write_branch)}.`);
    lines.push(
      `- Keep working on the checked-out branch ${normalizeText(workspacePersistenceState?.branch) || normalizeText(branchContext.write_branch) || normalizeText(branchContext.context_branch)}.`,
    );
  }
  if (normalizedSourceType === "pull_request") {
    lines.push(
      `- This thread is pinned to PR #${branchContext.pull_request_number || "?"}; keep working on the PR head branch ${normalizeText(branchContext.pull_request_head_branch) || normalizeText(branchContext.context_branch)}.`,
    );
    lines.push(
      `- If the user asks to merge or rebase ${normalizeText(branchContext.pull_request_base_branch) || normalizeText(branchContext.base_branch) || normalizeText(branchContext.default_branch)} into this PR, do that on the checked-out PR head branch. Do not retarget the thread and do not switch to the base branch.`,
    );
  }
  if (
    promptBaseBranch &&
    currentWorkingBranch &&
    normalizeBranchName(promptBaseBranch) &&
    normalizeBranchName(currentWorkingBranch) &&
    normalizeBranchName(promptBaseBranch) !== normalizeBranchName(currentWorkingBranch) &&
    ((normalizeText(branchContext.write_mode) === "branch_and_pr" &&
      Boolean(normalizeBranchName(branchContext.write_branch))) ||
      normalizedSourceType === "pull_request")
  ) {
    lines.push(
      `- Keep working on ${currentWorkingBranch}; do not merge or rebase ${promptBaseBranch} into it unless the user explicitly asks for that branch update.`,
    );
  }
  lines.push(
    "- Normal git commits and pushes on the checked-out working branch are allowed when they match the thread policy.",
  );
  lines.push(
    "- Never push the base branch, default branch, or any protected branch directly.",
  );
  lines.push(...buildLoopStylePromptLines());
  lines.push(
    "- If you make repo changes that should be kept, create normal git commits with concise human-readable subjects at the checkpoints that make sense for the user's request, and make sure kept work is committed before you finish.",
  );
  lines.push(
    ...buildRunnerGitOwnershipPromptLines({
      branch:
        workspacePersistenceState?.branch ||
        branchContext.write_branch ||
        branchContext.pull_request_head_branch ||
        branchContext.context_branch,
    }),
  );
  lines.push(
    "- If the user asks whether changes were pushed, answer from the runner workspace state below, not from stale memory about earlier local-only changes.",
  );
  lines.push(
    "- Prefer already-fetched local refs like origin/main over repeated remote verification when they are sufficient for the task.",
  );
  lines.push(
    "- Any remote git command must be bounded and attempted at most once. If fetch or ls-remote stalls or times out, stop and report the blocker instead of waiting indefinitely.",
  );
  lines.push("- Provide a concise final answer describing what changed or what blocked the work.");
  if (codeq8Cli?.available) {
    lines.push("");
    lines.push("Tooling priority:");
    lines.push(
      `- The codeq8 CLI is installed and authenticated with this run's repository GitHub App token for thread ${normalizeText(threadId)}. Use it as the default interface for Codeq8, GitHub, thread, and run work in this repo.`,
    );
    lines.push(
      "- Before reaching for `gh`, web search, or ad-hoc API calls, check whether `codeq8` already covers the task.",
    );
    lines.push(
      "- If an equivalent `codeq8` command exists, use `codeq8` first and treat bypassing it as a mistake.",
    );
    lines.push(
      "- Do not treat missing `gh` auth as a blocker until you have checked the equivalent `codeq8` command.",
    );
  }
  if (codeq8Cli?.available) {
    lines.push("");
    lines.push("Codeq8 CLI:");
    lines.push(
      `- The codeq8 CLI is installed and authenticated with this run's repository GitHub App token for thread ${normalizeText(threadId)}.`,
    );
    lines.push(
      "- Use `codeq8 --help` to discover the available capability buckets.",
    );
    lines.push(
      "- Use `codeq8 github --help`, `codeq8 chat --help`, `codeq8 run --help`, and `codeq8 repo --help` to inspect what exists in each bucket.",
    );
    lines.push(
      "- Use deeper help like `codeq8 github issue --help`, `codeq8 github pr --help`, or `codeq8 chat thread --help` to learn exact syntax before invoking a command you have not used yet.",
    );
    lines.push(
      "- Prefer the Codeq8 CLI over gh when equivalent functionality exists there.",
    );
    lines.push(
      "- All GitHub issue and pull request interactions should go through `codeq8 github`.",
    );
    lines.push(
      "- When the user asks you to inspect or act on a GitHub issue, pull request, or GitHub URL, start with `codeq8 github` instead of web search or `gh`.",
    );
    lines.push(
      "- GitHub issue and pull request operations live under `codeq8 github`.",
    );
    lines.push(
      "- For checks, runs, and execution history, inspect `codeq8 run --help` before falling back to other tooling.",
    );
    lines.push(
      "- Thread listing, creation, messaging, inspection, and retargeting live under `codeq8 chat thread`; use `codeq8 chat thread --help` to discover the available thread operations.",
    );
    lines.push(
      "- If the user mentions another Codeq8 thread URL or thread id, inspect it with `codeq8 chat thread show <thread-id>` and `codeq8 chat thread messages <thread-id> --json` instead of claiming you cannot read it.",
    );
    lines.push(
      "- Do not guess branch names or PR numbers when retargeting the thread. This does not prevent you from creating a normal git working branch yourself when the branch policy requires one.",
    );
    lines.push(
      "- If you retarget the thread, do not make repository changes in the old context. Stop immediately after the thread target update and briefly note what changed; the runner will restart this same user request on the new branch or PR context.",
    );
  }

  if (workspacePersistenceState) {
    lines.push("");
    lines.push("Runner workspace state before this turn:");
    lines.push(
      `- Checked-out branch: ${normalizeText(workspacePersistenceState.branch) || "<unknown>"}.`,
    );
    lines.push(
      workspacePersistenceState.hasWorkingTreeChanges
        ? "- The working tree currently has local modifications."
        : "- The working tree is currently clean.",
    );
    if (workspacePersistenceState.hasRemoteBranch) {
      lines.push(
        workspacePersistenceState.aheadCount > 0
          ? `- There are ${workspacePersistenceState.aheadCount} local commit(s) ahead of origin/${normalizeText(workspacePersistenceState.branch)}.`
          : `- There are no local commits ahead of origin/${normalizeText(workspacePersistenceState.branch)}.`,
      );
    } else {
      lines.push("- The working branch does not exist on origin yet.");
    }
    lines.push(
      "- This current runner workspace state overrides any earlier statement you made about changes being only local or already pushed.",
    );
  }

  if (promptLines.length > 0) {
    lines.push("");
    lines.push("Prior chat context (oldest to newest):");
    lines.push(...promptLines);
  }

  lines.push(...buildAttachmentPromptLines(attachments));
  lines.push(...buildReferencedThreadPromptLines(referencedThreads));
  const normalizedRecentChecksPromptText = normalizeText(recentChecksPromptText);
  if (normalizedRecentChecksPromptText) {
    lines.push("");
    lines.push(...normalizedRecentChecksPromptText.split(/\r?\n/g));
  }

  lines.push("");
  lines.push("User message:");
  lines.push(normalizedPromptText || "(no prompt text)");

  return lines.join("\n").trim();
}

function buildResumePrompt({
  repository = "",
  sourceType = "",
  branchContext = {},
  workspacePersistenceState = null,
  threadSpecText = "",
  promptText,
  recentUserMessagesPromptText = "",
  recentChecksPromptText = "",
  attachments = [],
  referencedThreads = [],
  targetShift = null,
}) {
  const normalizedThreadSpecText = normalizePromptBlockText(threadSpecText);
  const normalizedPromptText = stripLeadingThreadSpecPromptText(
    promptText,
    normalizedThreadSpecText,
  );
  const lines = [];
  if (targetShift) {
    lines.push("Thread context update:");
    lines.push(
      `- Continue this same conversation in ${normalizeText(repository) || "the current repository"}.`,
    );
    if (normalizeText(sourceType).toLowerCase() === "pull_request") {
      lines.push(
        `- The thread is now pinned to PR #${branchContext.pull_request_number || "?"} on head branch ${normalizeText(branchContext.pull_request_head_branch) || normalizeText(branchContext.context_branch)} with base ${normalizeText(branchContext.pull_request_base_branch) || normalizeText(branchContext.base_branch) || normalizeText(branchContext.default_branch)}.`,
      );
    } else if (normalizeText(branchContext.context_branch)) {
      lines.push(
        `- The thread now targets branch ${normalizeText(branchContext.context_branch)}.`,
      );
    }
    lines.push(
      "- Do not use the previous branch target. Continue from the existing conversation state with this updated thread target.",
    );
    lines.push("");
  }
  if (normalizedThreadSpecText) {
    lines.push("Thread spec:");
    lines.push(normalizedThreadSpecText);
    lines.push("");
  }
  if (workspacePersistenceState) {
    lines.push("Runner workspace state before this turn:");
    lines.push(
      `- Checked-out branch: ${normalizeText(workspacePersistenceState.branch) || "<unknown>"}.`,
    );
    lines.push(
      workspacePersistenceState.hasWorkingTreeChanges
        ? "- The working tree currently has local modifications."
        : "- The working tree is currently clean.",
    );
    if (workspacePersistenceState.hasRemoteBranch) {
      lines.push(
        workspacePersistenceState.aheadCount > 0
          ? `- There are ${workspacePersistenceState.aheadCount} local commit(s) ahead of origin/${normalizeText(workspacePersistenceState.branch)}.`
          : `- There are no local commits ahead of origin/${normalizeText(workspacePersistenceState.branch)}.`,
      );
    } else {
      lines.push("- The working branch does not exist on origin yet.");
    }
    lines.push(
      "- Normal git commits and pushes on the checked-out working branch are allowed when they match the thread policy.",
    );
    lines.push(
      "- If you make repo changes that should be kept, create normal git commits with concise human-readable subjects at the checkpoints that make sense for the user's request, and make sure kept work is committed before you finish.",
    );
    lines.push(...buildLoopStylePromptLines());
    lines.push(
      ...buildRunnerGitOwnershipPromptLines({
        branch:
          workspacePersistenceState.branch ||
          branchContext.write_branch ||
          branchContext.pull_request_head_branch ||
          branchContext.context_branch,
      }),
    );
    lines.push(
      "- This current runner workspace state overrides any earlier statement you made about changes being only local or already pushed.",
    );
    lines.push("");
  }
  lines.push("");
  lines.push(...buildAttachmentPromptLines(attachments));
  lines.push(...buildReferencedThreadPromptLines(referencedThreads));
  const normalizedRecentUserMessagesPromptText = normalizeText(recentUserMessagesPromptText);
  if (normalizedRecentUserMessagesPromptText) {
    lines.push("");
    lines.push(...normalizedRecentUserMessagesPromptText.split(/\r?\n/g));
  }
  const normalizedRecentChecksPromptText = normalizeText(recentChecksPromptText);
  if (normalizedRecentChecksPromptText) {
    lines.push("");
    lines.push(...normalizedRecentChecksPromptText.split(/\r?\n/g));
  }
  lines.push("");
  lines.push("User message:");
  lines.push(normalizedPromptText || "(no prompt text)");

  return lines.join("\n").trim();
}

async function resolveCodexPath(commandEnv) {
  const explicit = normalizeText(commandEnv.CODEX_PATH || process.env.CODEX_PATH);
  if (explicit && (await isExecutableFile(explicit))) {
    return explicit;
  }

  const homeDirectory = normalizeText(process.env.HOME || os.homedir());
  const candidates = [
    homeDirectory ? path.join(homeDirectory, ".local", "bin", "codex") : "",
    "/opt/homebrew/bin/codex",
  ];
  for (const candidate of candidates) {
    const normalized = normalizeText(candidate);
    if (normalized && (await isExecutableFile(normalized))) {
      return normalized;
    }
  }

  const whichResult = await runProcessCapture("/bin/bash", ["-lc", "command -v codex"], {
    cwd: process.cwd(),
    env: commandEnv,
  });
  if (whichResult.ok) {
    const resolved = normalizeText(whichResult.stdout);
    if (resolved && (await isExecutableFile(resolved))) {
      return resolved;
    }
  }

  throw new Error("codex executable was not found. Install codex or set CODEX_PATH.");
}

async function listCodexSessionEntries(codexHome) {
  const normalizedCodexHome = normalizeText(codexHome);
  if (!normalizedCodexHome) {
    return [];
  }

  const sessionsRoot = path.join(normalizedCodexHome, "sessions");
  if (!(await pathExists(sessionsRoot))) {
    return [];
  }

  const sessionEntries = [];
  const pending = [sessionsRoot];
  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath) {
      continue;
    }
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = await fs.stat(entryPath);
      const relativePath = normalizeCodexSessionRelativePath(
        path.relative(normalizedCodexHome, entryPath),
      );
      if (!relativePath) {
        continue;
      }
      sessionEntries.push({
        path: entryPath,
        relativePath,
        mtimeMs: Number(stat.mtimeMs || 0),
      });
    }
  }

  return sessionEntries;
}

async function snapshotCodexSessionFiles(codexHome) {
  const snapshot = new Map();
  const sessionEntries = await listCodexSessionEntries(codexHome);
  for (const entry of sessionEntries) {
    snapshot.set(entry.relativePath, entry.mtimeMs);
  }
  return snapshot;
}

async function createWebChatRunRuntime(threadId) {
  const prefix =
    normalizeText(threadId).toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "chat-thread";
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), `codeq8-web-chat-${prefix}-`));
  const codexHome = path.join(homePath, ".codex");
  await ensureDirectory(codexHome);
  const sessionFileSnapshot = await snapshotCodexSessionFiles(codexHome);
  return {
    homePath,
    codexHome,
    sessionFileSnapshot,
  };
}

async function cleanupWebChatRunRuntime(runRuntime) {
  if (!runRuntime?.homePath) {
    return;
  }
  try {
    await fs.rm(runRuntime.homePath, { recursive: true, force: true });
  } catch (cleanupError) {
    log(
      "ERROR",
      `Unable to clean web chat runtime directory: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`,
    );
  }
}

async function readCodexSessionBundle({
  codexHome,
  sessionFilePath,
  fallbackCliVersion = "",
  fallbackModel = "",
}) {
  const normalizedCodexHome = path.resolve(codexHome);
  const normalizedSessionFilePath = path.resolve(sessionFilePath);
  const relativePath = normalizeCodexSessionRelativePath(
    path.relative(normalizedCodexHome, normalizedSessionFilePath),
  );
  if (!relativePath) {
    throw new Error("Unable to resolve relative Codex session file path.");
  }

  const sessionFileContents = await fs.readFile(normalizedSessionFilePath, "utf8");
  const parsedBundle = parseCodexSessionBundleContents({
    sessionFileContents,
    fallbackCliVersion,
    fallbackModel,
  });

  return {
    ...parsedBundle,
    sessionFileRelativePath: relativePath,
    sessionFileContents,
  };
}

function parseCodexSessionBundleContents({
  sessionFileContents = "",
  fallbackCliVersion = "",
  fallbackModel = "",
}) {
  const normalizedContents = String(sessionFileContents || "");
  const trimmedContents = normalizedContents.trim();
  if (!trimmedContents) {
    throw new Error("Codex session file is empty.");
  }
  if (trimmedContents.startsWith("{")) {
    try {
      const parsedEnvelope = normalizeObject(JSON.parse(trimmedContents));
      if (
        normalizeText(parsedEnvelope.scope) === "web_chat_codex_session_bundle" &&
        normalizeText(parsedEnvelope.ciphertext) &&
        normalizeText(parsedEnvelope.iv)
      ) {
        throw new Error(
          "Stored Codex session bundle is still wrapped in the encrypted storage envelope.",
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        /wrapped in the encrypted storage envelope/i.test(error.message)
      ) {
        throw error;
      }
    }
  }

  const lines = sessionFileContents.split(/\r?\n/g).filter(Boolean);
  let firstLinePayload = {};
  try {
    firstLinePayload = normalizeObject(JSON.parse(lines[0]));
  } catch (error) {
    throw new Error(
      `Unable to parse Codex session metadata: ${
        extractErrorMessage(error)
      }`,
    );
  }

  const eventType = normalizeText(firstLinePayload.type).toLowerCase();
  if (eventType !== "session_meta") {
    throw new Error("Stored Codex session bundle is not a valid Codex session file.");
  }

  const metaPayload = normalizeObject(firstLinePayload.payload);
  const sessionId = normalizeCodexSessionId(metaPayload.id || firstLinePayload.id);
  if (!sessionId) {
    throw new Error("Unable to resolve Codex session id from session file.");
  }

  let lastCompactionObservedAt = 0;
  for (const line of lines) {
    let parsedLine = null;
    try {
      parsedLine = JSON.parse(line);
    } catch {
      continue;
    }
    const parsedObject = normalizeObject(parsedLine);
    const eventType = normalizeText(parsedObject.type).toLowerCase();
    if (!CODEX_SESSION_COMPACTION_TYPES.has(eventType)) {
      continue;
    }
    lastCompactionObservedAt = Math.max(
      lastCompactionObservedAt,
      parseTimestampMs(parsedObject.timestamp || normalizeObject(parsedObject.payload).timestamp),
    );
  }

  return {
    sessionId,
    cliVersion: normalizeText(metaPayload.cli_version || fallbackCliVersion),
    model: normalizeText(metaPayload.model || fallbackModel),
    lastCompactionObservedAt,
  };
}

async function restoreCodexSessionBundle({
  codexHome,
  sessionFileRelativePath,
  sessionFileContents,
}) {
  const normalizedRelativePath = normalizeCodexSessionRelativePath(sessionFileRelativePath);
  if (!normalizedRelativePath) {
    throw new Error("Codex session_file_relative_path is required for resume.");
  }
  const targetPath = path.join(codexHome, normalizedRelativePath);
  await ensureDirectory(path.dirname(targetPath));
  await fs.writeFile(targetPath, String(sessionFileContents || ""), "utf8");
  return targetPath;
}

async function captureCodexSessionBundle({
  codexHome,
  existingSessionState,
  model,
  sessionFileSnapshot = null,
  runStartedAt = 0,
}) {
  const normalizedExistingState = normalizeCodexSessionState(existingSessionState);
  let sessionFilePath = "";
  if (normalizedExistingState.session_file_relative_path) {
    const explicitSessionFilePath = path.join(
      codexHome,
      normalizedExistingState.session_file_relative_path,
    );
    if (await isFile(explicitSessionFilePath)) {
      sessionFilePath = explicitSessionFilePath;
    }
  }
  if (!sessionFilePath) {
    const sessionEntries = await listCodexSessionEntries(codexHome);
    const normalizedRunStartedAt = Math.max(0, Number(runStartedAt) || 0);
    const priorSnapshot =
      sessionFileSnapshot instanceof Map ? sessionFileSnapshot : new Map();
    const candidateEntries = sessionEntries.filter((entry) => {
      if (priorSnapshot.size > 0) {
        const previousMtime = Number(priorSnapshot.get(entry.relativePath) || 0);
        if (!previousMtime) {
          return true;
        }
        return entry.mtimeMs > previousMtime;
      }
      return normalizedRunStartedAt > 0 && entry.mtimeMs >= normalizedRunStartedAt;
    });
    const orderedEntries =
      candidateEntries.length > 0 ? candidateEntries : sessionEntries;
    orderedEntries.sort((left, right) => right.mtimeMs - left.mtimeMs);
    sessionFilePath = orderedEntries[0]?.path || "";
  }
  if (!sessionFilePath) {
    throw new Error("Codex run finished without creating a session bundle.");
  }
  return readCodexSessionBundle({
    codexHome,
    sessionFilePath,
    fallbackCliVersion: normalizedExistingState.cli_version,
    fallbackModel: model,
  });
}

async function runCodex({
  codexPath,
  model,
  task,
  workspacePath,
  commandEnv,
  timeoutSeconds,
  mode = "fresh",
  sessionId = "",
  outputFilePath = "",
}) {
  const normalizedModel = normalizeText(model) || DEFAULT_CODEX_MODEL;
  const normalizedTask = normalizeText(task);
  const normalizedMode = normalizeText(mode).toLowerCase() === "resume" ? "resume" : "fresh";
  const normalizedSessionId = normalizeCodexSessionId(sessionId);
  const reasoningEffortConfig = `model_reasoning_effort="${DEFAULT_CODEX_REASONING_EFFORT}"`;
  if (!normalizedTask) {
    return {
      ok: false,
      output: "",
      diagnosticOutput: "",
      reason: "Prompt is empty.",
      exitCode: -1,
      signal: "none",
      timedOut: false,
      durationMs: 0,
    };
  }
  if (normalizedMode === "resume" && !normalizedSessionId) {
    return {
      ok: false,
      output: "",
      diagnosticOutput: "",
      reason: "Codex session id is required for resume mode.",
      exitCode: -1,
      signal: "none",
      timedOut: false,
      durationMs: 0,
    };
  }

  const resolvedOutputFilePath =
    path.resolve(outputFilePath || path.join(workspacePath, ".codeq8-last-message.txt"));
  await ensureDirectory(path.dirname(resolvedOutputFilePath));
  await fs.rm(resolvedOutputFilePath, { force: true }).catch(() => {});

  return new Promise((resolve) => {
    const startMs = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let chatGptAccountReauthRequired = false;
    let chatGptAccountFailureReason = "";
    const args = [
      "exec",
      "--model",
      normalizedModel,
      "--config",
      reasoningEffortConfig,
      "--disable",
      "multi_agent",
      "--disable",
      "sqlite",
      "--output-last-message",
      resolvedOutputFilePath,
      "--yolo",
    ];
    if (normalizedMode === "resume") {
      args.push("resume", normalizedSessionId, normalizedTask);
    } else {
      args.push(normalizedTask);
    }

    const child = spawn(
      codexPath,
      args,
      {
        cwd: workspacePath,
        env: commandEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );

    const appendOutput = (target, chunk) => {
      const nextChunk = String(chunk || "");
      if (!nextChunk) {
        return target;
      }
      return truncate(`${target}${nextChunk}`, MAX_OUTPUT_CHARS * 2);
    };

    const abortForChatGptAccountFailure = () => {
      if (chatGptAccountReauthRequired) {
        return;
      }
      const combinedOutput = `${stdout}\n${stderr}`;
      if (!isChatGptAccountReauthFailure(combinedOutput)) {
        return;
      }
      chatGptAccountReauthRequired = true;
      chatGptAccountFailureReason =
        extractChatGptAccountReauthFailureReason(combinedOutput) ||
        "The assigned ChatGPT account needs to be reconnected. Reconnect that account or add another one, then retry.";
      killChild("SIGTERM");
      setTimeout(() => {
        killChild("SIGKILL");
      }, 2000).unref();
    };

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk || "");
      if (text) {
        process.stdout.write(text);
        stdout = appendOutput(stdout, text);
        abortForChatGptAccountFailure();
      }
    });

    child.stderr?.on("data", (chunk) => {
      const text = String(chunk || "");
      if (text) {
        process.stderr.write(text);
        stderr = appendOutput(stderr, text);
        abortForChatGptAccountFailure();
      }
    });

    const killChild = (signal) => {
      const pid = parsePositiveInteger(child.pid || 0, 0);
      if (!pid) {
        return;
      }
      try {
        if (process.platform !== "win32") {
          process.kill(-pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          // ignore best-effort kill failures
        }
      }
    };

    const timeoutMs = Math.max(30, timeoutSeconds) * 1000;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killChild("SIGTERM");
      setTimeout(() => {
        killChild("SIGKILL");
      }, 8000).unref();
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      resolve({
        ok: false,
        output: "",
        diagnosticOutput: truncate(`${stdout}\n${stderr}`.trim(), MAX_OUTPUT_CHARS),
        reason: extractErrorMessage(error),
        exitCode: -1,
        signal: "spawn_error",
        timedOut,
        durationMs: Date.now() - startMs,
      });
    });

    child.on("close", async (code, signal) => {
      clearTimeout(timeoutHandle);
      const durationMs = Date.now() - startMs;
      let lastMessageOutput = "";
      try {
        if (await isFile(resolvedOutputFilePath)) {
          lastMessageOutput = normalizeText(await fs.readFile(resolvedOutputFilePath, "utf8"));
        }
      } catch {
        lastMessageOutput = "";
      }
      const trimmedCombined = normalizeText(`${stdout}\n${stderr}`);
      const output = truncate(lastMessageOutput, MAX_OUTPUT_CHARS);
      const diagnosticOutput = truncate(trimmedCombined, MAX_OUTPUT_CHARS);
      if (chatGptAccountReauthRequired) {
        resolve({
          ok: false,
          output,
          diagnosticOutput,
          reason: chatGptAccountFailureReason,
          exitCode: Number.isFinite(code) ? Number(code) : -1,
          signal: signal || "",
          timedOut: false,
          durationMs,
          chatGptAccountReauthRequired: true,
        });
        return;
      }
      if (code === 0 && !timedOut) {
        resolve({
          ok: true,
          output,
          diagnosticOutput,
          reason: "",
          exitCode: 0,
          signal: signal || "",
          timedOut: false,
          durationMs,
          chatGptAccountReauthRequired: false,
        });
        return;
      }

      const reason = timedOut
        ? `Codex timed out after ${Math.floor(timeoutMs / 1000)} seconds.`
        : `Codex exited with code=${Number.isFinite(code) ? code : "null"} signal=${signal || "none"}.`;
      resolve({
        ok: false,
        output,
        diagnosticOutput,
        reason,
        exitCode: Number.isFinite(code) ? Number(code) : -1,
        signal: signal || "",
        timedOut,
        durationMs,
        chatGptAccountReauthRequired: false,
      });
    });
  });
}

async function workingTreeHasChanges({ workspacePath, commandEnv }) {
  const status = await runProcessCapture("git", ["status", "--porcelain"], {
    cwd: workspacePath,
    env: commandEnv,
  });
  if (!status.ok) {
    throw new Error("Unable to inspect git working tree.");
  }
  return normalizeText(status.stdout).length > 0;
}

async function branchAheadCount({ workspacePath, commandEnv, branch }) {
  const divergence = await readBranchDivergenceCounts({
    workspacePath,
    commandEnv,
    branch,
  });
  return divergence.ahead;
}

function summarizeGitProcessFailure(result) {
  const stdout = normalizeText(result?.stdout);
  const stderr = normalizeText(result?.stderr);
  return stderr || stdout || `git exited with code ${result?.code ?? -1}`;
}

async function clearGitOperationState({ workspacePath, commandEnv }) {
  const bestEffortAbortCommands = [
    ["rebase", "--abort"],
    ["merge", "--abort"],
    ["cherry-pick", "--abort"],
    ["revert", "--abort"],
    ["am", "--abort"],
  ];

  for (const args of bestEffortAbortCommands) {
    await runProcessCapture("git", args, {
      cwd: workspacePath,
      env: commandEnv,
    }).catch(() => {});
  }

  await runProcessCapture("git", ["reset", "--hard", "HEAD"], {
    cwd: workspacePath,
    env: commandEnv,
  }).catch(() => {});
}

function workspaceStateChangedSinceBaseline({
  baselineState = null,
  currentState = null,
}) {
  const baseline = baselineState || {};
  const current = currentState || {};
  return (
    normalizeText(current.headCommitSha) !== normalizeText(baseline.headCommitSha) ||
    normalizeText(current.statusFingerprint) !== normalizeText(baseline.statusFingerprint)
  );
}

function isRememberedThreadBranch({
  branch = "",
  writeMode = "",
  baseBranch = "",
  protectedBranches = [],
}) {
  const normalizedBranch = normalizeBranchName(branch);
  if (!normalizedBranch) {
    return false;
  }
  if (normalizeText(writeMode) === "direct_push") {
    return true;
  }
  return !isProtectedBranch(normalizedBranch, [...protectedBranches, baseBranch]);
}

function describeWorkspacePersistence({
  branch = "",
  pushed = false,
  pullRequestUrl = "",
  pendingRemoteSync = "",
  skippedProtectedBranch = "",
} = {}) {
  const normalizedBranch = normalizeBranchName(branch);
  const parts = [];
  if (pushed) {
    parts.push(`Codeq8 pushed branch ${normalizedBranch || "the working branch"}.`);
  }
  if (normalizeText(pendingRemoteSync)) {
    parts.push(normalizeText(pendingRemoteSync));
  }
  if (normalizeBranchName(skippedProtectedBranch)) {
    parts.push(
      `Codex left repo changes on protected branch ${normalizeBranchName(skippedProtectedBranch)}. Move the work to a normal git branch before finishing.`,
    );
  }
  if (normalizeText(pullRequestUrl)) {
    parts.push(`PR: ${normalizeText(pullRequestUrl)}.`);
  }
  return parts.join(" ");
}

async function branchHasCommitsAgainstBase({
  workspacePath,
  commandEnv,
  branch,
  baseBranch,
}) {
  const normalizedBranch = normalizeBranchName(branch);
  const normalizedBaseBranch = normalizeBranchName(baseBranch);
  if (!normalizedBranch || !normalizedBaseBranch) {
    return false;
  }

  await remoteBranchExists({
    workspacePath,
    commandEnv,
    branch: normalizedBaseBranch,
  }).catch(() => false);

  const result = await runProcessCapture(
    "git",
    ["rev-list", "--count", `origin/${normalizedBaseBranch}..refs/heads/${normalizedBranch}`],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );
  if (!result.ok) {
    return false;
  }
  return parsePositiveInteger(result.stdout, 0) > 0;
}

async function readHeadCommitPresentation({ workspacePath, commandEnv }) {
  const subjectResult = await runProcessCapture("git", ["log", "-1", "--pretty=%s"], {
    cwd: workspacePath,
    env: commandEnv,
  });
  const bodyResult = await runProcessCapture("git", ["log", "-1", "--pretty=%b"], {
    cwd: workspacePath,
    env: commandEnv,
  });
  return {
    subject: normalizeText(subjectResult.stdout),
    body: normalizeText(bodyResult.stdout),
  };
}

async function readFirstCommitPresentation({
  workspacePath,
  commandEnv,
  branch,
  baseBranch,
}) {
  const normalizedBranch = normalizeBranchName(branch);
  const normalizedBaseBranch = normalizeBranchName(baseBranch);
  if (!normalizedBranch || !normalizedBaseBranch) {
    return readHeadCommitPresentation({ workspacePath, commandEnv });
  }

  const commitListResult = await runProcessCapture(
    "git",
    ["rev-list", "--reverse", `origin/${normalizedBaseBranch}..refs/heads/${normalizedBranch}`],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );
  const firstCommitSha = normalizeText(commitListResult.stdout)
    .split(/\s+/)
    .filter(Boolean)[0];
  if (!commitListResult.ok || !firstCommitSha) {
    return readHeadCommitPresentation({ workspacePath, commandEnv });
  }

  const subjectResult = await runProcessCapture("git", ["log", "-1", "--pretty=%s", firstCommitSha], {
    cwd: workspacePath,
    env: commandEnv,
  });
  const bodyResult = await runProcessCapture("git", ["log", "-1", "--pretty=%b", firstCommitSha], {
    cwd: workspacePath,
    env: commandEnv,
  });
  return {
    subject: normalizeText(subjectResult.stdout),
    body: normalizeText(bodyResult.stdout),
  };
}

async function persistWorkspaceProgress({
  workspacePath,
  commandEnv,
  sourceType = "",
  branch,
  writeMode = "",
  repository = "",
  headRepository = "",
  baseBranch = "",
  gitToken = "",
  protectedBranches = [],
  baselineState = null,
}) {
  const normalizedBranch = normalizeBranchName(branch);
  const result = {
    pushed: false,
    pullRequestNumber: 0,
    pullRequestUrl: "",
    pullRequestTitle: "",
    pendingRemoteSync: "",
    resolvedWriteBranch: "",
    skippedProtectedBranch: "",
    error: "",
  };
  if (!normalizedBranch) {
    return result;
  }

  try {
    const currentState = await readWorkspacePersistenceState({
      workspacePath,
      commandEnv,
      branch: normalizedBranch,
    });
    const meaningfulRepoWork =
      workspaceStateChangedSinceBaseline({
        baselineState,
        currentState,
      }) ||
      currentState.aheadCount > 0;
    const branchIsRemembered = isRememberedThreadBranch({
      branch: normalizedBranch,
      writeMode,
      baseBranch,
      protectedBranches,
    });

    if (
      normalizeText(writeMode) === "branch_and_pr" &&
      !branchIsRemembered &&
      meaningfulRepoWork
    ) {
      result.skippedProtectedBranch = normalizedBranch;
      result.error = `Codex left repo changes on protected branch ${normalizedBranch}. Create and switch to a normal git branch before finishing.`;
      return result;
    }

    if (!branchIsRemembered) {
      return result;
    }

    result.resolvedWriteBranch = normalizedBranch;
    const requiresManualPush =
      meaningfulRepoWork && (!currentState.hasRemoteBranch || currentState.aheadCount > 0);
    if (requiresManualPush) {
      result.pendingRemoteSync = currentState.hasRemoteBranch
        ? `Branch ${normalizedBranch} still has ${currentState.aheadCount} local commit(s) ahead of origin/${normalizedBranch}. Codex must push them explicitly.`
        : `Branch ${normalizedBranch} only exists in the local runner workspace. Codex must push it explicitly before Codeq8 can open or update a pull request.`;
      result.error = result.pendingRemoteSync;
      return result;
    }

    const hasBranchChangesForReview =
      !requiresManualPush && currentState.hasRemoteBranch
        ? await branchHasCommitsAgainstBase({
            workspacePath,
            commandEnv,
            branch: normalizedBranch,
            baseBranch,
          })
        : false;
    const shouldCreateOrAttachPullRequest =
      !requiresManualPush &&
      currentState.hasRemoteBranch &&
      shouldEnsurePullRequest({
        sourceType,
        writeMode,
        hasBranchChangesForReview,
        meaningfulRepoWork,
      });

    if (shouldCreateOrAttachPullRequest) {
      const pullRequestPresentation = await readFirstCommitPresentation({
        workspacePath,
        commandEnv,
        branch: normalizedBranch,
        baseBranch,
      });
      const pullRequest = await ensurePullRequest({
        repository,
        headRepository: headRepository || repository,
        headBranch: normalizedBranch,
        baseBranch,
        title: pullRequestPresentation.subject,
        body: pullRequestPresentation.body,
        token: gitToken,
      });
      if (!pullRequest.ok) {
        result.error = pullRequest.error || "Unable to ensure pull request.";
        return result;
      }
      if (pullRequest.pullRequest) {
        result.pullRequestNumber = pullRequest.pullRequest.number || 0;
        result.pullRequestUrl = pullRequest.pullRequest.url || "";
        result.pullRequestTitle = pullRequest.pullRequest.title || "";
      }
    }
  } catch (error) {
    result.error = extractErrorMessage(error);
  }

  return result;
}

async function githubApiJson({ url, token, method = "GET", body = null }) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${normalizeText(token)}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "codeq8-web-chat-runner",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    payload,
  };
}

async function ensurePullRequest({
  repository,
  headRepository,
  headBranch,
  baseBranch,
  title,
  body,
  token,
}) {
  const normalizedRepository = normalizeText(repository);
  const normalizedHeadRepository = normalizeText(headRepository || repository);
  const normalizedHeadBranch = normalizeBranchName(headBranch);
  const normalizedBaseBranch = normalizeBranchName(baseBranch);
  const normalizedToken = normalizeText(token);
  if (!normalizedRepository || !normalizedHeadBranch || !normalizedBaseBranch || !normalizedToken) {
    return { ok: false, error: "repository, head_branch, base_branch, and token are required." };
  }

  const [headOwner] = normalizedHeadRepository.split("/", 1);
  const headRef = `${normalizeText(headOwner)}:${normalizedHeadBranch}`;
  const listUrl = new URL(
    `https://api.github.com/repos/${encodeRepositoryPath(normalizedRepository)}/pulls`,
  );
  listUrl.searchParams.set("state", "open");
  listUrl.searchParams.set("head", headRef);
  listUrl.searchParams.set("base", normalizedBaseBranch);
  const listed = await githubApiJson({
    url: listUrl.toString(),
    token: normalizedToken,
  });
  const existingPulls = Array.isArray(listed.payload) ? listed.payload : [];
  const desiredPullRequestBody = normalizeText(body);
  if (listed.ok && existingPulls.length > 0) {
    const first = normalizeObject(existingPulls[0]);
    const existingPullRequestNumber = parsePositiveInteger(first.number, 0);
    let existingPullRequestTitle = normalizeText(first.title);
    let existingPullRequestUrl = normalizeText(first.html_url || first.url);
    const existingPullRequestBody = normalizeText(first.body);
    if (
      existingPullRequestNumber > 0 &&
      desiredPullRequestBody &&
      existingPullRequestBody !== desiredPullRequestBody
    ) {
      const updated = await githubApiJson({
        url: `https://api.github.com/repos/${encodeRepositoryPath(normalizedRepository)}/pulls/${existingPullRequestNumber}`,
        token: normalizedToken,
        method: "PATCH",
        body: {
          body: desiredPullRequestBody,
        },
      });
      if (updated.ok) {
        existingPullRequestTitle = normalizeText(updated.payload?.title || existingPullRequestTitle);
        existingPullRequestUrl = normalizeText(
          updated.payload?.html_url || updated.payload?.url || existingPullRequestUrl,
        );
      } else {
        log(
          "Unable to update existing pull request body",
          `repository=${normalizedRepository} number=${existingPullRequestNumber} status=${updated.status}`,
        );
      }
    }
    return {
      ok: true,
      pullRequest: {
        number: existingPullRequestNumber,
        title: existingPullRequestTitle,
        url: existingPullRequestUrl,
      },
      existing: true,
    };
  }

  const created = await githubApiJson({
    url: `https://api.github.com/repos/${encodeRepositoryPath(normalizedRepository)}/pulls`,
    token: normalizedToken,
    method: "POST",
    body: {
      title: truncate(normalizeText(title) || `Codeq8: ${normalizedHeadBranch}`, 120),
      head: headRef,
      base: normalizedBaseBranch,
      body: desiredPullRequestBody,
      maintainer_can_modify: true,
    },
  });
  if (created.ok) {
    return {
      ok: true,
      pullRequest: {
        number: parsePositiveInteger(created.payload.number, 0),
        title: normalizeText(created.payload.title),
        url: normalizeText(created.payload.html_url || created.payload.url),
      },
      existing: false,
    };
  }
  if (created.status === 422) {
    return {
      ok: true,
      pullRequest: null,
      existing: false,
    };
  }

  return {
    ok: false,
    error:
      normalizeText(created.payload?.message || created.payload?.error) ||
      `Unable to create pull request (${created.status}).`,
  };
}

async function prepareWorkspace({
  workspacePath,
  workspaceRepository,
  sourceType,
  branchContext,
  pullRequestHeadRepository,
  commandEnv,
  githubLogin,
  githubWriteToken,
}) {
  const hasLinkedPullRequest =
    parsePositiveInteger(branchContext.pull_request_number, 0) > 0 &&
    normalizeBranchName(branchContext.pull_request_head_branch);
  const isForkDirectPush =
    normalizeText(branchContext.write_mode) === "direct_push" &&
    hasLinkedPullRequest &&
    normalizeText(pullRequestHeadRepository) &&
    normalizeText(pullRequestHeadRepository).toLowerCase() !==
      normalizeText(workspaceRepository).toLowerCase();

  const cloneRepository = isForkDirectPush ? pullRequestHeadRepository : workspaceRepository;
  const preferredGitToken = normalizeText(githubWriteToken);
  if (!preferredGitToken) {
    throw new Error(
      "A GitHub write token is required for web chat runner repository access.",
    );
  }

  const preparedWorkspacePath = await ensureWorkspaceRepository({
    workspacePath,
    repository: cloneRepository,
    gitToken: preferredGitToken,
    commandEnv,
    githubLogin,
  });

  const protectedBranches = parseBranchList(branchContext.protected_branches || []);
  const rememberedWriteBranch = isProtectedBranch(normalizeBranchName(branchContext.write_branch), [
    ...protectedBranches,
    branchContext.base_branch,
    branchContext.default_branch,
  ])
    ? ""
    : normalizeBranchName(branchContext.write_branch);
  const effectiveWriteBranch = resolveEffectiveWriteBranch({
    sourceType,
    branchContext,
  });
  const baseBranch = resolveReviewBaseBranch({
    sourceType,
    branchContext,
  });
  if (!effectiveWriteBranch) {
    throw new Error("Unable to resolve working branch for web chat runner.");
  }

  if (
    branchContext.write_mode === "direct_push" &&
    isProtectedBranch(effectiveWriteBranch, protectedBranches)
  ) {
    throw new Error(`Refusing to direct-push protected branch: ${effectiveWriteBranch}.`);
  }

  let checkoutResult = { ok: false, error: "" };
  const originBranch =
    normalizeBranchName(branchContext.context_branch) ||
    normalizeBranchName(branchContext.base_branch) ||
    normalizeBranchName(branchContext.default_branch) ||
    (await resolveOriginDefaultBranch({
      workspacePath: preparedWorkspacePath,
      commandEnv,
    }));
  if (!originBranch) {
    throw new Error("Unable to resolve checkout base branch for web chat runner.");
  }
  checkoutResult = await checkoutPreparedWorkspaceBranch({
    workspacePath: preparedWorkspacePath,
    commandEnv,
    effectiveWriteBranch,
    originBranch,
  });

  if (!checkoutResult.ok) {
    throw new Error(
      checkoutResult.error || `Unable to checkout working branch ${effectiveWriteBranch}.`,
    );
  }

  const writableRemoteUrl = buildGithubCloneUrl(cloneRepository, preferredGitToken);
  await configureWorkspacePushPolicy({
    workspacePath: preparedWorkspacePath,
    commandEnv,
    remoteUrl: writableRemoteUrl,
    blockedBranches: Array.from(
      new Set([
        ...protectedBranches,
        branchContext.base_branch,
        branchContext.default_branch,
        branchContext.production_branch,
      ]),
    ),
  });

  const codeq8Config = await loadWorkspaceCodeq8Config(preparedWorkspacePath);
  const bootstrapCommands = readBootstrapInstallCommands(codeq8Config);
  if (bootstrapCommands.length > 0) {
    await executeWorkspaceBootstrapCommands({
      workspacePath: preparedWorkspacePath,
      commands: bootstrapCommands,
      commandEnv,
      stateDirName: "codeq8-web-chat-bootstrap",
      log,
    });
  }

  return {
    workspacePath: preparedWorkspacePath,
    cloneRepository,
    effectiveWriteBranch,
    durableWriteBranch:
      normalizeText(branchContext.write_mode) === "direct_push"
        ? effectiveWriteBranch
        : rememberedWriteBranch,
    protectedBranches,
    baseBranch,
  };
}

async function main() {
  const workerUrl = resolveWorkerBaseUrl(process.env, DEFAULT_CODE_WORKER_BASE_URL);
  const chatGptAccountWorkerUrl = resolveChatGptAccountWorkerBaseUrl(
    {
      ...process.env,
      CODE_WORKER_URL: workerUrl,
      CODE_WORKER_CANONICAL_URL:
        normalizeText(process.env.CODE_WORKER_CANONICAL_URL) || workerUrl,
    },
    DEFAULT_CODE_WORKER_BASE_URL,
  );
  const publicBaseUrl =
    normalizeText(process.env.CODE_PUBLIC_BASE_URL) || DEFAULT_CODE_PUBLIC_URL;
  const adminToken = resolveWebChatRunnerAdminToken(process.env);
  const workspaceRepository = normalizeText(process.env.CODE_WORKSPACE_REPOSITORY);
  const threadId = normalizeText(process.env.CODE_CHAT_THREAD_ID);
  const messageId = normalizeText(process.env.CODE_CHAT_MESSAGE_ID);
  const runId = normalizeText(process.env.CODE_CHAT_RUN_ID);
  const sourceType = normalizeText(process.env.CODE_CHAT_SOURCE_TYPE) || "default_branch";
  const githubLogin = normalizeText(process.env.CODE_CHAT_GITHUB_LOGIN);
  const initialChatGptAccountId = normalizeChatGptAccountId(
    process.env.CODE_CHAT_CHATGPT_ACCOUNT_ID,
  );
  const threadTitle = normalizeText(process.env.CODE_CHAT_THREAD_TITLE);
  const threadSpecText = normalizeText(process.env.CODE_CHAT_THREAD_SPEC_TEXT);
  const promptText = normalizeText(process.env.CODE_CHAT_PROMPT_TEXT);
  const recentUserMessagesPromptText = normalizeText(
    process.env.CODE_CHAT_RECENT_USER_MESSAGES_PROMPT_TEXT,
  );
  const recentChecksPromptText = normalizeText(
    process.env.CODE_CHAT_RECENT_CHECKS_PROMPT_TEXT,
  );
  const referencedThreads = parseReferencedThreadList(
    process.env.CODE_CHAT_REFERENCED_THREADS_JSON || "[]",
  );
  const latestMessageAttachments = parseAttachmentList(
    process.env.CODE_CHAT_ATTACHMENTS_JSON || "[]",
  );
  const fallbackPullRequestHeadRepository = normalizeText(
    process.env.CODE_CHAT_PULL_REQUEST_HEAD_REPOSITORY,
  );
  const codexModel = normalizeText(process.env.CODEX_MODEL) || DEFAULT_CODEX_MODEL;
  const timeoutSeconds = parsePositiveInteger(
    process.env.CODEX_TIMEOUT_SECONDS,
    DEFAULT_TIMEOUT_SECONDS,
  );

  if (!workerUrl) {
    throw new Error("CODE_WORKER_URL is required.");
  }
  if (!adminToken) {
    throw new Error(
      "CODE_WEB_CHAT_RUN_TOKEN or CODE_GITHUB_SESSION_SECRET or GH_OAUTH_STATE_SECRET is required.",
    );
  }
  if (!workspaceRepository || !threadId || !messageId || !runId || !promptText) {
    throw new Error(
      "CODE_WORKSPACE_REPOSITORY, CODE_CHAT_THREAD_ID, CODE_CHAT_MESSAGE_ID, CODE_CHAT_RUN_ID, and CODE_CHAT_PROMPT_TEXT are required.",
    );
  }

  const fallbackBranchContext = parseBranchContextFromEnv();

  const workspacePath = resolveWorkspacePath({
    repository: workspaceRepository,
    overridePath: process.env.CODE_WORKSPACE_PATH,
  });
  if (!workspacePath) {
    throw new Error("Unable to resolve workspace path.");
  }

  const commandEnv = {
    ...process.env,
    CODE_WORKER_URL: workerUrl,
    CODE_PUBLIC_BASE_URL: publicBaseUrl,
    CODE_WORKSPACE_REPOSITORY: workspaceRepository,
    CODEX_MODEL: codexModel,
    GIT_TERMINAL_PROMPT: "0",
    GIT_HTTP_LOW_SPEED_LIMIT: DEFAULT_GIT_HTTP_LOW_SPEED_LIMIT,
    GIT_HTTP_LOW_SPEED_TIME: DEFAULT_GIT_HTTP_LOW_SPEED_TIME,
  };
  log(
    "Resolved web chat worker target",
    `thread_id=${threadId} worker=${normalizeBaseUrl(workerUrl)}`,
  );

  const codexPath = await resolveCodexPath(commandEnv);
  let preparedWorkspace = null;
  let runRuntime = null;
  let preparedCodeq8Cli = { available: false, reason: "" };
  let startedAt = 0;
  let assistantMessage = "";
  let persistedCodexSessionState = normalizeCodexSessionState(null);
  let nonFatalCodexSessionLoadWarning = "";
  let executionMode = "fresh";
  let threadTargetRestartCount = 0;
  let chatGptAccountRecoveryCount = 0;
  let codexResumeRecoveryCount = 0;
  let selectedChatGptAccountId = initialChatGptAccountId;
  let lastPersistenceSummary = "";
  try {
    while (true) {
      assistantMessage = "";
      preparedWorkspace = null;
      const thread = await loadWebChatThread({
        workerUrl,
        adminToken,
        threadId,
      });
      const activeWorkspaceRepository =
        normalizeText(thread.workspace_repository) || workspaceRepository;
      const activeThreadTitle = normalizeText(thread.title) || threadTitle;
      const activeSourceType = normalizeSourceType(thread.source_type || sourceType);
      const activeBranchContext =
        thread.branch_context?.default_branch &&
        thread.branch_context?.context_branch &&
        thread.branch_context?.write_mode
          ? normalizeThreadBranchContext(thread.branch_context)
          : fallbackBranchContext;
      if (
        activeSourceType === "pull_request" &&
        activeBranchContext.write_mode === "direct_push"
      ) {
        const canonicalPullRequestBranch =
          normalizeBranchName(activeBranchContext.pull_request_head_branch) ||
          normalizeBranchName(activeBranchContext.context_branch);
        if (canonicalPullRequestBranch) {
          activeBranchContext.context_branch = canonicalPullRequestBranch;
          activeBranchContext.write_branch = canonicalPullRequestBranch;
          activeBranchContext.pull_request_head_branch =
            activeBranchContext.pull_request_head_branch || canonicalPullRequestBranch;
        }
      }
      if (
        !activeBranchContext.default_branch ||
        !activeBranchContext.context_branch ||
        !activeBranchContext.write_mode
      ) {
        throw new Error("Web chat runner is missing required branch context.");
      }
      if (
        activeBranchContext.write_mode !== "direct_push" &&
        activeBranchContext.write_mode !== "branch_and_pr"
      ) {
        throw new Error(`Unsupported CODE_CHAT_WRITE_MODE: ${activeBranchContext.write_mode}`);
      }
      if (
        activeBranchContext.write_mode === "direct_push" &&
        !normalizeBranchName(activeBranchContext.write_branch || activeBranchContext.context_branch)
      ) {
        throw new Error("Direct-push web chat runs require a writable branch.");
      }
      if (
        activeBranchContext.write_mode === "branch_and_pr" &&
        !normalizeBranchName(activeBranchContext.base_branch)
      ) {
        throw new Error("PR-required web chat runs require a base branch.");
      }

      const targetBeforeAttempt = normalizeThreadExecutionTarget({
        repository: activeWorkspaceRepository,
        sourceType: activeSourceType,
        githubContext: thread.github_context || {},
        branchContext: activeBranchContext,
      });
      const currentTargetSignature = buildThreadExecutionTargetSignature(targetBeforeAttempt);
      const pullRequestHeadRepository =
        readPullRequestHeadRepository(thread.github_context) ||
        fallbackPullRequestHeadRepository;

      const requestedWorkspaceGitToken = await applyWorkspaceGitToken({
        publicBaseUrl,
        adminToken,
        workspaceRepository: activeWorkspaceRepository,
        commandEnv,
      });
      let workspaceGitToken =
        requireWebChatGitHubWriteToken(
          commandEnv,
          "Web chat runner repository writes",
        );
      let workspaceGitTokenSource =
        normalizeText(requestedWorkspaceGitToken.tokenSource) || "github_app_installation";
      log(
        "Prepared GitHub write credential for web chat run",
        `repository=${activeWorkspaceRepository} source=${workspaceGitTokenSource}`,
      );

      preparedWorkspace = await prepareWorkspace({
        workspacePath,
        workspaceRepository: activeWorkspaceRepository,
        sourceType: activeSourceType,
        branchContext: activeBranchContext,
        pullRequestHeadRepository,
        commandEnv,
        githubLogin,
        githubWriteToken: workspaceGitToken,
      });
      activeBranchContext.write_branch = preparedWorkspace.durableWriteBranch;
      const workspacePersistenceState = await readWorkspacePersistenceState({
        workspacePath: preparedWorkspace.workspacePath,
        commandEnv,
        branch: preparedWorkspace.effectiveWriteBranch,
      });

      const attemptRunRuntime = await createWebChatRunRuntime(threadId);
      runRuntime = attemptRunRuntime;
      const codexCommandEnv = {
        ...commandEnv,
        CODEX_HOME: attemptRunRuntime.codexHome,
      };
      applyCodeq8CliRuntimeEnv({
        commandEnv: codexCommandEnv,
        publicBaseUrl,
        runtimeHomePath: attemptRunRuntime.homePath,
      });
      const preparedGitHubCli = await prepareGitHubCliAuth({
        commandEnv: codexCommandEnv,
        runtimeHomePath: attemptRunRuntime.homePath,
      });
      if (preparedGitHubCli.available) {
        log(
          "Prepared gh auth for web chat run",
          `path=${preparedGitHubCli.binPath}`,
        );
      } else {
        log(
          "gh auth unavailable for this web chat run",
          preparedGitHubCli.reason || "Unavailable.",
        );
      }
      const materializedAttachments = await materializeWebChatAttachments({
        attachments: latestMessageAttachments,
        attachmentRootPath: path.join(attemptRunRuntime.homePath, "attachments"),
        workerUrl,
        adminToken,
        threadId,
      });

      let activeChatGptAccount = null;
      let skipChatGptAccountFinalization = false;
      let runBodyError = null;
      try {
        const preparedChatGptAccount = await prepareChatGptAccountAuth({
          workerUrl: chatGptAccountWorkerUrl,
          adminToken,
          codexHome: attemptRunRuntime.codexHome,
          ownerGithubLogin: githubLogin,
          accountId: selectedChatGptAccountId,
        });
        if (!preparedChatGptAccount.available) {
          throw new Error(
            preparedChatGptAccount.reason ||
              "The assigned ChatGPT account could not be loaded for this run.",
          );
        }
        log(
          "Prepared ChatGPT account for web chat run",
          `account_id=${preparedChatGptAccount.accountId} owner=${githubLogin}`,
        );
        activeChatGptAccount = {
          ownerGithubLogin: githubLogin,
          accountId: preparedChatGptAccount.accountId,
        };
        const validatedChatGptAccount = await validateChatGptAccountAuth({
          codexPath,
          codexHome: attemptRunRuntime.codexHome,
          workspacePath: preparedWorkspace.workspacePath,
          commandEnv: codexCommandEnv,
        });
        if (!validatedChatGptAccount.ok) {
          runBodyError = new Error(
            validatedChatGptAccount.reason ||
              "The assigned ChatGPT account could not be validated for this run.",
          );
          if (validatedChatGptAccount.reauthRequired && activeChatGptAccount) {
            const recovery = await recoverFromChatGptAccountReauthFailure({
              workerUrl: chatGptAccountWorkerUrl,
              adminToken,
              ownerGithubLogin: activeChatGptAccount.ownerGithubLogin,
              accountId: activeChatGptAccount.accountId,
              error: validatedChatGptAccount.reason,
              recoveryCount: chatGptAccountRecoveryCount,
            });
            skipChatGptAccountFinalization = true;
            activeChatGptAccount = null;
            if (!recovery.ok) {
              throw new Error(
                recovery.error ||
                  validatedChatGptAccount.reason ||
                  "The assigned ChatGPT account needs to be reconnected.",
              );
            }
            chatGptAccountRecoveryCount = recovery.recoveryCount;
            selectedChatGptAccountId = recovery.nextAccountId;
            log(
              "Retrying web chat run with the next ChatGPT account",
              `owner=${githubLogin} account_id=${selectedChatGptAccountId} retry_count=${chatGptAccountRecoveryCount}`,
            );
            continue;
          }
          throw runBodyError;
        }
        const syncedChatGptAccount = await syncChatGptAccountAuth({
          workerUrl: chatGptAccountWorkerUrl,
          adminToken,
          codexHome: attemptRunRuntime.codexHome,
          ownerGithubLogin: githubLogin,
          persistedAccountId: preparedChatGptAccount.accountId,
          threadId,
          runId,
        });
        selectedChatGptAccountId =
          normalizeChatGptAccountId(syncedChatGptAccount.accountId) ||
          preparedChatGptAccount.accountId;
        activeChatGptAccount.accountId = selectedChatGptAccountId;

        preparedCodeq8Cli = await prepareCodeq8Cli({
          commandEnv: codexCommandEnv,
          workspacePath: preparedWorkspace.workspacePath,
          publicBaseUrl,
          expectedGithubLogin: githubLogin,
        });
        if (preparedCodeq8Cli.available) {
          log(
            "Prepared codeq8 CLI for web chat run",
            `path=${preparedCodeq8Cli.binPath} login=${normalizeText(preparedCodeq8Cli.githubLogin) || githubLogin || "<unknown>"} config_home=${normalizeText(codexCommandEnv.CODEQ8_CONFIG_HOME)}`,
          );
        } else {
          log(
            "codeq8 CLI unavailable for this web chat run",
            preparedCodeq8Cli.reason || "Unavailable.",
          );
        }
        log(
          "Prepared web chat runtime",
          `codex_home=${attemptRunRuntime.codexHome} sessions_before=${attemptRunRuntime.sessionFileSnapshot.size}`,
        );

        let prompt = "";
        let expectedBundleRevision = 0;
        let resumeAttemptedAt = 0;
        let codexSessionState = normalizeCodexSessionState(thread.codex_session_state || null);
        let resumeTargetShift = false;
        try {
          const loadedCodexSessionResult = await loadCodexSessionStateForExecution({
            workerUrl,
            adminToken,
            threadId,
            thread,
          });
          let loadedCodexSession = loadedCodexSessionResult.loadedCodexSession;
          codexSessionState = loadedCodexSessionResult.codexSessionState;
          persistedCodexSessionState = loadedCodexSessionResult.persistedCodexSessionState;
          expectedBundleRevision = loadedCodexSessionResult.expectedBundleRevision;
          nonFatalCodexSessionLoadWarning = loadedCodexSessionResult.continuityWarning;

          if (codexSessionState.status === "error") {
            const recoveredCodexSessionState =
              await clearRecoverableCodexSessionErrorState({
                workerUrl,
                adminToken,
                threadId,
                codexSessionState,
              });
            if (recoveredCodexSessionState.status === "error") {
              throw new Error(
                codexSessionState.last_error
                  ? `Codex session state is in error status: ${codexSessionState.last_error}`
                  : "Codex session state is in error status.",
              );
            }
            log(
              "WARN",
              recoveredCodexSessionState.status === "ready"
                ? "Recovered from web chat codex session error state; resuming from the last persisted session bundle."
                : "Recovered from web chat codex session error state; continuing with a fresh session.",
            );
            codexSessionState = recoveredCodexSessionState;
            persistedCodexSessionState = recoveredCodexSessionState;
            expectedBundleRevision =
              recoveredCodexSessionState.bundle_revision || expectedBundleRevision;
            loadedCodexSession = {
              ...loadedCodexSession,
              codexSessionState: recoveredCodexSessionState,
              sessionFileContents:
                recoveredCodexSessionState.status === "ready"
                  ? loadedCodexSession.sessionFileContents
                  : "",
            };
          }

          if (codexSessionState.status === "ready") {
            if (!codexSessionState.session_id || !codexSessionState.session_file_relative_path) {
              throw new Error("Codex session state is missing required resume metadata.");
            }
            if (!String(loadedCodexSession.sessionFileContents || "")) {
              throw new Error(
                "Codex session state is marked ready but no session bundle was stored.",
              );
            }
            await restoreCodexSessionBundle({
              codexHome: attemptRunRuntime.codexHome,
              sessionFileRelativePath: codexSessionState.session_file_relative_path,
              sessionFileContents: loadedCodexSession.sessionFileContents,
            });
            executionMode = "resume";
            resumeAttemptedAt = Date.now();
            resumeTargetShift =
              threadTargetRestartCount > 0 ||
              (
                normalizeText(codexSessionState.target_signature) &&
                normalizeText(codexSessionState.target_signature) !== currentTargetSignature
              );
            prompt = buildResumePrompt({
              repository: activeWorkspaceRepository,
              sourceType: activeSourceType,
              branchContext: activeBranchContext,
              workspacePersistenceState,
              threadSpecText,
              promptText,
              recentUserMessagesPromptText,
              recentChecksPromptText,
              attachments: materializedAttachments,
              referencedThreads,
              targetShift: resumeTargetShift ? targetBeforeAttempt : null,
            });
          } else {
            let conversation;
            try {
              conversation = await loadWebChatMessages({
                workerUrl,
                adminToken,
                threadId,
                limit: MAX_CONTEXT_MESSAGES,
                fallbackThread: thread,
              });
            } catch (error) {
              throw new Error(
                `Failed to load web chat message history: ${
                  extractErrorMessage(error)
                }`,
              );
            }
            executionMode = "fresh";
            prompt = buildCodexPrompt({
              repository: activeWorkspaceRepository,
              threadTitle: activeThreadTitle,
              threadId,
              sourceType: activeSourceType,
              branchContext: activeBranchContext,
              workspacePersistenceState,
              priorMessages: buildFreshPromptHistoryMessages({
                messages: conversation.messages,
                currentMessageId: messageId,
              }),
              threadSpecText,
              promptText,
              recentChecksPromptText,
              codeq8Cli: preparedCodeq8Cli,
              attachments: materializedAttachments,
              referencedThreads,
            });
          }
        } catch (sessionError) {
          const sessionMessage = extractErrorMessage(sessionError);
          await safePersistCodexSessionError({
            workerUrl,
            adminToken,
            threadId,
            runId,
            error: sessionMessage,
            lastResumedAt: resumeAttemptedAt,
            expectedBundleRevision,
          });
          throw sessionError;
        }

        if (!startedAt) {
          startedAt = Date.now();
        }
        try {
          await postRunCallback({
            publicBaseUrl,
            workerUrl,
            adminToken,
            body: {
              thread_id: threadId,
              run_id: runId,
              message_id: messageId,
              workspace_repository: activeWorkspaceRepository,
              status: "running",
              summary:
              threadTargetRestartCount > 0
                  ? "Restarting on the updated thread context."
                  : chatGptAccountRecoveryCount > 0
                    ? "Retrying with the next ChatGPT account."
                  : "Codex is working.",
              resolved_write_branch: preparedWorkspace.durableWriteBranch || undefined,
              started_at: startedAt,
              metadata: buildCodexRunMetadata({
                model: codexModel,
                mode: executionMode,
                extra: {
                  bundle_revision: persistedCodexSessionState.bundle_revision || 0,
                  thread_target_restart_count: threadTargetRestartCount,
                  chatgpt_account_retry_count: chatGptAccountRecoveryCount,
                },
              }),
            },
          });
        } catch (error) {
          throw new Error(
            `Failed to post running web chat callback: ${
              extractErrorMessage(error)
            }`,
          );
        }
        log(
          "Starting web chat codex run",
          `repository=${activeWorkspaceRepository} branch=${preparedWorkspace.effectiveWriteBranch} model=${codexModel} mode=${executionMode} restart_count=${threadTargetRestartCount}`,
        );

        const execution = await runCodex({
          codexPath,
          model: codexModel,
          task: prompt,
          workspacePath: preparedWorkspace.workspacePath,
          commandEnv: codexCommandEnv,
          timeoutSeconds,
          mode: executionMode,
          sessionId: codexSessionState.session_id,
          outputFilePath: path.join(attemptRunRuntime.homePath, "last-message.txt"),
        });
        if (execution.chatGptAccountReauthRequired && activeChatGptAccount) {
          runBodyError = new Error(
            execution.reason ||
              "The assigned ChatGPT account needs to be reconnected.",
          );
          const recovery = await recoverFromChatGptAccountReauthFailure({
            workerUrl: chatGptAccountWorkerUrl,
            adminToken,
            ownerGithubLogin: activeChatGptAccount.ownerGithubLogin,
            accountId: activeChatGptAccount.accountId,
            error: execution.reason,
            recoveryCount: chatGptAccountRecoveryCount,
          });
          skipChatGptAccountFinalization = true;
          activeChatGptAccount = null;
          if (!recovery.ok) {
            throw new Error(
              recovery.error ||
                execution.reason ||
                "The assigned ChatGPT account needs to be reconnected.",
            );
          }
          chatGptAccountRecoveryCount = recovery.recoveryCount;
          selectedChatGptAccountId = recovery.nextAccountId;
          log(
            "Retrying web chat run with the next ChatGPT account",
            `owner=${githubLogin} account_id=${selectedChatGptAccountId} retry_count=${chatGptAccountRecoveryCount}`,
          );
          continue;
        }
        if (
          executionMode === "resume" &&
          isRecoverableCodexResumeFailure({
            reason: execution.reason,
            output: execution.diagnosticOutput || execution.output,
          })
        ) {
          if (codexResumeRecoveryCount >= MAX_CODEX_RESUME_RECOVERY_ATTEMPTS) {
            throw new Error(
              execution.reason ||
                "Codex could not resume from the stored conversation state.",
            );
          }
          codexResumeRecoveryCount += 1;
          const resumeFailureMessage =
            extractErrorMessage(execution.reason || execution.diagnosticOutput || execution.output) ||
            "Codex could not resume from the stored conversation state.";
          const invalidatedSession = await invalidateWebChatCodexSessionState({
            workerUrl,
            adminToken,
            threadId,
            reason: resumeFailureMessage,
          });
          persistedCodexSessionState = invalidatedSession.codexSessionState;
          nonFatalCodexSessionLoadWarning =
            `Continuing with a fresh Codex session after resume failed: ${resumeFailureMessage}`;
          log(
            "WARN",
            "Codex resume failed; invalidated the stored session bundle and retrying fresh",
            `thread_id=${threadId} retry_count=${codexResumeRecoveryCount}`,
          );
          continue;
        }
        assistantMessage = truncate(normalizeText(execution.output), MAX_OUTPUT_CHARS);

        const finalBranch = await currentBranch({
          workspacePath: preparedWorkspace.workspacePath,
          commandEnv,
        });
        if (!normalizeBranchName(finalBranch)) {
          throw new Error(
            "Unable to determine the final git branch after Codex completed.",
          );
        }
        if (
          normalizeText(activeBranchContext.write_mode) === "direct_push" &&
          normalizeBranchName(finalBranch) !==
            normalizeBranchName(preparedWorkspace.effectiveWriteBranch)
        ) {
          throw new Error(
            `Codex changed branches unexpectedly (expected ${preparedWorkspace.effectiveWriteBranch}, got ${finalBranch || "<unknown>"}).`,
          );
        }

        const latestThread = await loadWebChatThread({
          workerUrl,
          adminToken,
          threadId,
        });
        const targetAfterAttempt = normalizeThreadExecutionTarget({
          repository: latestThread.workspace_repository,
          sourceType: latestThread.source_type,
          githubContext: latestThread.github_context || {},
          branchContext: latestThread.branch_context || {},
        });
        if (threadExecutionTargetChanged(targetBeforeAttempt, targetAfterAttempt)) {
          threadTargetRestartCount += 1;
          const nextTargetDescription = describeThreadExecutionTarget(targetAfterAttempt);
          log(
            "Detected web chat thread retarget during Codex run",
            `from=${describeThreadExecutionTarget(targetBeforeAttempt)} to=${nextTargetDescription} restart_count=${threadTargetRestartCount}`,
          );

          if (threadTargetRestartCount > MAX_THREAD_TARGET_RESTARTS) {
            assistantMessage = truncate(
              assistantMessage ||
                `Updated this conversation to ${nextTargetDescription}. Send the request again from the new context.`,
              MAX_OUTPUT_CHARS,
            );
            await postRunCallback({
              publicBaseUrl,
              workerUrl,
              adminToken,
              body: {
                thread_id: threadId,
                run_id: runId,
                message_id: messageId,
                workspace_repository: latestThread.workspace_repository || activeWorkspaceRepository,
                status: "completed",
                summary: `Updated the conversation to ${nextTargetDescription}.`,
                assistant_message: assistantMessage,
                started_at: startedAt,
                completed_at: Date.now(),
                metadata: buildCodexRunMetadata({
                  model: codexModel,
                  mode: executionMode,
                  extra: {
                    thread_target_restart_count: threadTargetRestartCount,
                    thread_target_restart_limit_reached: true,
                    thread_target: nextTargetDescription,
                  },
                }),
              },
            });
            log(
              "Stopped after thread target changes exceeded restart limit",
              `target=${nextTargetDescription}`,
            );
            return;
          }

          try {
            persistedCodexSessionState = await persistCapturedCodexSessionBundleWithRetries({
              workerUrl,
              adminToken,
              threadId,
              runId,
              codexHome: attemptRunRuntime.codexHome,
              existingSessionState: codexSessionState,
              model: codexModel,
              targetSignature: currentTargetSignature,
              expectedBundleRevision,
              sessionFileSnapshot: attemptRunRuntime.sessionFileSnapshot,
              runStartedAt: startedAt,
              lastResumedAt:
                executionMode === "resume"
                  ? resumeAttemptedAt || Date.now()
                  : persistedCodexSessionState.last_resumed_at,
            });
            log(
              "Persisted Codex session bundle before retarget restart",
              `revision=${persistedCodexSessionState.bundle_revision} bytes=${persistedCodexSessionState.bundle_size_bytes}`,
            );
          } catch (sessionError) {
            const sessionMessage =
              sessionError instanceof Error ? sessionError.message : String(sessionError);
            await safePersistCodexSessionError({
              workerUrl,
              adminToken,
              threadId,
              runId,
              error: sessionMessage,
              lastResumedAt: resumeAttemptedAt,
              expectedBundleRevision,
            });
          assistantMessage = truncate(
            [
                assistantMessage,
                `Codex session persistence failed before retarget restart: ${sessionMessage}`,
              ]
                .filter(Boolean)
                .join("\n\n"),
              MAX_OUTPUT_CHARS,
            );
            throw sessionError;
          }

          await postRunCallback({
            publicBaseUrl,
            workerUrl,
            adminToken,
            body: {
              thread_id: threadId,
              run_id: runId,
              message_id: messageId,
              workspace_repository: latestThread.workspace_repository || activeWorkspaceRepository,
              status: "running",
              summary: `Updated the conversation to ${nextTargetDescription}. Restarting on the new context.`,
              started_at: startedAt,
              metadata: buildCodexRunMetadata({
                model: codexModel,
                mode: "resume",
                extra: {
                  thread_target_restart: true,
                  thread_target_restart_count: threadTargetRestartCount,
                  thread_target: nextTargetDescription,
                },
              }),
            },
          });
          continue;
        }

        try {
          persistedCodexSessionState = await persistCapturedCodexSessionBundleWithRetries({
            workerUrl,
            adminToken,
            threadId,
            runId,
            codexHome: attemptRunRuntime.codexHome,
            existingSessionState: codexSessionState,
            model: codexModel,
            targetSignature: currentTargetSignature,
            expectedBundleRevision,
            sessionFileSnapshot: attemptRunRuntime.sessionFileSnapshot,
            runStartedAt: startedAt,
            lastResumedAt:
              executionMode === "resume"
                ? resumeAttemptedAt || Date.now()
                : persistedCodexSessionState.last_resumed_at,
          });
          log(
            "Persisted Codex session bundle",
            `mode=${executionMode} revision=${persistedCodexSessionState.bundle_revision} bytes=${persistedCodexSessionState.bundle_size_bytes}`,
          );
        } catch (sessionError) {
          const sessionMessage =
            sessionError instanceof Error ? sessionError.message : String(sessionError);
          await safePersistCodexSessionError({
            workerUrl,
            adminToken,
            threadId,
            runId,
            error: sessionMessage,
            lastResumedAt: resumeAttemptedAt,
            expectedBundleRevision,
          });
          assistantMessage = truncate(
            [
              "I couldn't save the conversation state after the run, so I marked this run failed.",
              assistantMessage,
            ]
              .filter(Boolean)
              .join("\n\n"),
            MAX_OUTPUT_CHARS,
          );
          throw new Error(`Codex session persistence failed: ${sessionMessage}`);
        }

        const refreshedWorkspaceGitToken = await applyWorkspaceGitToken({
          publicBaseUrl,
          adminToken,
          workspaceRepository: activeWorkspaceRepository,
          commandEnv,
        });
        workspaceGitToken =
          requireWebChatGitHubWriteToken(
            commandEnv,
            "Workspace sync and pull request updates",
          );
        workspaceGitTokenSource =
          normalizeText(refreshedWorkspaceGitToken.tokenSource) || workspaceGitTokenSource;
        const persistenceResult = await persistWorkspaceProgress({
          workspacePath: preparedWorkspace.workspacePath,
          commandEnv,
          sourceType: activeSourceType,
          branch: finalBranch,
          writeMode: activeBranchContext.write_mode,
          repository: activeWorkspaceRepository,
          headRepository: preparedWorkspace.cloneRepository,
          baseBranch: preparedWorkspace.baseBranch,
          gitToken: workspaceGitToken,
          protectedBranches: preparedWorkspace.protectedBranches,
          baselineState: workspacePersistenceState,
        });
        lastPersistenceSummary = describeWorkspacePersistence({
          branch:
            persistenceResult.resolvedWriteBranch ||
            preparedWorkspace.durableWriteBranch ||
            finalBranch,
          pushed: persistenceResult.pushed,
          pullRequestUrl: persistenceResult.pullRequestUrl,
          pendingRemoteSync: persistenceResult.pendingRemoteSync,
          skippedProtectedBranch: persistenceResult.skippedProtectedBranch,
        });
        if (lastPersistenceSummary) {
          log("Workspace persistence summary", lastPersistenceSummary);
        }

        let resolvedPullRequestNumber = activeBranchContext.pull_request_number || 0;
        let resolvedPullRequestUrl = activeBranchContext.pull_request_url || "";
        if (persistenceResult.pullRequestNumber > 0) {
          resolvedPullRequestNumber = persistenceResult.pullRequestNumber;
        }
        if (persistenceResult.pullRequestUrl) {
          resolvedPullRequestUrl = persistenceResult.pullRequestUrl;
        }

        const recoveredTransportFailure = shouldTreatCodexFailureAsCompleted({
          execution,
          assistantMessage,
          persistenceResult,
          persistenceSummary: lastPersistenceSummary,
        });

        if (persistenceResult.error) {
          throw new Error(persistenceResult.error);
        }

        if (!execution.ok && !recoveredTransportFailure) {
          const executionFailureDetails = [execution.reason, execution.diagnosticOutput]
            .filter(Boolean)
            .join("\n\n");
          const userVisibleFailureMessage = toUserVisibleRunnerFailureMessage(
            executionFailureDetails ||
              "Web chat runner failed.",
          );
          assistantMessage = truncate(
            [
              userVisibleFailureMessage,
              assistantMessage,
            ]
              .filter(Boolean)
              .join("\n\n"),
            MAX_OUTPUT_CHARS,
          );
          throw new Error(userVisibleFailureMessage);
        }

        if (recoveredTransportFailure) {
          log(
            "WARN",
            `Continuing after recoverable Codex transport failure: ${
              execution.reason || "Codex execution ended unexpectedly."
            }`,
          );
        }

        assistantMessage = truncate(
          assistantMessage ||
            lastPersistenceSummary ||
            "Codex completed without textual output.",
          MAX_OUTPUT_CHARS,
        );
        const completedAt = Date.now();
        await postRunCallback({
          publicBaseUrl,
          workerUrl,
          adminToken,
          body: {
            thread_id: threadId,
            run_id: runId,
            message_id: messageId,
            workspace_repository: activeWorkspaceRepository,
              status: "completed",
            summary: recoveredTransportFailure
              ? `Completed web chat runner job with a recovered Codex transport warning in ${execution.durationMs}ms.`
              : `Completed web chat runner job in ${execution.durationMs}ms.`,
            resolved_write_branch:
              persistenceResult.resolvedWriteBranch ||
              preparedWorkspace.durableWriteBranch ||
              undefined,
            resolved_pull_request_number: resolvedPullRequestNumber,
            resolved_pull_request_url: resolvedPullRequestUrl,
            resolved_pull_request_title: persistenceResult.pullRequestTitle || "",
            assistant_message: assistantMessage,
            assistant_metadata: {
              exit_code: execution.exitCode,
              signal: execution.signal || "",
              timed_out: execution.timedOut,
              duration_ms: execution.durationMs,
              codex_session_mode: executionMode,
              codex_session_id: persistedCodexSessionState.session_id,
              codex_session_bundle_revision: persistedCodexSessionState.bundle_revision,
              codex_session_cli_version: persistedCodexSessionState.cli_version,
              codex_session_last_compaction_observed_at:
                persistedCodexSessionState.last_compaction_observed_at,
              thread_target_restart_count: threadTargetRestartCount,
              ...(recoveredTransportFailure
                ? {
                    codex_transport_recovered: true,
                    codex_transport_warning_message: truncate(
                      normalizeText(execution.diagnosticOutput) || normalizeText(execution.reason),
                      1000,
                    ),
                  }
                : {}),
              ...(nonFatalCodexSessionLoadWarning
                ? {
                    codex_session_load_warning: truncate(
                      nonFatalCodexSessionLoadWarning,
                      1000,
                    ),
                    codex_session_continuity_degraded: true,
                  }
                : {}),
            },
            started_at: startedAt,
            completed_at: completedAt,
            metadata: buildCodexRunMetadata({
              model: codexModel,
              mode: executionMode,
              extra: {
                exit_code: execution.exitCode,
                signal: execution.signal || "",
                timed_out: execution.timedOut,
                duration_ms: execution.durationMs,
                codex_session_id: persistedCodexSessionState.session_id,
                codex_session_bundle_revision: persistedCodexSessionState.bundle_revision,
                codex_session_cli_version: persistedCodexSessionState.cli_version,
                codex_session_last_compaction_observed_at:
                  persistedCodexSessionState.last_compaction_observed_at,
                thread_target_restart_count: threadTargetRestartCount,
                ...(recoveredTransportFailure
                  ? {
                      codex_transport_recovered: true,
                      codex_transport_warning_message: truncate(
                        normalizeText(execution.diagnosticOutput) || normalizeText(execution.reason),
                        1000,
                      ),
                    }
                  : {}),
                ...(nonFatalCodexSessionLoadWarning
                  ? {
                      codex_session_load_warning: truncate(
                        nonFatalCodexSessionLoadWarning,
                        1000,
                      ),
                      codex_session_continuity_degraded: true,
                    }
                  : {}),
              },
            }),
          },
        });
        log(
          "Web chat runner completed successfully",
          `duration_ms=${execution.durationMs}`,
        );
        return;
      } catch (error) {
        runBodyError = error;
        throw error;
      } finally {
        if (activeChatGptAccount && !skipChatGptAccountFinalization) {
          try {
            const finalizationResult = await finalizeChatGptAccountAuth({
              workerUrl: chatGptAccountWorkerUrl,
              adminToken,
              codexHome: attemptRunRuntime.codexHome,
              ownerGithubLogin: activeChatGptAccount.ownerGithubLogin,
              accountId: activeChatGptAccount.accountId,
              threadId,
              runId,
              runError: runBodyError,
            });
            if (finalizationResult.status === "reauth_required") {
              log(
                "Marked ChatGPT account for reauthentication after web chat run",
                `account_id=${finalizationResult.accountId} owner=${activeChatGptAccount.ownerGithubLogin}`,
              );
            } else {
              log(
                "Persisted ChatGPT account auth for web chat run",
                `account_id=${finalizationResult.accountId} owner=${activeChatGptAccount.ownerGithubLogin}`,
              );
            }
          } catch (error) {
            const finalizationMessage = extractErrorMessage(
              error,
              "Unable to finalize ChatGPT account auth.",
            );
            log("ERROR", finalizationMessage);
            if (!runBodyError) {
              throw new Error(finalizationMessage);
            }
          }
        }
        if (runRuntime === attemptRunRuntime) {
          runRuntime = null;
        }
        await cleanupWebChatRunRuntime(attemptRunRuntime);
      }
    }
  } catch (error) {
    const message = extractErrorMessage(error);
    log("ERROR", message);

    try {
      await postRunCallback({
        publicBaseUrl,
        workerUrl,
        adminToken,
        body: {
          thread_id: threadId,
          run_id: runId,
          message_id: messageId,
          workspace_repository: workspaceRepository,
          status: "failed",
          summary: message,
          error: message,
          ...(normalizeText(preparedWorkspace?.effectiveWriteBranch)
            ? {
                resolved_write_branch: normalizeText(preparedWorkspace?.effectiveWriteBranch),
              }
            : {}),
          assistant_message:
            truncate(
              assistantMessage ||
                toUserVisibleRunnerFailureMessage(message),
              MAX_OUTPUT_CHARS,
            ),
          started_at: startedAt || undefined,
          completed_at: Date.now(),
          metadata: buildCodexRunMetadata({
            model: codexModel,
            mode: executionMode,
            extra: {
              codex_session_id: persistedCodexSessionState.session_id,
              codex_session_bundle_revision: persistedCodexSessionState.bundle_revision,
              thread_target_restart_count: threadTargetRestartCount,
              ...(nonFatalCodexSessionLoadWarning
                ? {
                    codex_session_load_warning: truncate(
                      nonFatalCodexSessionLoadWarning,
                      1000,
                    ),
                    codex_session_continuity_degraded: true,
                  }
                : {}),
            },
          }),
        },
      });
    } catch (callbackError) {
      log(
        "ERROR",
        `Failed to post web chat failure callback: ${
          callbackError instanceof Error ? callbackError.message : String(callbackError)
        }`,
      );
    }

    process.exitCode = 1;
  } finally {
    await cleanupWebChatRunRuntime(runRuntime);
  }
}

export {
  applyRunControlPlaneContextToCallbackBody,
  applyWorkspaceGitToken,
  applyWorkspaceGitIdentity,
  buildCodexPrompt,
  buildCodexRunMetadata,
  buildGitHubActionsControlPlaneUrl,
  buildFreshPromptHistoryMessages,
  buildResumePrompt,
  captureCodexSessionBundle,
  checkoutPreparedWorkspaceBranch,
  checkoutOriginBranch,
  clearGitOperationState,
  loadCodexSessionStateForExecution,
  clearRecoverableCodexSessionErrorState,
  configureWorkspacePushPolicy,
  findBrokenRemoteTrackingRefs,
  applyCodeq8CliRuntimeEnv,
  isInvalidCodexSessionBundleError,
  isRecoverableWorkspaceRefRefreshFailure,
  isRecoverableCodexTransportFailure,
  isRecoverableCodexResumeFailure,
  isRecoverableCodexSessionErrorState,
  parseCodexSessionBundleContents,
  isRetryableCodexSessionPersistenceError,
  persistCapturedCodexSessionBundleWithRetries,
  persistWorkspaceProgress,
  postRunCallback,
  prepareCodeq8Cli,
  prepareChatGptAccountAuth,
  prepareGitHubCliAuth,
  refreshWorkspaceRemoteRefs,
  syncChatGptAccountAuth,
  validateChatGptAccountAuth,
  readFirstCommitPresentation,
  requestWorkspaceGitToken,
  readBranchDivergenceCounts,
  resolveEffectiveWriteBranch,
  resolveGitIdentityFromGitHubUserToken,
  resolvePreferredGitIdentity,
  resolveGitHubCliPath,
  resolveReviewBaseBranch,
  resolveRunControlPlaneContext,
  resolveWebChatGitHubWriteToken,
  resolveWebChatRunnerAdminToken,
  resolveWebChatGitHubUserToken,
  requireWebChatGitHubWriteToken,
  requireWebChatGitHubUserToken,
  runCodex,
  shouldEnsurePullRequest,
  shouldTreatCodexFailureAsCompleted,
  stripLeadingCodexTransportNoise,
  toUserVisibleRunnerFailureMessage,
};

const executedAsScript =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (executedAsScript) {
  await main();
}
