#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, createSign, webcrypto } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
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
  resolveWorkerBaseUrl,
} from "../lib/code-worker-url.mjs";
import {
  REQUIRED_WEB_CHAT_RUNNER_RUNTIME_CAPABILITIES,
  REQUIRED_WEB_CHAT_RUNNER_RUNTIME_PATHS,
  WEB_CHAT_RUNNER_RUNTIME_CONTRACT_VERSION,
  WEB_CHAT_RUNNER_RUNTIME_MANIFEST_PATH,
} from "../lib/web-chat-runner-runtime-manifest.mjs";
import {
  WEB_CHAT_RUNNER_CODEQ8_FILE_PATH,
  WEB_CHAT_RUNNER_CODEQ8_FILE_SAVE_PATH,
  WEB_CHAT_RUNNER_DIAGNOSTIC_PATH,
  supportsServerOwnedCodeq8FileSync,
  supportsServerOwnedDiscordDmChat,
  webChatRunnerCodeq8FileResponseSchema,
  webChatRunnerCodeq8FileSaveResponseSchema,
  webChatRunnerDiagnosticResponseSchema,
  webChatRunnerPromptResponseSchema,
  webChatRunnerRuntimeManifestResponseSchema,
} from "../lib/web-chat-runner-runtime-contract.mjs";
const DEFAULT_CODE_PUBLIC_URL = "https://codeq8.com";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CODEX_REASONING_EFFORT = "xhigh";
const DEFAULT_TIMEOUT_SECONDS = 72 * 60 * 60;
const DEFAULT_GIT_HTTP_LOW_SPEED_LIMIT = "1";
const DEFAULT_GIT_HTTP_LOW_SPEED_TIME = "45";
const MAX_MESSAGE_CHARS = 2000;
const MAX_OUTPUT_CHARS = 120000;
const MAX_REFERENCED_THREAD_MESSAGES = 8;
const MAX_THREAD_TARGET_RESTARTS = 2;
const MAX_CODEX_RESUME_RECOVERY_ATTEMPTS = 1;
const MAX_RUNNER_DIAGNOSTIC_DETAIL_KEYS = 32;
const MAX_RUNNER_DIAGNOSTIC_STRING_CHARS = 2000;
const APP_SERVER_PROGRESS_BATCH_INTERVAL_MS = 3000;
const APP_SERVER_PROGRESS_MAX_BATCH_SIZE = 12;
const APP_SERVER_PROGRESS_MAX_EVENTS_PER_RUN = 200;
const APP_SERVER_PROGRESS_MAX_LABEL_CHARS = 280;
const APP_SERVER_CONTROL_POLL_INTERVAL_MS = 1000;
const APP_SERVER_ATTACHMENT_TURN_CONTROL_CAPABILITY =
  "codex_app_server_attachment_turn_control";
const APP_SERVER_CONTROL_CAPABILITIES = Object.freeze([
  APP_SERVER_ATTACHMENT_TURN_CONTROL_CAPABILITY,
]);
const APP_SERVER_NOTIFICATION_SUMMARY_MAX_METHODS = 8;
const APP_SERVER_NOTIFICATION_TRACE_METHODS = new Set([
  "turn/started",
  "turn/completed",
]);
const APP_SERVER_NOTIFICATION_SUMMARY_LABELS = new Map([
  ["account/rateLimits/updated", "rate_limit_updates"],
  ["item/agentMessage/delta", "agent_message_deltas"],
  ["item/completed", "items_completed"],
  ["item/started", "items_started"],
  ["mcpServer/startupStatus/updated", "mcp_startup_updates"],
  ["remoteControl/status/changed", "remote_control_status_updates"],
  ["thread/goal/cleared", "thread_goal_clears"],
  ["thread/status/changed", "thread_status_updates"],
  ["thread/tokenUsage/updated", "token_usage_updates"],
  ["turn/completed", "turn_completed"],
  ["turn/started", "turn_started"],
]);
const CODEX_AUTH_PRECHECK_TIMEOUT_SECONDS = 45;
const WEB_CHAT_RUNNER_DIAGNOSTIC_SOURCE = "web_chat_runner_diagnostic";
const WEB_CHAT_RUN_MARKER_VERSION = "v1";
const WEB_CHAT_RUN_MARKER_PREFIX = "codeq8-run-marker";
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
const WEB_CHAT_CODEX_SESSION_ENCRYPTED_BLOB_SCOPE = "web_chat_codex_session_bundle";
const RETRYABLE_WEB_CHAT_ATTACHMENT_READ_STATUSES = new Set([
  408,
  425,
  429,
  500,
  502,
  503,
  504,
]);
const FIREBASE_STORAGE_READ_ONLY_SCOPE =
  "https://www.googleapis.com/auth/devstorage.read_only";
const FIREBASE_SERVICE_ACCOUNT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const firebaseStorageAccessTokenCache = new Map();

function normalizeText(value) {
  return String(value || "").trim();
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

function extractUserVisibleFailureHeadline(value, fallback = "") {
  const normalizedFallback = normalizeText(fallback);
  const message = normalizeText(stripLeadingCodexTransportNoise(extractErrorMessage(value)));
  if (!message) {
    return normalizedFallback;
  }
  const lines = message
    .split(/\r?\n/g)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  return lines[0] || normalizedFallback;
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
    app_server_control_capabilities: [...APP_SERVER_CONTROL_CAPABILITIES],
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

function hashDiagnosticValue(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function redactDiagnosticText(value) {
  return String(value ?? "")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[redacted_github_token]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[redacted_jwt]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._-]{20,}/gi, "$1[redacted]")
    .replace(/(token|secret|password|private[_-]?key|credential)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/https:\/\/[^:@/\s]+:[^@/\s]+@github\.com/gi, "https://[redacted]@github.com");
}

function truncateDiagnosticString(value) {
  const redacted = redactDiagnosticText(value);
  if (redacted.length <= MAX_RUNNER_DIAGNOSTIC_STRING_CHARS) {
    return redacted;
  }
  return `${redacted.slice(0, MAX_RUNNER_DIAGNOSTIC_STRING_CHARS)}...[truncated ${redacted.length - MAX_RUNNER_DIAGNOSTIC_STRING_CHARS} chars]`;
}

function sanitizeDiagnosticDetailValue(value, depth = 0) {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return truncateDiagnosticString(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= 2) {
      return "[max_depth]";
    }
    return value.slice(0, 24).map((entry) => sanitizeDiagnosticDetailValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 2) {
      return "[max_depth]";
    }
    const output = {};
    for (const [key, entry] of Object.entries(value).slice(0, MAX_RUNNER_DIAGNOSTIC_DETAIL_KEYS)) {
      const normalizedKey = normalizeText(key);
      if (!normalizedKey) {
        continue;
      }
      output[normalizedKey] = /authorization|cookie|token|secret|password|private[_-]?key|credential/i.test(
        normalizedKey,
      )
        ? "[redacted]"
        : sanitizeDiagnosticDetailValue(entry, depth + 1);
    }
    return output;
  }
  return truncateDiagnosticString(String(value));
}

function sanitizeDiagnosticDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const output = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_RUNNER_DIAGNOSTIC_DETAIL_KEYS)) {
    const normalizedKey = normalizeText(key);
    if (!normalizedKey) {
      continue;
    }
    output[normalizedKey] = /authorization|cookie|token|secret|password|private[_-]?key|credential/i.test(
      normalizedKey,
    )
      ? "[redacted]"
      : sanitizeDiagnosticDetailValue(entry, 0);
  }
  return output;
}

function normalizeRunnerDiagnosticMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === "fresh" || normalized === "resume" ? normalized : "unknown";
}

function normalizeRunnerDiagnosticSeverity(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === "warning" || normalized === "error" || normalized === "trace"
    ? normalized
    : "trace";
}

function buildWebChatRunMarker({ threadId, runId }) {
  const normalizedThreadId = normalizeThreadId(threadId) || normalizeText(threadId);
  const normalizedRunId = normalizeRunId(runId) || normalizeText(runId);
  if (!normalizedThreadId || !normalizedRunId) {
    return "";
  }
  return `${WEB_CHAT_RUN_MARKER_PREFIX}:${WEB_CHAT_RUN_MARKER_VERSION}:${hashDiagnosticValue(
    `${normalizedThreadId}:${normalizedRunId}:${WEB_CHAT_RUN_MARKER_VERSION}`,
  )}`;
}

function appendWebChatRunMarkerToPrompt({ prompt, marker }) {
  const normalizedPrompt = normalizeText(prompt);
  const normalizedMarker = normalizeText(marker);
  if (!normalizedPrompt || !normalizedMarker) {
    return normalizedPrompt;
  }
  return [
    normalizedPrompt,
    "",
    `Codeq8 runner integrity marker (do not mention in the reply): ${normalizedMarker}`,
  ].join("\n");
}

function sessionContainsWebChatRunMarker({ sessionFileContents, marker }) {
  const normalizedMarker = normalizeText(marker);
  return Boolean(normalizedMarker && String(sessionFileContents || "").includes(normalizedMarker));
}

function summarizeCodexSessionStateForDiagnostic(value) {
  const state = normalizeCodexSessionState(value);
  return {
    status: state.status,
    session_id_hash: hashDiagnosticValue(state.session_id),
    session_file_relative_path_hash: hashDiagnosticValue(state.session_file_relative_path),
    has_bundle_storage_key: Boolean(state.bundle_storage_key),
    storage_backend: state.storage_backend,
    bundle_revision: state.bundle_revision,
    bundle_size_bytes: state.bundle_size_bytes,
    bundle_compressed_size_bytes: state.bundle_compressed_size_bytes,
    target_signature_hash: hashDiagnosticValue(state.target_signature),
    cli_version: state.cli_version,
    model: state.model,
    last_run_id: state.last_run_id,
    last_uploaded_at: state.last_uploaded_at,
    last_resumed_at: state.last_resumed_at,
    last_compaction_observed_at: state.last_compaction_observed_at,
    has_last_error: Boolean(state.last_error),
    ...(state.last_error ? { last_error: truncateDiagnosticString(state.last_error) } : {}),
  };
}

function toBase64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = normalizeText(value).replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized) {
    return new Uint8Array();
  }
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return new Uint8Array(Buffer.from(padded, "base64"));
}

function gzipUtf8TextBytes(value) {
  return new Uint8Array(gzipSync(Buffer.from(String(value || ""), "utf8")));
}

function webChatCodexSessionAdditionalData({ threadId, storageKey }) {
  const normalizedThreadId = normalizeThreadId(threadId);
  const normalizedStorageKey = normalizeText(storageKey);
  if (!normalizedThreadId || !normalizedStorageKey) {
    return "";
  }
  return `${WEB_CHAT_CODEX_SESSION_ENCRYPTED_BLOB_SCOPE}:${normalizedThreadId}:${normalizedStorageKey}`;
}

function webChatCodexSessionWrappedKeyAdditionalData({ threadId, storageKey }) {
  const normalizedThreadId = normalizeThreadId(threadId);
  const normalizedStorageKey = normalizeText(storageKey);
  if (!normalizedThreadId || !normalizedStorageKey) {
    return "";
  }
  return `${WEB_CHAT_CODEX_SESSION_ENCRYPTED_BLOB_SCOPE}:key:${normalizedThreadId}:${normalizedStorageKey}`;
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
    /^ERROR:\s*Selected model is at capacity\. Please try a different model\.?$/i,
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
    /selected model is at capacity/i,
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
  const rawMessage = normalizeText(extractErrorMessage(value));
  if (/selected model is at capacity/i.test(rawMessage)) {
    return "The selected Codex model is temporarily at capacity. Retry the run.";
  }
  const message = extractUserVisibleFailureHeadline(value);
  if (!message) {
    return "I couldn't complete that run.";
  }
  if (
    /failed to refresh token/i.test(message) ||
    /refresh_token_reused/i.test(message) ||
    /access token could not be refreshed/i.test(message) ||
    /please try signing in again/i.test(message)
  ) {
    return "Codex is not logged in on this self-hosted runner. Sign in on the runner, then retry.";
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

function normalizeCodexSessionErrorStateMessage(value) {
  let normalized = normalizeText(value);
  while (/^codex session state is in error status:\s*/i.test(normalized)) {
    normalized = normalized
      .replace(/^codex session state is in error status:\s*/i, "")
      .trim();
  }
  return normalized;
}

function isSupersededWebChatRunError(value) {
  const normalized = normalizeCodexSessionErrorStateMessage(value);
  if (!normalized) {
    return false;
  }
  return (
    /run\s+wcr_[A-Za-z0-9._:@-]+\s+was superseded by a newer message/i.test(normalized) ||
    /run\s+wcr_[A-Za-z0-9._:@-]+\s+is already cancell?ed/i.test(normalized) ||
    /superseded by a newer web chat message/i.test(normalized) ||
    /cancelled because a newer user message arrived/i.test(normalized)
  );
}

function isRecoverableCodexSessionErrorState(value) {
  const normalized = normalizeCodexSessionErrorStateMessage(value);
  if (!normalized) {
    return false;
  }
  return (
    isSupersededWebChatRunError(normalized) ||
    /authorization token path mismatch/i.test(normalized) ||
    /failed to update web chat codex session state/i.test(normalized) ||
    /web chat codex session revision conflict/i.test(normalized) ||
    /codex run finished without creating a session bundle/i.test(normalized) ||
    /web_chat_session_bundles/i.test(normalized) ||
    /unexpected non-whitespace character after JSON at position/i.test(normalized) ||
    /stored codex session bundle is still wrapped in the encrypted storage envelope/i.test(
      normalized,
    ) ||
    /stored codex session bundle is not a valid codex session file/i.test(normalized) ||
    /failed to parse thread ID from rollout file/i.test(normalized) ||
    /worker request failed:\s*fetch failed/i.test(normalized) ||
    /^fetch failed$/i.test(normalized)
  );
}

function isInvalidCodexSessionBundleError(value) {
  const normalized = normalizeCodexSessionErrorStateMessage(value);
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
  const normalized = normalizeCodexSessionErrorStateMessage(value);
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

function shouldContinueAfterCodexSessionPersistenceFailure(value) {
  const normalized = normalizeCodexSessionErrorStateMessage(value);
  if (!normalized) {
    return false;
  }
  return (
    /^fetch failed$/i.test(normalized) ||
    /worker request failed:\s*fetch failed/i.test(normalized) ||
    /web chat codex session revision conflict/i.test(normalized) ||
    /network/i.test(normalized) ||
    /timed out/i.test(normalized) ||
    /timeout/i.test(normalized) ||
    /temporary/i.test(normalized) ||
    /upstream/i.test(normalized)
  );
}

function isCodexSessionRevisionConflictError(value) {
  return /web chat codex session revision conflict/i.test(normalizeText(value));
}

function isReadyCodexSessionStateForRun(codexSessionState, runId) {
  const normalizedState = normalizeCodexSessionState(codexSessionState);
  return (
    normalizedState.status === "ready" &&
    normalizeText(normalizedState.last_run_id) === normalizeText(runId) &&
    normalizedState.bundle_revision > 0 &&
    Boolean(normalizedState.bundle_storage_key)
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
  const storageBackend = normalizeText(
    normalized.storage_backend || normalized.storageBackend,
  ).toLowerCase();
  const storageBucket = normalizeText(
    normalized.storage_bucket || normalized.storageBucket,
  );
  const storageKey = normalizeText(normalized.storage_key || normalized.storageKey);
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
    ...(storageBackend ? { storage_backend: storageBackend } : {}),
    ...(storageBucket ? { storage_bucket: storageBucket } : {}),
    ...(storageKey ? { storage_key: storageKey } : {}),
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

async function workerTextRequest({ workerUrl, adminToken, path, method, query, body }) {
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
      ...(method === "POST" ? { "Content-Type": "text/plain; charset=utf-8" } : {}),
    },
    ...(method === "POST" ? { body: String(body || "") } : {}),
  });
}

async function prepareWebChatCodexSessionUpload({
  workerUrl,
  adminToken,
  threadId,
  expectedBundleRevision = null,
}) {
  const response = await workerJsonRequest({
    workerUrl,
    adminToken,
    path: "/web-chat/codex-session/upload-prepare",
    method: "POST",
    body: {
      thread_id: normalizeText(threadId),
      ...(expectedBundleRevision !== null && expectedBundleRevision !== undefined
        ? { expected_bundle_revision: parseNonNegativeInteger(expectedBundleRevision, 0) }
        : {}),
    },
  });
  if (!response.ok || response.payload.ok === false) {
    throw new Error(
      extractErrorMessage(response.payload.error) ||
        `Failed to prepare web chat codex session upload (${response.status}).`,
    );
  }
  const uploadPreparation = normalizeObject(
    response.payload.upload_preparation || response.payload.uploadPreparation,
  );
  return {
    thread: normalizeObject(response.payload.thread),
    codexSessionState: normalizeCodexSessionState(
      response.payload.codex_session_state || response.payload.codexSessionState,
    ),
    uploadPreparation: {
      storageKey: normalizeText(uploadPreparation.storage_key || uploadPreparation.storageKey),
      storageBucket: normalizeText(
        uploadPreparation.storage_bucket || uploadPreparation.storageBucket,
      ),
      storageBackend: normalizeText(
        uploadPreparation.storage_backend || uploadPreparation.storageBackend,
      ),
      uploadKey: normalizeText(uploadPreparation.upload_key || uploadPreparation.uploadKey),
      wrappedKey: normalizeText(uploadPreparation.wrapped_key || uploadPreparation.wrappedKey),
      wrappedKeyIv: normalizeText(
        uploadPreparation.wrapped_key_iv || uploadPreparation.wrappedKeyIv,
      ),
      expectedBundleRevision: parseNonNegativeInteger(
        uploadPreparation.expected_bundle_revision ??
          uploadPreparation.expectedBundleRevision ??
          0,
        0,
      ),
      nextBundleRevision: parsePositiveInteger(
        uploadPreparation.next_bundle_revision || uploadPreparation.nextBundleRevision || 0,
        0,
      ),
    },
  };
}

async function uploadPreparedWebChatCodexSessionBundle({
  workerUrl,
  adminToken,
  threadId,
  storageKey,
  storageBucket,
  storageBackend,
  storedValue,
}) {
  const query = new URLSearchParams({
    thread_id: normalizeText(threadId),
    storage_key: normalizeText(storageKey),
    storage_bucket: normalizeText(storageBucket),
    storage_backend: normalizeText(storageBackend),
  });
  const response = await workerTextRequest({
    workerUrl,
    adminToken,
    path: "/web-chat/codex-session/upload-direct",
    method: "POST",
    query,
    body: String(storedValue || ""),
  });
  if (!response.ok || response.payload.ok === false) {
    throw new Error(
      extractErrorMessage(response.payload.error) ||
        `Failed to upload web chat codex session bundle (${response.status}).`,
    );
  }
  return {
    storageKey: normalizeText(
      response.payload.storage_key || response.payload.storageKey || storageKey,
    ),
    storageBucket: normalizeText(
      response.payload.storage_bucket || response.payload.storageBucket || storageBucket,
    ),
    storageBackend: normalizeText(
      response.payload.storage_backend || response.payload.storageBackend || storageBackend,
    ),
  };
}

async function discardPreparedWebChatCodexSessionBundle({
  workerUrl,
  adminToken,
  threadId,
  storageKey,
  storageBucket,
  storageBackend,
}) {
  const response = await workerJsonRequest({
    workerUrl,
    adminToken,
    path: "/web-chat/codex-session/upload-discard",
    method: "POST",
    body: {
      thread_id: normalizeText(threadId),
      storage_key: normalizeText(storageKey),
      storage_bucket: normalizeText(storageBucket),
      storage_backend: normalizeText(storageBackend),
    },
  });
  if (!response.ok || response.payload.ok === false) {
    throw new Error(
      extractErrorMessage(response.payload.error) ||
        `Failed to discard web chat codex session bundle (${response.status}).`,
    );
  }
}

async function buildUploadedCodexSessionStoredValue({
  threadId,
  storageKey,
  uploadKey,
  wrappedKey,
  wrappedKeyIv,
  sessionFileContents,
}) {
  const additionalData = webChatCodexSessionAdditionalData({ threadId, storageKey });
  const wrappedKeyAdditionalData = webChatCodexSessionWrappedKeyAdditionalData({
    threadId,
    storageKey,
  });
  const normalizedContents = String(sessionFileContents || "");
  if (
    !additionalData ||
    !wrappedKeyAdditionalData ||
    !normalizedContents ||
    !normalizeText(uploadKey) ||
    !normalizeText(wrappedKey) ||
    !normalizeText(wrappedKeyIv)
  ) {
    throw new Error(
      "thread_id, storage_key, upload_key, wrapped_key, wrapped_key_iv, and session_file_contents are required.",
    );
  }

  const rawBytes = new TextEncoder().encode(normalizedContents);
  const compressedBytes = gzipUtf8TextBytes(normalizedContents);
  const dataKeyBytes = fromBase64Url(uploadKey);
  if (dataKeyBytes.byteLength !== 32) {
    throw new Error("web chat codex session upload key is invalid.");
  }
  const dataKey = await webcrypto.subtle.importKey(
    "raw",
    dataKeyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await webcrypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(additionalData),
      },
      dataKey,
      compressedBytes,
    ),
  );

  return {
    storedValue: JSON.stringify({
      version: 3,
      scope: WEB_CHAT_CODEX_SESSION_ENCRYPTED_BLOB_SCOPE,
      algorithm: "AES-GCM-256",
      content_encoding: "gzip",
      raw_size_bytes: rawBytes.length,
      compressed_size_bytes: compressedBytes.length,
      wrapped_key: normalizeText(wrappedKey),
      wrapped_key_iv: normalizeText(wrappedKeyIv),
      iv: toBase64Url(iv),
      ciphertext: toBase64Url(encrypted),
    }),
    bundleSizeBytes: rawBytes.length,
    bundleCompressedSizeBytes: compressedBytes.length,
  };
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

async function requestWebChatRunnerRuntimeJson({
  publicBaseUrl,
  webChatRunToken,
  path,
  body,
  schema = null,
  responseLabel = "Codeq8 runner runtime response",
}) {
  const normalizedPublicBaseUrl = normalizeCodePublicBaseUrl(publicBaseUrl);
  const normalizedToken = normalizeText(webChatRunToken);
  if (!normalizedToken || normalizedToken.split(".").length !== 3) {
    throw new Error(
      "A scoped CODE_WEB_CHAT_RUN_TOKEN is required for the Codeq8 runner runtime contract.",
    );
  }

  const response = await fetchJson(new URL(path, normalizedPublicBaseUrl).toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${normalizedToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body || {}),
  });
  const contractVersion = normalizeText(response.payload?.contract_version);
  if (
    !response.ok ||
    response.payload?.ok === false ||
    contractVersion !== WEB_CHAT_RUNNER_RUNTIME_CONTRACT_VERSION
  ) {
    const errorMessage =
      normalizeText(response.payload?.error || response.payload?.message || response.textBody) ||
      `Codeq8 runner runtime request failed (${response.status}).`;
    throw new Error(errorMessage);
  }
  if (!schema) {
    return response.payload;
  }
  const parsed = schema.safeParse(response.payload);
  if (!parsed.success) {
    throw new Error(`${normalizeText(responseLabel) || "Codeq8 runner runtime response"} is invalid.`);
  }
  return parsed.data;
}

function buildWebChatRunnerDiagnosticRequest({
  event,
  failureClass = "",
  severity = "trace",
  ok = true,
  mode = "unknown",
  workspaceRepository = "",
  threadId = "",
  runId = "",
  messageId = "",
  details = {},
}) {
  const normalizedEvent = normalizeText(event);
  return {
    source: WEB_CHAT_RUNNER_DIAGNOSTIC_SOURCE,
    event: normalizedEvent,
    failure_class: normalizeText(failureClass) || normalizedEvent,
    severity: normalizeRunnerDiagnosticSeverity(severity),
    ok: Boolean(ok),
    workspace_repository: normalizeText(workspaceRepository),
    thread_id: normalizeText(threadId),
    run_id: normalizeText(runId),
    message_id: normalizeText(messageId),
    mode: normalizeRunnerDiagnosticMode(mode),
    details: sanitizeDiagnosticDetails(details),
  };
}

async function postWebChatRunnerDiagnostic({
  publicBaseUrl,
  webChatRunToken,
  diagnostic,
}) {
  const normalizedToken = normalizeText(webChatRunToken);
  if (!normalizedToken || normalizedToken.split(".").length !== 3) {
    return {
      ok: false,
      skipped: true,
      reason: "missing_scoped_run_token",
      status: 0,
    };
  }

  const response = await fetchJson(
    new URL(WEB_CHAT_RUNNER_DIAGNOSTIC_PATH, normalizeCodePublicBaseUrl(publicBaseUrl)).toString(),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${normalizedToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(diagnostic),
    },
  );
  const parsed = webChatRunnerDiagnosticResponseSchema.safeParse(response.payload);
  const payload = parsed.success ? parsed.data : response.payload;
  return {
    ok: response.ok && payload.ok !== false,
    skipped: Boolean(payload.report?.skipped),
    reason: normalizeText(payload.report?.reason),
    error: normalizeText(payload.report?.error || payload.error || payload.message),
    status: response.status || Number(payload.report?.status || 0) || 0,
  };
}

function createWebChatRunnerDiagnosticReporter({
  publicBaseUrl,
  webChatRunToken,
  workspaceRepository,
  threadId,
  runId,
  messageId,
}) {
  return async function reportWebChatRunnerDiagnostic(input = {}) {
    const diagnostic = buildWebChatRunnerDiagnosticRequest({
      ...normalizeObject(input),
      workspaceRepository,
      threadId,
      runId,
      messageId,
    });
    if (!diagnostic.event || !diagnostic.workspace_repository || !diagnostic.thread_id || !diagnostic.run_id) {
      return {
        ok: false,
        skipped: true,
        reason: "invalid_diagnostic_context",
        status: 0,
      };
    }
    try {
      const result = await postWebChatRunnerDiagnostic({
        publicBaseUrl,
        webChatRunToken,
        diagnostic,
      });
      if (!result.ok && !result.skipped) {
        log(
          "WARN",
          "Runner diagnostic reporting failed",
          `event=${diagnostic.event} status=${result.status} reason=${truncateDiagnosticString(
            result.error || result.reason || "unknown",
          )}`,
        );
      }
      return result;
    } catch (error) {
      log(
        "WARN",
        "Runner diagnostic reporting failed",
        `event=${diagnostic.event} reason=${truncateDiagnosticString(extractErrorMessage(error))}`,
      );
      return {
        ok: false,
        skipped: false,
        reason: "request_failed",
        error: extractErrorMessage(error),
        status: 0,
      };
    }
  };
}

async function maybeReportRunnerDiagnostic(reportRunnerDiagnostic, diagnostic) {
  if (typeof reportRunnerDiagnostic !== "function") {
    return {
      ok: false,
      skipped: true,
      reason: "diagnostic_reporter_missing",
      status: 0,
    };
  }
  return reportRunnerDiagnostic(diagnostic);
}

async function requestWebChatRunnerRuntimeManifest({
  publicBaseUrl,
  webChatRunToken,
  workspaceRepository,
  threadId,
  runId,
}) {
  return requestWebChatRunnerRuntimeJson({
    publicBaseUrl,
    webChatRunToken,
    path: WEB_CHAT_RUNNER_RUNTIME_MANIFEST_PATH,
    body: {
      workspace_repository: normalizeText(workspaceRepository),
      thread_id: normalizeText(threadId),
      run_id: normalizeText(runId),
    },
    schema: webChatRunnerRuntimeManifestResponseSchema,
    responseLabel: "Codeq8 runner runtime manifest response",
  });
}

function listMissingRuntimeEntries(requiredEntries = [], actualEntries = []) {
  const actualEntrySet = new Set(
    (Array.isArray(actualEntries) ? actualEntries : [])
      .map((entry) => normalizeText(entry))
      .filter(Boolean),
  );
  return (Array.isArray(requiredEntries) ? requiredEntries : []).filter(
    (entry) => normalizeText(entry) && !actualEntrySet.has(normalizeText(entry)),
  );
}

async function assertWebChatRunnerRuntimeCompatibility({
  publicBaseUrl,
  webChatRunToken,
  workspaceRepository,
  threadId,
  runId,
  requiredCapabilities = REQUIRED_WEB_CHAT_RUNNER_RUNTIME_CAPABILITIES,
  requiredPaths = REQUIRED_WEB_CHAT_RUNNER_RUNTIME_PATHS,
}) {
  const manifest = await requestWebChatRunnerRuntimeManifest({
    publicBaseUrl,
    webChatRunToken,
    workspaceRepository,
    threadId,
    runId,
  });
  const missingCapabilities = listMissingRuntimeEntries(
    requiredCapabilities,
    manifest.capabilities,
  );
  const authorizedPaths = Array.from(
    new Set([
      ...(Array.isArray(manifest.authorized_paths) ? manifest.authorized_paths : []),
      ...(Array.isArray(manifest.scoped_authorized_paths)
        ? manifest.scoped_authorized_paths
        : []),
    ]),
  );
  const missingPaths = listMissingRuntimeEntries(
    requiredPaths,
    authorizedPaths,
  );
  if (missingCapabilities.length > 0 || missingPaths.length > 0) {
    const problems = [];
    if (missingCapabilities.length > 0) {
      problems.push(`missing capabilities: ${missingCapabilities.join(", ")}`);
    }
    if (missingPaths.length > 0) {
      problems.push(`missing authorized paths: ${missingPaths.join(", ")}`);
    }
    throw new Error(
      `Codeq8 runner runtime manifest is incompatible (${problems.join("; ")}).`,
    );
  }
  return manifest;
}

function resolveWorkspaceRuntimeFilePath({ workspacePath, relativePath }) {
  const normalizedWorkspacePath = path.resolve(String(workspacePath || ""));
  const normalizedRelativePath = normalizeText(relativePath).replace(/^\/+/, "");
  if (!normalizedWorkspacePath || !normalizedRelativePath) {
    throw new Error("Workspace path and runtime file path are required.");
  }
  const resolvedPath = path.resolve(normalizedWorkspacePath, normalizedRelativePath);
  const relativeToWorkspace = path.relative(normalizedWorkspacePath, resolvedPath);
  if (
    relativeToWorkspace === ".." ||
    relativeToWorkspace.startsWith(`..${path.sep}`) ||
    path.isAbsolute(normalizedRelativePath)
  ) {
    throw new Error(`Runner runtime file path is outside the workspace: ${normalizedRelativePath}`);
  }
  return {
    absolutePath: resolvedPath,
    relativePath: relativeToWorkspace || path.basename(resolvedPath),
  };
}

async function ensureWorkspaceIgnoredRuntimeFile({ workspacePath, relativePath }) {
  const normalizedWorkspacePath = path.resolve(String(workspacePath || ""));
  const normalizedRelativePath = normalizeText(relativePath)
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");
  if (!normalizedWorkspacePath || !normalizedRelativePath) {
    return;
  }

  const excludePath = path.join(normalizedWorkspacePath, ".git", "info", "exclude");
  await ensureDirectory(path.dirname(excludePath));
  let existing = "";
  try {
    existing = await fs.readFile(excludePath, "utf8");
  } catch {
    existing = "";
  }
  const pattern = `/${normalizedRelativePath}`;
  const existingLines = existing
    .split(/\r?\n/g)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  if (existingLines.includes(pattern) || existingLines.includes(normalizedRelativePath)) {
    return;
  }
  const nextContents = existing
    ? `${existing.replace(/\s*$/u, "\n")}${pattern}\n`
    : `${pattern}\n`;
  await fs.writeFile(excludePath, nextContents, "utf8");
}

async function requestServerOwnedCodeq8File({
  publicBaseUrl,
  webChatRunToken,
  workspaceRepository,
  threadId,
  runId,
}) {
  return requestWebChatRunnerRuntimeJson({
    publicBaseUrl,
    webChatRunToken,
    path: WEB_CHAT_RUNNER_CODEQ8_FILE_PATH,
    body: {
      workspace_repository: normalizeText(workspaceRepository),
      thread_id: normalizeText(threadId),
      run_id: normalizeText(runId),
    },
    schema: webChatRunnerCodeq8FileResponseSchema,
    responseLabel: "Codeq8 runner codeq8.md response",
  });
}

async function saveServerOwnedCodeq8File({
  publicBaseUrl,
  webChatRunToken,
  workspaceRepository,
  threadId,
  runId,
  markdown,
  expectedRevisionId = "",
  changeSummary = "",
}) {
  return requestWebChatRunnerRuntimeJson({
    publicBaseUrl,
    webChatRunToken,
    path: WEB_CHAT_RUNNER_CODEQ8_FILE_SAVE_PATH,
    body: {
      workspace_repository: normalizeText(workspaceRepository),
      thread_id: normalizeText(threadId),
      run_id: normalizeText(runId),
      repo_workflow_prompt_markdown: String(markdown || ""),
      expected_revision_id: normalizeText(expectedRevisionId),
      change_summary: normalizeText(changeSummary),
    },
    schema: webChatRunnerCodeq8FileSaveResponseSchema,
    responseLabel: "Codeq8 runner codeq8.md save response",
  });
}

async function hydrateServerOwnedCodeq8File({
  publicBaseUrl,
  webChatRunToken,
  workspaceRepository,
  threadId,
  runId,
  workspacePath,
}) {
  const payload = await requestServerOwnedCodeq8File({
    publicBaseUrl,
    webChatRunToken,
    workspaceRepository,
    threadId,
    runId,
  });
  const resolvedFilePath = resolveWorkspaceRuntimeFilePath({
    workspacePath,
    relativePath: payload.prompt_file_path,
  });
  await ensureWorkspaceIgnoredRuntimeFile({
    workspacePath,
    relativePath: resolvedFilePath.relativePath,
  });
  await ensureDirectory(path.dirname(resolvedFilePath.absolutePath));
  await fs.writeFile(
    resolvedFilePath.absolutePath,
    String(payload.repo_workflow_prompt_markdown || ""),
    "utf8",
  );
  return {
    filePath: resolvedFilePath.absolutePath,
    relativePath: resolvedFilePath.relativePath.replace(/\\/g, "/"),
    promptMarkdown: String(payload.repo_workflow_prompt_markdown || ""),
    latestRevisionId: normalizeText(payload.latest_revision_id),
    latestRevisionNumber: Number(payload.latest_revision_number || 0) || 0,
  };
}

async function flushServerOwnedCodeq8File({
  publicBaseUrl,
  webChatRunToken,
  workspaceRepository,
  threadId,
  runId,
  hydratedFile,
  assistantMessage,
}) {
  if (!hydratedFile) {
    return {
      assistantMessage: normalizeText(assistantMessage),
      promptSaved: false,
      latestRevisionId: "",
      latestRevisionNumber: 0,
    };
  }

  const normalizedAssistantMessage = normalizeText(assistantMessage);
  let currentMarkdown = "";
  try {
    currentMarkdown = await fs.readFile(hydratedFile.filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Runner-owned ${hydratedFile.relativePath} file could not be read after the run: ${extractErrorMessage(error)}`,
    );
  }

  let nextMarkdown = currentMarkdown;
  let expectedRevisionId = hydratedFile.latestRevisionId;
  let changeSummary = "";
  if (nextMarkdown === hydratedFile.promptMarkdown) {
    return {
      assistantMessage: normalizedAssistantMessage,
      promptSaved: false,
      latestRevisionId: hydratedFile.latestRevisionId,
      latestRevisionNumber: hydratedFile.latestRevisionNumber,
    };
  }

  const saved = await saveServerOwnedCodeq8File({
    publicBaseUrl,
    webChatRunToken,
    workspaceRepository,
    threadId,
    runId,
    markdown: nextMarkdown,
    expectedRevisionId,
    changeSummary,
  });
  return {
    assistantMessage: normalizedAssistantMessage,
    promptSaved: !saved.unchanged,
    latestRevisionId: saved.latest_revision_id,
    latestRevisionNumber: saved.latest_revision_number,
  };
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

  const clearedInheritedHelpers = await runProcessCapture(
    "git",
    ["config", "--local", "--replace-all", "credential.helper", ""],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );
  if (!clearedInheritedHelpers.ok) {
    throw new Error("Unable to clear inherited workspace git credential helpers.");
  }

  const configuredHelper = await runProcessCapture(
    "git",
    ["config", "--local", "--add", "credential.helper", helperPath],
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

function shouldStopBeforeCodexForRunCallbackPayload(value) {
  const payload = normalizeObject(value);
  const run = normalizeObject(payload.run);
  const metadata = normalizeObject(run.metadata);
  const status = normalizeText(run.status).toLowerCase();
  return (
    payload.ignored === true &&
    status === "cancelled" &&
    (metadata.superseded_by_new_message === true ||
      metadata.superseded_by_message_edit === true ||
      metadata.stop_requested_by_user === true ||
      metadata.stopped_by_user === true)
  );
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

function assertTokenlessWorkspacePushRemoteUrl(remoteUrl) {
  const normalizedRemoteUrl = normalizeText(remoteUrl);
  if (!normalizedRemoteUrl) {
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(normalizedRemoteUrl);
  } catch {
    return;
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return;
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new Error(
      "Workspace push remote URLs must not embed credentials; use the workspace credential helper instead.",
    );
  }
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

async function readGitCommitSha({ workspacePath, commandEnv, ref = "HEAD" }) {
  const normalizedRef = normalizeText(ref) || "HEAD";
  const result = await runProcessCapture("git", ["rev-parse", normalizedRef], {
    cwd: workspacePath,
    env: commandEnv,
  });
  if (!result.ok) {
    return "";
  }
  return normalizeText(result.stdout);
}

async function readHeadCommitSha({ workspacePath, commandEnv }) {
  return readGitCommitSha({ workspacePath, commandEnv, ref: "HEAD" });
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
  const remoteHeadCommitSha =
    normalizedBranch && hasRemoteBranch
      ? await readGitCommitSha({
          workspacePath,
          commandEnv,
          ref: `origin/${normalizedBranch}`,
        }).catch(() => "")
      : "";
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
    remoteHeadCommitSha,
    statusFingerprint,
  };
}

function buildFinalWorkspaceStateCallbackPayload(state = null) {
  const normalizedState = normalizeObject(state);
  const branch = normalizeBranchName(normalizedState.branch);
  if (!branch || branch.toLowerCase() === "head") {
    return null;
  }
  return {
    branch,
    head_sha: normalizeText(normalizedState.headCommitSha),
    has_working_tree_changes: normalizedState.hasWorkingTreeChanges === true,
    has_remote_branch: normalizedState.hasRemoteBranch === true,
    ahead_count: parsePositiveInteger(normalizedState.aheadCount, 0),
    detached: false,
  };
}

async function readFinalWorkspaceStateCallbackPayload({
  workspacePath,
  commandEnv,
  branch = "",
}) {
  const finalBranch = normalizeBranchName(branch) || await currentBranch({
    workspacePath,
    commandEnv,
  }).catch(() => "");
  if (!finalBranch) {
    return null;
  }
  const state = await readWorkspacePersistenceState({
    workspacePath,
    commandEnv,
    branch: finalBranch,
  });
  return buildFinalWorkspaceStateCallbackPayload(state);
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
  assertTokenlessWorkspacePushRemoteUrl(normalizedRemoteUrl);
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

function shouldLookUpPullRequest({
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

async function readWebChatAttachment({
  workerUrl,
  adminToken,
  threadId,
  attachmentId,
  retries = 3,
  retryDelayMs = 750,
}) {
  const attempts = Math.max(1, parsePositiveInteger(retries, 3) || 3);
  let lastResponse = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
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
    lastResponse = response;
    if (response.ok && response.payload.ok !== false) {
      return {
        attachment: normalizeAttachmentRecord(response.payload.attachment),
        fileContentsBase64Url: normalizeText(
          response.payload.file_contents_base64url || response.payload.fileContentsBase64Url,
        ),
      };
    }
    if (
      !RETRYABLE_WEB_CHAT_ATTACHMENT_READ_STATUSES.has(response.status) ||
      attempt >= attempts
    ) {
      break;
    }
    log(
      "Web chat attachment read failed; retrying",
      `thread_id=${normalizeText(threadId)} attachment_id=${normalizeText(attachmentId)} status=${response.status} attempt=${attempt}/${attempts} worker=${normalizeBaseUrl(workerUrl)}`,
    );
    await sleep(retryDelayMs);
  }

  const response = lastResponse || { status: 0, payload: {} };
  throw new Error(
    extractErrorMessage(response.payload.error) ||
      `Failed to read web chat attachment (${response.status}).`,
  );
}

async function readWebChatAttachmentReadUrl({
  workerUrl,
  adminToken,
  threadId,
  attachmentId,
  expiresSeconds = 15 * 60,
  retries = 3,
  retryDelayMs = 750,
}) {
  const attempts = Math.max(1, parsePositiveInteger(retries, 3) || 3);
  let lastResponse = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await workerJsonRequest({
      workerUrl,
      adminToken,
      path: "/web-chat/attachments/read-url",
      method: "GET",
      query: new URLSearchParams({
        thread_id: normalizeText(threadId),
        attachment_id: normalizeText(attachmentId),
        expires_seconds: String(parsePositiveInteger(expiresSeconds, 15 * 60) || 15 * 60),
      }),
    });
    lastResponse = response;
    if (response.ok && response.payload.ok !== false) {
      const downloadUrl = normalizeText(
        response.payload.download_url || response.payload.downloadUrl,
      );
      if (!downloadUrl) {
        throw new Error("Web chat attachment read URL response was missing a download URL.");
      }
      return {
        attachment: normalizeAttachmentRecord(response.payload.attachment),
        downloadUrl,
        expiresAt: parsePositiveInteger(
          response.payload.expires_at || response.payload.expiresAt,
          0,
        ),
      };
    }
    if (
      !RETRYABLE_WEB_CHAT_ATTACHMENT_READ_STATUSES.has(response.status) ||
      attempt >= attempts
    ) {
      break;
    }
    log(
      "Web chat attachment read URL request failed; retrying",
      `thread_id=${normalizeText(threadId)} attachment_id=${normalizeText(attachmentId)} status=${response.status} attempt=${attempt}/${attempts} worker=${normalizeBaseUrl(workerUrl)}`,
    );
    await sleep(retryDelayMs);
  }

  const response = lastResponse || { status: 0, payload: {} };
  throw new Error(
    extractErrorMessage(response.payload.error) ||
      `Failed to create web chat attachment read URL (${response.status}).`,
  );
}

function parseFirebaseServiceAccountJson(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return null;
  }
  const candidates = [raw];
  for (const encoding of ["base64", "base64url"]) {
    try {
      const decoded = Buffer.from(raw, encoding).toString("utf8");
      if (decoded && decoded !== raw) {
        candidates.push(decoded);
      }
    } catch {
      // Ignore non-base64 Firebase secret variants.
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const normalized = normalizeObject(parsed);
      const clientEmail = normalizeText(
        normalized.client_email || normalized.clientEmail,
      );
      const privateKey = normalizeText(
        normalized.private_key || normalized.privateKey,
      ).replace(/\\n/g, "\n");
      if (!clientEmail || !privateKey) {
        continue;
      }
      return {
        clientEmail,
        privateKey,
        tokenUri:
          normalizeText(normalized.token_uri || normalized.tokenUri) ||
          FIREBASE_SERVICE_ACCOUNT_TOKEN_URI,
      };
    } catch {
      // Try the next supported representation.
    }
  }

  return null;
}

function buildFirebaseServiceAccountJwt({
  serviceAccount,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const clientEmail = normalizeText(serviceAccount?.clientEmail);
  const privateKey = normalizeText(serviceAccount?.privateKey);
  const tokenUri =
    normalizeText(serviceAccount?.tokenUri) || FIREBASE_SERVICE_ACCOUNT_TOKEN_URI;
  if (!clientEmail || !privateKey) {
    throw new Error("Firebase service account client_email and private_key are required.");
  }
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const claim = {
    iss: clientEmail,
    scope: FIREBASE_STORAGE_READ_ONLY_SCOPE,
    aud: tokenUri,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const unsigned = [
    toBase64Url(Buffer.from(JSON.stringify(header), "utf8")),
    toBase64Url(Buffer.from(JSON.stringify(claim), "utf8")),
  ].join(".");
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${toBase64Url(signer.sign(privateKey))}`;
}

async function requestFirebaseStorageAccessToken({
  serviceAccount,
  fetchImpl = fetch,
  nowMs = Date.now(),
}) {
  const tokenUri =
    normalizeText(serviceAccount?.tokenUri) || FIREBASE_SERVICE_ACCOUNT_TOKEN_URI;
  const cacheKey = `${normalizeText(serviceAccount?.clientEmail)}\n${tokenUri}`;
  const cached = firebaseStorageAccessTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > nowMs + 60_000) {
    return cached.accessToken;
  }

  const assertion = buildFirebaseServiceAccountJwt({
    serviceAccount,
    nowSeconds: Math.floor(nowMs / 1000),
  });
  const response = await fetchImpl(tokenUri, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  let payload = {};
  try {
    payload = normalizeObject(await response.json());
  } catch {
    payload = {};
  }
  const accessToken = normalizeText(payload.access_token || payload.accessToken);
  if (!response.ok || !accessToken) {
    throw new Error(
      normalizeText(payload.error_description || payload.error) ||
        `Firebase access token request failed (${response.status}).`,
    );
  }
  const expiresInSeconds = parsePositiveInteger(payload.expires_in, 3600) || 3600;
  firebaseStorageAccessTokenCache.set(cacheKey, {
    accessToken,
    expiresAtMs: nowMs + expiresInSeconds * 1000,
  });
  return accessToken;
}

function buildFirebaseStorageDownloadUrl({ bucket, storageKey }) {
  const normalizedBucket = normalizeText(bucket);
  const normalizedStorageKey = normalizeText(storageKey);
  if (!normalizedBucket || !normalizedStorageKey) {
    return "";
  }
  const url = new URL(
    `https://storage.googleapis.com/download/storage/v1/b/${encodeURIComponent(
      normalizedBucket,
    )}/o/${encodeURIComponent(normalizedStorageKey)}`,
  );
  url.searchParams.set("alt", "media");
  return url.toString();
}

function resolveFirebaseStorageAttachmentPointer(attachment) {
  const normalized = normalizeObject(attachment);
  const storageBackend = normalizeText(
    normalized.storage_backend || normalized.storageBackend,
  ).toLowerCase();
  if (storageBackend !== "firebase_storage") {
    return null;
  }
  const bucket = normalizeText(normalized.storage_bucket || normalized.storageBucket);
  const storageKey = normalizeText(normalized.storage_key || normalized.storageKey);
  if (!bucket || !storageKey) {
    return null;
  }
  return { bucket, storageKey };
}

async function readFirebaseStorageAttachment({
  attachment,
  firebaseJsonKey,
  fetchImpl = fetch,
  retries = 3,
  retryDelayMs = 750,
}) {
  const normalizedAttachment = normalizeAttachmentRecord(attachment);
  const pointer = resolveFirebaseStorageAttachmentPointer(normalizedAttachment);
  if (!normalizedAttachment || !pointer) {
    throw new Error("Firebase Storage attachment metadata is incomplete.");
  }
  const serviceAccount = parseFirebaseServiceAccountJson(firebaseJsonKey);
  if (!serviceAccount) {
    throw new Error("CODEQ8_FIREBASE_JSON_KEY is required to read Firebase Storage attachments directly.");
  }
  const accessToken = await requestFirebaseStorageAccessToken({
    serviceAccount,
    fetchImpl,
  });
  const url = buildFirebaseStorageDownloadUrl(pointer);
  const attempts = Math.max(1, parsePositiveInteger(retries, 3) || 3);
  let lastStatus = 0;
  let lastErrorText = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response = null;
    try {
      response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        cache: "no-store",
      });
    } catch (error) {
      lastErrorText = extractErrorMessage(error, "Firebase Storage request failed.");
    }

    if (response?.ok) {
      const bytes = Buffer.from(await response.arrayBuffer());
      return {
        attachment: normalizedAttachment,
        fileContentsBase64Url: bytes.toString("base64url"),
      };
    }

    if (response) {
      lastStatus = response.status;
      try {
        lastErrorText = normalizeText(await response.text());
      } catch {
        lastErrorText = "";
      }
    }
    const retryable =
      (!response || RETRYABLE_WEB_CHAT_ATTACHMENT_READ_STATUSES.has(response.status)) &&
      attempt < attempts;
    if (!retryable) {
      break;
    }
    log(
      "Firebase Storage attachment read failed; retrying",
      `attachment_id=${normalizedAttachment.attachment_id} status=${lastStatus || "fetch_failed"} attempt=${attempt}/${attempts} bucket=${pointer.bucket}`,
    );
    await sleep(retryDelayMs);
  }

  throw new Error(
    normalizeText(lastErrorText) ||
      `Failed to read Firebase Storage attachment (${lastStatus || 0}).`,
  );
}

async function readFirebaseStorageSignedAttachment({
  attachment,
  downloadUrl,
  fetchImpl = fetch,
  retries = 3,
  retryDelayMs = 750,
}) {
  const normalizedAttachment = normalizeAttachmentRecord(attachment);
  const normalizedDownloadUrl = normalizeText(downloadUrl);
  if (!normalizedAttachment?.attachment_id || !normalizedDownloadUrl) {
    throw new Error("Firebase Storage signed attachment metadata is incomplete.");
  }

  const attempts = Math.max(1, parsePositiveInteger(retries, 3) || 3);
  let lastStatus = 0;
  let lastErrorText = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response = null;
    try {
      response = await fetchImpl(normalizedDownloadUrl, {
        cache: "no-store",
      });
    } catch (error) {
      lastErrorText = extractErrorMessage(error, "Firebase Storage signed URL request failed.");
    }

    if (response?.ok) {
      const bytes = Buffer.from(await response.arrayBuffer());
      return {
        attachment: normalizedAttachment,
        fileContentsBase64Url: bytes.toString("base64url"),
      };
    }

    if (response) {
      lastStatus = response.status;
      try {
        lastErrorText = normalizeText(await response.text());
      } catch {
        lastErrorText = "";
      }
    }
    const retryable =
      (!response || RETRYABLE_WEB_CHAT_ATTACHMENT_READ_STATUSES.has(response.status)) &&
      attempt < attempts;
    if (!retryable) {
      break;
    }
    log(
      "Firebase Storage signed attachment read failed; retrying",
      `attachment_id=${normalizedAttachment.attachment_id} status=${lastStatus || "fetch_failed"} attempt=${attempt}/${attempts}`,
    );
    await sleep(retryDelayMs);
  }

  throw new Error(
    normalizeText(lastErrorText) ||
      `Failed to read Firebase Storage signed attachment (${lastStatus || 0}).`,
  );
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
  runId = "",
  thread,
  reportRunnerDiagnostic = null,
  retries = 2,
  retryDelayMs = 750,
}) {
  const persistedCodexSessionState = normalizeCodexSessionState(
    normalizeObject(thread).codex_session_state || null,
  );
  const expectedBundleRevision = persistedCodexSessionState.bundle_revision || 0;
  await maybeReportRunnerDiagnostic(reportRunnerDiagnostic, {
    event: "runner_session_state_load_started",
    mode: persistedCodexSessionState.status === "ready" ? "resume" : "fresh",
    details: {
      persisted_session_state: summarizeCodexSessionStateForDiagnostic(
        persistedCodexSessionState,
      ),
      expected_bundle_revision: expectedBundleRevision,
    },
  });

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
    await maybeReportRunnerDiagnostic(reportRunnerDiagnostic, {
      event: "runner_session_state_load_finished",
      mode: resolvedCodexSessionState.status === "ready" ? "resume" : "fresh",
      details: {
        resolved_session_state: summarizeCodexSessionStateForDiagnostic(
          resolvedCodexSessionState,
        ),
        expected_bundle_revision:
          resolvedCodexSessionState.bundle_revision || expectedBundleRevision,
        session_file_contents_bytes: Buffer.byteLength(
          String(loadedCodexSession.sessionFileContents || ""),
          "utf8",
        ),
        can_resume: resolvedCodexSessionState.status === "ready",
      },
    });
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
        await maybeReportRunnerDiagnostic(reportRunnerDiagnostic, {
          event: "runner_session_state_invalidated",
          failureClass: "runner_session_state_invalidated",
          severity: "warning",
          ok: false,
          mode: "fresh",
          details: {
            reason: message,
            previous_session_state: summarizeCodexSessionStateForDiagnostic(
              persistedCodexSessionState,
            ),
            invalidated_session_state: summarizeCodexSessionStateForDiagnostic(
              invalidatedState,
            ),
          },
        });
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
    await maybeReportRunnerDiagnostic(reportRunnerDiagnostic, {
      event: "runner_session_recovery_fallback_used",
      failureClass: "runner_session_recovery_fallback_used",
      severity: "warning",
      ok: false,
      mode: "fresh",
      details: {
        run_id: normalizeText(runId),
        reason: message,
        previous_session_state: summarizeCodexSessionStateForDiagnostic(
          persistedCodexSessionState,
        ),
        fallback_session_state: summarizeCodexSessionStateForDiagnostic(
          freshCodexSessionState,
        ),
      },
    });
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
  uploadedBundleStorageKey = "",
  uploadedBundleStorageBucket = "",
  uploadedBundleStorageBackend = "",
  uploadedBundleSizeBytes = 0,
  uploadedBundleCompressedSizeBytes = 0,
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
    uploaded_bundle_storage_key: normalizeText(uploadedBundleStorageKey),
    uploaded_bundle_storage_bucket: normalizeText(uploadedBundleStorageBucket),
    uploaded_bundle_storage_backend: normalizeText(uploadedBundleStorageBackend),
    uploaded_bundle_size_bytes: parsePositiveInteger(uploadedBundleSizeBytes, 0),
    uploaded_bundle_compressed_size_bytes: parsePositiveInteger(
      uploadedBundleCompressedSizeBytes,
      0,
    ),
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
  sessionFileSnapshot = null,
  runStartedAt = 0,
  lastResumedAt = 0,
  mode = "unknown",
  expectedRunMarker = "",
  reportRunnerDiagnostic = null,
}) {
  await maybeReportRunnerDiagnostic(reportRunnerDiagnostic, {
    event: "runner_session_capture_started",
    mode,
    details: {
      existing_session_state: summarizeCodexSessionStateForDiagnostic(
        existingSessionState,
      ),
      expected_bundle_revision: expectedBundleRevision,
      target_signature_hash: hashDiagnosticValue(targetSignature),
      has_expected_run_marker: Boolean(normalizeText(expectedRunMarker)),
    },
  });
  const capturedSessionBundle = await captureCodexSessionBundle({
    codexHome,
    existingSessionState,
    model,
    sessionFileSnapshot,
    runStartedAt,
  });
  const markerPresent = sessionContainsWebChatRunMarker({
    sessionFileContents: capturedSessionBundle.sessionFileContents,
    marker: expectedRunMarker,
  });
  await maybeReportRunnerDiagnostic(reportRunnerDiagnostic, {
    event: "runner_session_capture_finished",
    failureClass:
      expectedRunMarker && !markerPresent
        ? "runner_session_capture_marker_missing"
        : "runner_session_capture_finished",
    severity: expectedRunMarker && !markerPresent ? "warning" : "trace",
    ok: !expectedRunMarker || markerPresent,
    mode,
    details: {
      session_id_hash: hashDiagnosticValue(capturedSessionBundle.sessionId),
      session_file_relative_path_hash: hashDiagnosticValue(
        capturedSessionBundle.sessionFileRelativePath,
      ),
      cli_version: capturedSessionBundle.cliVersion,
      model: capturedSessionBundle.model || model,
      session_file_contents_bytes: Buffer.byteLength(
        String(capturedSessionBundle.sessionFileContents || ""),
        "utf8",
      ),
      marker_present: markerPresent,
      marker_hash: hashDiagnosticValue(expectedRunMarker),
    },
  });
  const uploadPreparation = await prepareWebChatCodexSessionUpload({
    workerUrl,
    adminToken,
    threadId,
    expectedBundleRevision,
  });
  await maybeReportRunnerDiagnostic(reportRunnerDiagnostic, {
    event: "runner_session_upload_prepared",
    mode,
    details: {
      expected_bundle_revision:
        uploadPreparation.uploadPreparation.expectedBundleRevision,
      next_bundle_revision: uploadPreparation.uploadPreparation.nextBundleRevision,
      storage_backend: uploadPreparation.uploadPreparation.storageBackend,
      storage_bucket_hash: hashDiagnosticValue(
        uploadPreparation.uploadPreparation.storageBucket,
      ),
      storage_key_hash: hashDiagnosticValue(
        uploadPreparation.uploadPreparation.storageKey,
      ),
    },
  });
  const preparedBundle = await buildUploadedCodexSessionStoredValue({
    threadId,
    storageKey: uploadPreparation.uploadPreparation.storageKey,
    uploadKey: uploadPreparation.uploadPreparation.uploadKey,
    wrappedKey: uploadPreparation.uploadPreparation.wrappedKey,
    wrappedKeyIv: uploadPreparation.uploadPreparation.wrappedKeyIv,
    sessionFileContents: capturedSessionBundle.sessionFileContents,
  });
  await uploadPreparedWebChatCodexSessionBundle({
    workerUrl,
    adminToken,
    threadId,
    storageKey: uploadPreparation.uploadPreparation.storageKey,
    storageBucket: uploadPreparation.uploadPreparation.storageBucket,
    storageBackend: uploadPreparation.uploadPreparation.storageBackend,
    storedValue: preparedBundle.storedValue,
  });
  await maybeReportRunnerDiagnostic(reportRunnerDiagnostic, {
    event: "runner_session_upload_finished",
    mode,
    details: {
      storage_backend: uploadPreparation.uploadPreparation.storageBackend,
      storage_bucket_hash: hashDiagnosticValue(
        uploadPreparation.uploadPreparation.storageBucket,
      ),
      storage_key_hash: hashDiagnosticValue(
        uploadPreparation.uploadPreparation.storageKey,
      ),
      bundle_size_bytes: preparedBundle.bundleSizeBytes,
      bundle_compressed_size_bytes: preparedBundle.bundleCompressedSizeBytes,
    },
  });

  let persistedSession;
  try {
    persistedSession = await upsertWebChatCodexSessionState({
      workerUrl,
      adminToken,
      threadId,
      sessionId: capturedSessionBundle.sessionId,
      sessionFileRelativePath: capturedSessionBundle.sessionFileRelativePath,
      uploadedBundleStorageKey: uploadPreparation.uploadPreparation.storageKey,
      uploadedBundleStorageBucket: uploadPreparation.uploadPreparation.storageBucket,
      uploadedBundleStorageBackend: uploadPreparation.uploadPreparation.storageBackend,
      uploadedBundleSizeBytes: preparedBundle.bundleSizeBytes,
      uploadedBundleCompressedSizeBytes: preparedBundle.bundleCompressedSizeBytes,
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
    await maybeReportRunnerDiagnostic(reportRunnerDiagnostic, {
      event: "runner_session_upsert_finished",
      mode,
      details: {
        persisted_session_state: summarizeCodexSessionStateForDiagnostic(
          persistedSession.codexSessionState,
        ),
        expected_bundle_revision: expectedBundleRevision,
      },
    });
  } catch (error) {
    try {
      await discardPreparedWebChatCodexSessionBundle({
        workerUrl,
        adminToken,
        threadId,
        storageKey: uploadPreparation.uploadPreparation.storageKey,
        storageBucket: uploadPreparation.uploadPreparation.storageBucket,
        storageBackend: uploadPreparation.uploadPreparation.storageBackend,
      });
    } catch (discardError) {
      log(
        "WARN",
        `Unable to discard uploaded web chat codex session bundle after metadata commit failure: ${
          discardError instanceof Error ? discardError.message : String(discardError)
        }`,
      );
    }
    await maybeReportRunnerDiagnostic(reportRunnerDiagnostic, {
      event: "runner_session_upsert_failed",
      failureClass: "runner_session_upsert_failed",
      severity: "error",
      ok: false,
      mode,
      details: {
        error: extractErrorMessage(error),
        storage_backend: uploadPreparation.uploadPreparation.storageBackend,
        storage_bucket_hash: hashDiagnosticValue(
          uploadPreparation.uploadPreparation.storageBucket,
        ),
        storage_key_hash: hashDiagnosticValue(
          uploadPreparation.uploadPreparation.storageKey,
        ),
        expected_bundle_revision: expectedBundleRevision,
      },
    });
    throw error;
  }
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
  mode = "unknown",
  expectedRunMarker = "",
  reportRunnerDiagnostic = null,
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
        mode,
        expectedRunMarker,
        reportRunnerDiagnostic,
      });
    } catch (error) {
      lastError = error;
      const message = extractErrorMessage(error);
      await maybeReportRunnerDiagnostic(reportRunnerDiagnostic, {
        event: "runner_session_persistence_attempt_failed",
        failureClass: isCodexSessionRevisionConflictError(message)
          ? "runner_session_revision_conflict"
          : "runner_session_persistence_attempt_failed",
        severity: "warning",
        ok: false,
        mode,
        details: {
          attempt,
          attempts: normalizedAttempts,
          retryable:
            attempt < normalizedAttempts && isRetryableCodexSessionPersistenceError(message),
          error: message,
          expected_bundle_revision: expectedBundleRevision,
        },
      });
      if (isCodexSessionRevisionConflictError(message)) {
        try {
          const latestCodexSession = await readWebChatCodexSessionState({
            workerUrl,
            adminToken,
            threadId,
            includeContents: false,
          });
          const latestCodexSessionState = normalizeCodexSessionState(
            latestCodexSession.codexSessionState,
          );
          if (isReadyCodexSessionStateForRun(latestCodexSessionState, runId)) {
            log(
              "WARN",
              "Using already-persisted Codex session state after duplicate run revision conflict",
              `thread_id=${normalizeText(threadId)} run_id=${normalizeText(runId)} revision=${latestCodexSessionState.bundle_revision}`,
            );
            await maybeReportRunnerDiagnostic(reportRunnerDiagnostic, {
              event: "runner_session_revision_conflict_accepted",
              failureClass: "runner_session_revision_conflict_accepted",
              severity: "warning",
              ok: true,
              mode,
              details: {
                latest_session_state: summarizeCodexSessionStateForDiagnostic(
                  latestCodexSessionState,
                ),
                expected_bundle_revision: expectedBundleRevision,
              },
            });
            return latestCodexSessionState;
          }
        } catch (readError) {
          log(
            "WARN",
            `Unable to inspect Codex session state after revision conflict: ${
              readError instanceof Error ? readError.message : String(readError)
            }`,
            `thread_id=${normalizeText(threadId)} run_id=${normalizeText(runId)}`,
          );
        }
        break;
      }
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
  commandEnv = process.env,
  readFirebaseStorageAttachmentImpl = readFirebaseStorageAttachment,
  readFirebaseStorageSignedAttachmentImpl = readFirebaseStorageSignedAttachment,
  readWebChatAttachmentImpl = readWebChatAttachment,
  readWebChatAttachmentReadUrlImpl = readWebChatAttachmentReadUrl,
}) {
  const normalizedAttachments = parseAttachmentList(attachments);
  if (normalizedAttachments.length === 0) {
    return [];
  }

  await ensureDirectory(attachmentRootPath);
  const materialized = [];
  const firebaseJsonKey = normalizeText(
    commandEnv.CODEQ8_FIREBASE_JSON_KEY || commandEnv.CODEQ8_FIREBASE_STORAGE_JSON_KEY,
  );
  for (const attachment of normalizedAttachments) {
    let loaded = null;
    const firebasePointer = resolveFirebaseStorageAttachmentPointer(attachment);
    if (firebasePointer) {
      try {
        const signedRead = await readWebChatAttachmentReadUrlImpl({
          workerUrl,
          adminToken,
          threadId,
          attachmentId: attachment.attachment_id,
        });
        loaded = await readFirebaseStorageSignedAttachmentImpl({
          attachment: signedRead.attachment?.attachment_id ? signedRead.attachment : attachment,
          downloadUrl: signedRead.downloadUrl,
        });
      } catch (error) {
        log(
          "Firebase Storage attachment signed URL read failed; falling back",
          `thread_id=${normalizeText(threadId)} attachment_id=${attachment.attachment_id} error=${extractErrorMessage(error)}`,
        );
      }
    }
    if (!loaded && firebaseJsonKey && firebasePointer) {
      try {
        loaded = await readFirebaseStorageAttachmentImpl({
          attachment,
          firebaseJsonKey,
        });
      } catch (error) {
        log(
          "Firebase Storage attachment direct Codeq8 read failed; falling back to worker",
          `thread_id=${normalizeText(threadId)} attachment_id=${attachment.attachment_id} error=${extractErrorMessage(error)}`,
        );
      }
    }
    if (!loaded) {
      loaded = await readWebChatAttachmentImpl({
        workerUrl,
        adminToken,
        threadId,
        attachmentId: attachment.attachment_id,
      });
    }
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

async function prepareRunnerDiscordDmCli({
  commandEnv,
  runtimeHomePath,
}) {
  const normalizedRuntimeHomePath = path.resolve(runtimeHomePath);
  const wrapperBinPath = path.join(normalizedRuntimeHomePath, "bin");
  const wrapperPath = path.join(wrapperBinPath, "codeq8-discord-dm");
  const helperScriptPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "web-chat-runner-discord-dm.mjs",
  );

  await ensureDirectory(wrapperBinPath);
  const wrapperScript = [
    "#!/bin/sh",
    `exec node ${quoteShellArgument(helperScriptPath)} "$@"`,
    "",
  ].join("\n");
  await fs.writeFile(wrapperPath, wrapperScript, { mode: 0o755 });
  await fs.chmod(wrapperPath, 0o755);

  const currentPath = String(commandEnv.PATH || "");
  const normalizedWrapperBinPath = normalizeText(wrapperBinPath);
  const pathEntries = currentPath
    .split(path.delimiter)
    .map((entry) => normalizeText(entry))
    .filter(Boolean);
  if (!pathEntries.includes(normalizedWrapperBinPath)) {
    commandEnv.PATH = currentPath
      ? `${normalizedWrapperBinPath}${path.delimiter}${currentPath}`
      : normalizedWrapperBinPath;
  }

  return {
    available: true,
    commandName: "codeq8-discord-dm",
    wrapperPath,
  };
}

function prependCommandPath(commandEnv, binPath) {
  const currentPath = String(commandEnv.PATH || "");
  const normalizedBinPath = normalizeText(binPath);
  const pathEntries = currentPath
    .split(path.delimiter)
    .map((entry) => normalizeText(entry))
    .filter(Boolean);
  if (!pathEntries.includes(normalizedBinPath)) {
    commandEnv.PATH = currentPath
      ? `${normalizedBinPath}${path.delimiter}${currentPath}`
      : normalizedBinPath;
  }
}

async function prepareRefreshingGitHubCliWrapper({
  commandEnv,
  runtimeHomePath,
  ghPath,
  helperPath,
}) {
  const normalizedHelperPath = normalizeText(helperPath);
  if (!normalizedHelperPath || !(await isExecutableFile(normalizedHelperPath))) {
    return "";
  }

  const wrapperBinPath = path.join(path.resolve(runtimeHomePath), "bin");
  const wrapperPath = path.join(wrapperBinPath, "gh");
  await ensureDirectory(wrapperBinPath);
  const wrapperScript = [
    "#!/bin/sh",
    "set -eu",
    `helper_path=${quoteShellArgument(normalizedHelperPath)}`,
    `real_gh_path=${quoteShellArgument(ghPath)}`,
    'fresh_token="$("$helper_path" print-token)"',
    'if [ -n "$fresh_token" ]; then',
    '  export GH_TOKEN="$fresh_token"',
    '  export GITHUB_TOKEN="$fresh_token"',
    "fi",
    'exec "$real_gh_path" "$@"',
    "",
  ].join("\n");
  await fs.writeFile(wrapperPath, wrapperScript, { mode: 0o755 });
  await fs.chmod(wrapperPath, 0o755);
  prependCommandPath(commandEnv, wrapperBinPath);
  return wrapperPath;
}

async function prepareGitHubCliAuth({
  commandEnv,
  runtimeHomePath,
}) {
  const helperPath = normalizeText(commandEnv.CODEX_GITHUB_TOKEN_HELPER_PATH);
  let githubToken = resolveWebChatGitHubWriteToken(commandEnv);
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
  const ghConfigDir = path.join(normalizedRuntimeHomePath, "gh-config");
  await ensureDirectory(ghConfigDir);

  if (helperPath && (await isExecutableFile(helperPath))) {
    const refreshedToken = await runProcessCapture(helperPath, ["print-token"], {
      cwd: process.cwd(),
      env: commandEnv,
    });
    if (refreshedToken.ok) {
      githubToken = normalizeText(refreshedToken.stdout) || githubToken;
    }
  }

  if (!githubToken) {
    return {
      available: false,
      reason: "No GitHub write credential was available for gh auth.",
    };
  }

  commandEnv.GH_TOKEN = githubToken;
  commandEnv.GITHUB_TOKEN = githubToken;
  commandEnv.GH_CONFIG_DIR = ghConfigDir;
  commandEnv.GH_PROMPT_DISABLED = "1";

  const wrapperPath = await prepareRefreshingGitHubCliWrapper({
    commandEnv,
    runtimeHomePath,
    ghPath,
    helperPath,
  });

  return {
    available: true,
    binPath: wrapperPath || ghPath,
    wrappedBinPath: wrapperPath ? ghPath : "",
    configDir: ghConfigDir,
  };
}

async function prepareCodeq8Cli({
  commandEnv,
  runtimeHomePath,
}) {
  const normalizedRuntimeHomePath = path.resolve(runtimeHomePath);
  const wrapperBinPath = path.join(normalizedRuntimeHomePath, "bin");
  const wrapperPath = path.join(wrapperBinPath, "codeq8");
  const helperScriptPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "web-chat-runner-codeq8-cli.mjs",
  );
  await ensureDirectory(wrapperBinPath);
  const wrapperScript = [
    "#!/bin/sh",
    `exec node ${quoteShellArgument(helperScriptPath)} "$@"`,
    "",
  ].join("\n");
  await fs.writeFile(wrapperPath, wrapperScript, { mode: 0o755 });
  await fs.chmod(wrapperPath, 0o755);
  prependCommandPath(commandEnv, wrapperBinPath);
  return {
    available: true,
    binPath: wrapperPath,
    githubLogin: "",
  };
}

async function validateRunnerCodexAuth({
  codexPath,
  codexHome,
  workspacePath,
  commandEnv,
  timeoutSeconds = CODEX_AUTH_PRECHECK_TIMEOUT_SECONDS,
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
    };
  }
  if (!normalizedCodexHome) {
    return {
      ok: false,
      reason: "Codex home is required to validate runner-local Codex auth.",
      output: "",
      timedOut: false,
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
        reason: extractErrorMessage(error, "Unable to validate runner-local Codex auth."),
        output: truncate(`${stdout}\n${stderr}`.trim(), MAX_OUTPUT_CHARS),
        timedOut,
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
        });
        return;
      }
      const normalizedSignal = normalizeText(signal);
      const reason = timedOut
        ? "Timed out validating runner-local Codex auth."
        : truncate(
          combinedOutput ||
            `Codex login status exited with code ${Number.isFinite(Number(code)) ? Number(code) : "unknown"}${normalizedSignal ? ` (${normalizedSignal})` : ""}.`,
          1000,
        );
      resolve({
        ok: false,
        reason,
        output: combinedOutput,
        timedOut,
      });
    });
  });
}

function applyServerOwnedCodeq8FileGuidance({
  prompt,
  promptFilePath = "",
}) {
  const normalizedPrompt = normalizeText(prompt);
  const normalizedPromptFilePath = normalizeText(promptFilePath);
  if (!normalizedPrompt || !normalizedPromptFilePath) {
    return normalizedPrompt;
  }
  return [
    "Runner-owned prompt file:",
    `- The current per-user repo workflow prompt is hydrated into \`${normalizedPromptFilePath}\` in the workspace root for this run.`,
    `- Read and update \`${normalizedPromptFilePath}\` directly when the durable repo workflow memory should change.`,
    `- If you update the prompt, edit \`${normalizedPromptFilePath}\` in place and keep the visible assistant reply free of prompt-transport markup.`,
    "",
    normalizedPrompt,
  ].join("\n");
}

function applyRunnerDiscordDmGuidance({
  prompt,
  commandName = "",
}) {
  const normalizedPrompt = normalizeText(prompt);
  const normalizedCommandName = normalizeText(commandName);
  if (!normalizedPrompt || !normalizedCommandName) {
    return normalizedPrompt;
  }
  return [
    "Runner-owned Discord DM helper:",
    `- Use \`${normalizedCommandName} list --json\` to read older owner-global Discord DM history when the injected unread DM context is not enough.`,
    `- Paginate older messages with \`${normalizedCommandName} list --json --before-created-at <next_before_created_at> --before-event-id <next_before_event_id>\`.`,
    `- Use \`${normalizedCommandName} send --content \"...\" --json\` when you need machine-checkable confirmation that the DM send succeeded.`,
    "- If the helper wrapper prints no visible stdout, inspect `command -v codeq8-discord-dm`, read the shim path behind it, and use a direct `node --input-type=module -e` import of the runtime helper to get JSON instead of guessing.",
    "- Do not claim that a Discord DM was sent unless the helper proves `sent: true`. If send verification is missing, say that explicitly.",
    "- Keep Discord DMs short and factual. The website repo chat remains the primary high-bandwidth meeting surface.",
    "",
    normalizedPrompt,
  ].join("\n");
}

async function buildCodexPrompt({
  publicBaseUrl,
  webChatRunToken,
  repository,
  threadTitle,
  threadId,
  runId,
  messageId,
  sourceType,
  branchContext,
  workspacePersistenceState = null,
  threadSpecText = "",
  promptText,
  recentChecksPromptText = "",
  codeq8Cli,
  attachments = [],
  referencedThreads = [],
  serverOwnedCodeq8FilePath = "",
  runnerDiscordDmCommand = "",
}) {
  const payload = await requestWebChatRunnerRuntimeJson({
    publicBaseUrl,
    webChatRunToken,
    path: "/api/chat/runs/prompt",
    body: {
      mode: "fresh",
      workspace_repository: normalizeText(repository),
      thread_id: normalizeText(threadId),
      run_id: normalizeText(runId),
      message_id: normalizeText(messageId),
      thread_title: normalizeText(threadTitle),
      source_type: normalizeText(sourceType),
      branch_context: normalizeObject(branchContext),
      workspace_persistence_state: workspacePersistenceState || null,
      thread_spec_text: normalizeText(threadSpecText),
      prompt_text: normalizeText(promptText),
      recent_user_messages_prompt_text: "",
      recent_checks_prompt_text: normalizeText(recentChecksPromptText),
      attachments: Array.isArray(attachments) ? attachments : [],
      referenced_threads: Array.isArray(referencedThreads) ? referencedThreads : [],
      codeq8_cli_available: Boolean(codeq8Cli?.available),
      target_shift: false,
    },
    schema: webChatRunnerPromptResponseSchema,
    responseLabel: "Codeq8 runner prompt response",
  });
  const prompt = normalizeText(payload.prompt);
  if (!prompt) {
    throw new Error("Codeq8 returned an empty runner prompt.");
  }
  return applyRunnerDiscordDmGuidance({
    prompt: applyServerOwnedCodeq8FileGuidance({
      prompt,
      promptFilePath: serverOwnedCodeq8FilePath,
    }),
    commandName: runnerDiscordDmCommand,
  });
}

async function buildResumePrompt({
  publicBaseUrl,
  webChatRunToken,
  repository = "",
  threadId = "",
  runId = "",
  messageId = "",
  sourceType = "",
  branchContext = {},
  workspacePersistenceState = null,
  threadSpecText = "",
  promptText,
  recentUserMessagesPromptText = "",
  recentChecksPromptText = "",
  codeq8Cli,
  attachments = [],
  referencedThreads = [],
  targetShift = null,
  serverOwnedCodeq8FilePath = "",
  runnerDiscordDmCommand = "",
}) {
  const payload = await requestWebChatRunnerRuntimeJson({
    publicBaseUrl,
    webChatRunToken,
    path: "/api/chat/runs/prompt",
    body: {
      mode: "resume",
      workspace_repository: normalizeText(repository),
      thread_id: normalizeText(threadId),
      run_id: normalizeText(runId),
      message_id: normalizeText(messageId),
      thread_title: "",
      source_type: normalizeText(sourceType),
      branch_context: normalizeObject(branchContext),
      workspace_persistence_state: workspacePersistenceState || null,
      thread_spec_text: normalizeText(threadSpecText),
      prompt_text: normalizeText(promptText),
      recent_user_messages_prompt_text: normalizeText(recentUserMessagesPromptText),
      recent_checks_prompt_text: normalizeText(recentChecksPromptText),
      attachments: Array.isArray(attachments) ? attachments : [],
      referenced_threads: Array.isArray(referencedThreads) ? referencedThreads : [],
      codeq8_cli_available: Boolean(codeq8Cli?.available),
      target_shift: Boolean(targetShift),
    },
    schema: webChatRunnerPromptResponseSchema,
    responseLabel: "Codeq8 runner prompt response",
  });
  const prompt = normalizeText(payload.prompt);
  if (!prompt) {
    throw new Error("Codeq8 returned an empty runner prompt.");
  }
  return applyRunnerDiscordDmGuidance({
    prompt: applyServerOwnedCodeq8FileGuidance({
      prompt,
      promptFilePath: serverOwnedCodeq8FilePath,
    }),
    commandName: runnerDiscordDmCommand,
  });
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

function resolveRunnerCodexHome(env = process.env) {
  const explicitCodexHome = normalizeText(env.CODEX_HOME);
  if (explicitCodexHome) {
    return path.resolve(explicitCodexHome);
  }
  const homePath = normalizeText(env.HOME) || os.homedir();
  return homePath ? path.join(homePath, ".codex") : "";
}

async function createWebChatRunRuntime(threadId, env = process.env) {
  const prefix =
    normalizeText(threadId).toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "chat-thread";
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), `codeq8-web-chat-${prefix}-`));
  const codexHome = resolveRunnerCodexHome(env);
  if (!codexHome) {
    throw new Error("Unable to resolve runner Codex home.");
  }
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

function normalizeAppServerMethod(value) {
  return normalizeText(value);
}

function extractAppServerString(value, keys = []) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return normalizeText(value);
  }
  if (Array.isArray(value)) {
    return normalizeText(value.map((entry) => extractAppServerString(entry, keys)).filter(Boolean).join("\n"));
  }
  const object = normalizeObject(value);
  if (Object.keys(object).length === 0) {
    return "";
  }
  for (const key of keys) {
    const extracted = extractAppServerString(object[key], keys);
    if (extracted) {
      return extracted;
    }
  }
  for (const key of ["text", "content", "message", "summary", "name", "title", "command"]) {
    const extracted = extractAppServerString(object[key], keys);
    if (extracted) {
      return extracted;
    }
  }
  return "";
}

function extractAppServerTextPreservingWhitespace(value, keys = []) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => extractAppServerTextPreservingWhitespace(entry, keys)).join("");
  }
  const object = normalizeObject(value);
  if (Object.keys(object).length === 0) {
    return "";
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      continue;
    }
    const extracted = extractAppServerTextPreservingWhitespace(object[key], keys);
    if (extracted) {
      return extracted;
    }
  }
  for (const key of ["text", "content", "message"]) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      continue;
    }
    const extracted = extractAppServerTextPreservingWhitespace(object[key], keys);
    if (extracted) {
      return extracted;
    }
  }
  return "";
}

function extractAppServerThreadId(value) {
  const object = normalizeObject(value);
  const thread = normalizeObject(object.thread || object.threadInfo || object.session);
  return normalizeCodexSessionId(
    thread.id ||
      object.threadId ||
      object.thread_id ||
      object.id ||
      "",
  );
}

function extractAppServerTurnId(value) {
  const object = normalizeObject(value);
  const turn = normalizeObject(object.turn);
  return normalizeCodexSessionId(turn.id || object.turnId || object.turn_id || "");
}

function extractAppServerTurnStatus(value) {
  const object = normalizeObject(value);
  const turn = normalizeObject(object.turn);
  return normalizeText(turn.status || object.status || "");
}

function extractAppServerAgentDelta(params) {
  const object = normalizeObject(params);
  const source = Object.prototype.hasOwnProperty.call(object, "delta") ? object.delta : object;
  return extractAppServerTextPreservingWhitespace(source, ["delta", "text", "content"]);
}

function extractAppServerCompletedAgentText(params) {
  const object = normalizeObject(params);
  const item = normalizeObject(object.item);
  const itemType = normalizeText(item.type || object.type).toLowerCase();
  if (!/agent|assistant/.test(itemType)) {
    return "";
  }
  return extractAppServerTextPreservingWhitespace(item, ["text", "content", "message"]);
}

function extractAppServerItemId(params) {
  const object = normalizeObject(params);
  const item = normalizeObject(object.item);
  return normalizeText(
    item.id ||
      item.itemId ||
      item.item_id ||
      object.itemId ||
      object.item_id ||
      object.id ||
      object.messageId ||
      object.message_id,
  );
}

function isAppServerAgentMessageItem(params) {
  const object = normalizeObject(params);
  const item = normalizeObject(object.item);
  const itemType = normalizeText(
    item.type ||
      item.kind ||
      object.type ||
      object.kind ||
      object.itemType ||
      object.item_type,
  ).toLowerCase();
  return /agent|assistant/.test(itemType);
}

function summarizeAppServerProgressNotification({ method, params, now = Date.now() }) {
  const normalizedMethod = normalizeAppServerMethod(method);
  const object = normalizeObject(params);
  const item = normalizeObject(object.item);
  const itemType = normalizeText(item.type || object.type || "").toLowerCase();
  const itemLabel = truncate(
    extractAppServerString(item, ["title", "name", "command", "text", "content"]) ||
      extractAppServerString(object, ["title", "name", "summary"]) ||
      normalizedMethod,
    APP_SERVER_PROGRESS_MAX_LABEL_CHARS,
  );
  if (normalizedMethod === "turn/started") {
    return {
      event_id: `app_server:${now}:turn_started`,
      kind: "turn_started",
      label: "Started Codex turn",
      status: "running",
      at: now,
    };
  }
  if (normalizedMethod === "turn/completed") {
    return {
      event_id: `app_server:${now}:turn_completed`,
      kind: "turn_completed",
      label: "Codex turn completed",
      status: normalizeText(extractAppServerTurnStatus(object)) || "completed",
      at: now,
    };
  }
  if (normalizedMethod === "item/started") {
    return {
      event_id: `app_server:${now}:item_started:${hashDiagnosticValue(itemLabel).slice(0, 12)}`,
      kind: "item_started",
      item_type: itemType,
      label: itemLabel || "Started work item",
      status: "running",
      at: now,
    };
  }
  if (normalizedMethod === "item/completed") {
    return {
      event_id: `app_server:${now}:item_completed:${hashDiagnosticValue(itemLabel).slice(0, 12)}`,
      kind: "item_completed",
      item_type: itemType,
      label: itemLabel || "Completed work item",
      status: "completed",
      at: now,
    };
  }
  if (normalizedMethod === "thread/status/changed") {
    return {
      event_id: `app_server:${now}:thread_status`,
      kind: "thread_status",
      label: extractAppServerString(object, ["status", "threadStatusType"]) || "Thread status changed",
      status: extractAppServerString(object, ["status", "threadStatusType"]),
      at: now,
    };
  }
  return null;
}

function incrementCount(map, key) {
  const normalizedKey = normalizeText(key);
  if (!normalizedKey) {
    return;
  }
  map.set(normalizedKey, (map.get(normalizedKey) || 0) + 1);
}

function formatAppServerNotificationSummaryLabel(method) {
  const normalizedMethod = normalizeAppServerMethod(method);
  return APP_SERVER_NOTIFICATION_SUMMARY_LABELS.get(normalizedMethod) || normalizedMethod;
}

function summarizeCountMap(counts, maxEntries = APP_SERVER_NOTIFICATION_SUMMARY_MAX_METHODS) {
  const entries = [...counts.entries()]
    .filter(([, count]) => count > 0)
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]));
  if (entries.length === 0) {
    return "";
  }
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const visibleEntries = entries.slice(0, maxEntries);
  const hiddenMethodCount = Math.max(0, entries.length - visibleEntries.length);
  return [
    `total=${total}`,
    ...visibleEntries.map(
      ([method, count]) => `${formatAppServerNotificationSummaryLabel(method)}=${count}`,
    ),
    hiddenMethodCount ? `other_methods=${hiddenMethodCount}` : "",
  ].filter(Boolean).join(" ");
}

function describeAppServerNotificationTrace(method, params = {}) {
  const normalizedMethod = normalizeAppServerMethod(method);
  if (normalizedMethod === "turn/started") {
    const turnId = extractAppServerTurnId(params);
    return ["method=turn/started", turnId ? "has_turn_id=true" : ""]
      .filter(Boolean)
      .join(" ");
  }
  if (normalizedMethod === "turn/completed") {
    const status = extractAppServerTurnStatus(params);
    return ["method=turn/completed", status ? `status=${status}` : ""]
      .filter(Boolean)
      .join(" ");
  }
  return `method=${normalizedMethod}`;
}

function shouldTraceAppServerNotification(method) {
  return APP_SERVER_NOTIFICATION_TRACE_METHODS.has(normalizeAppServerMethod(method));
}

function buildAppServerRouteUrl({ publicBaseUrl, path: routePath, query = null }) {
  const normalizedBaseUrl = normalizeCodePublicBaseUrl(publicBaseUrl);
  const url = new URL(routePath, `${normalizedBaseUrl}/`);
  if (query instanceof URLSearchParams) {
    for (const [key, value] of query.entries()) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function createAppServerProgressReporter({
  publicBaseUrl,
  webChatRunToken,
  workspaceRepository,
  threadId,
  runId,
  fetchImpl = globalThis.fetch,
}) {
  const normalizedPublicBaseUrl = normalizeCodePublicBaseUrl(publicBaseUrl);
  const normalizedToken = normalizeText(webChatRunToken);
  const normalizedRepository = normalizeRepository(workspaceRepository);
  const normalizedThreadId = normalizeThreadId(threadId);
  const normalizedRunId = normalizeRunId(runId);
  if (
    !normalizedPublicBaseUrl ||
    !normalizedToken ||
    !normalizedRepository ||
    !normalizedThreadId ||
    !normalizedRunId ||
    typeof fetchImpl !== "function"
  ) {
    return {
      enqueue: () => {},
      flush: async () => {},
    };
  }

  let queued = [];
  let timer = null;
  let flushing = false;
  let flushWaiters = [];
  let reportedEventCount = 0;

  const waitForActiveFlush = () =>
    new Promise((resolve) => {
      flushWaiters.push(resolve);
    });

  const resolveFlushWaiters = () => {
    const waiters = flushWaiters;
    flushWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  };

  const flush = async () => {
    if (flushing || queued.length === 0) {
      return;
    }
    flushing = true;
    const batch = queued.slice(0, APP_SERVER_PROGRESS_MAX_BATCH_SIZE);
    queued = queued.slice(APP_SERVER_PROGRESS_MAX_BATCH_SIZE);
    try {
      await fetchImpl(
        buildAppServerRouteUrl({
          publicBaseUrl: normalizedPublicBaseUrl,
          path: "/api/chat/runs/app-server/events",
        }),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${normalizedToken}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            workspace_repository: normalizedRepository,
            thread_id: normalizedThreadId,
            run_id: normalizedRunId,
            events: batch,
          }),
        },
      ).catch(() => null);
    } finally {
      flushing = false;
      resolveFlushWaiters();
      if (queued.length > 0 && !timer) {
        timer = setTimeout(() => {
          timer = null;
          void flush();
        }, APP_SERVER_PROGRESS_BATCH_INTERVAL_MS);
        timer.unref?.();
      }
    }
  };

  return {
    enqueue(event) {
      const normalizedEvent = normalizeObject(event);
      if (!normalizeText(normalizedEvent.kind)) {
        return;
      }
      if (reportedEventCount >= APP_SERVER_PROGRESS_MAX_EVENTS_PER_RUN) {
        return;
      }
      reportedEventCount += 1;
      queued.push(normalizedEvent);
      queued = queued.slice(-50);
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          void flush();
        }, APP_SERVER_PROGRESS_BATCH_INTERVAL_MS);
        timer.unref?.();
      }
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      while (queued.length > 0 || flushing) {
        if (flushing) {
          await waitForActiveFlush();
          continue;
        }
        await flush();
      }
    },
  };
}

function describeMaterializedAppServerAttachment(attachment) {
  const normalized = normalizeObject(attachment);
  const name =
    normalizeAttachmentName(normalized.name || normalized.file_name || normalized.fileName) ||
    normalizeText(normalized.attachment_id || normalized.attachmentId) ||
    "attachment";
  const contentType =
    normalizeText(normalized.content_type || normalized.contentType) ||
    "application/octet-stream";
  const sizeBytes = parseNonNegativeInteger(
    normalized.size_bytes || normalized.sizeBytes,
    0,
  );
  const localPath = normalizeText(normalized.local_path || normalized.localPath);
  const detail = [
    contentType,
    sizeBytes > 0 ? `${sizeBytes} bytes` : "",
    normalizeText(normalized.attachment_id || normalized.attachmentId)
      ? `attachment_id=${normalizeText(normalized.attachment_id || normalized.attachmentId)}`
      : "",
  ].filter(Boolean).join(", ");
  return `- ${name}${detail ? ` (${detail})` : ""}: ${localPath || "<not materialized>"}`;
}

function buildAppServerSteerInputText({
  content,
  attachments,
}) {
  const normalizedContent = normalizeText(content);
  const normalizedAttachments = Array.isArray(attachments) ? attachments : [];
  if (normalizedAttachments.length === 0) {
    return normalizedContent;
  }

  return [
    "The user sent a follow-up while this run was active.",
    "",
    "Message:",
    normalizedContent || "(no text)",
    "",
    "Attachments materialized locally:",
    ...normalizedAttachments.map((attachment) =>
      describeMaterializedAppServerAttachment(attachment),
    ),
    "",
    "Inspect these files directly if they are relevant to the request. Do not modify or delete the attached files.",
  ].join("\n");
}

function createAppServerControlPoller({
  publicBaseUrl,
  webChatRunToken,
  workspaceRepository,
  threadId,
  runId,
  workerUrl = "",
  adminToken = "",
  attachmentRootPath = "",
  commandEnv = process.env,
  fetchImpl = globalThis.fetch,
  materializeWebChatAttachmentsImpl = materializeWebChatAttachments,
  sendRequest,
  getAppServerThreadId,
  getAppServerTurnId,
}) {
  const normalizedPublicBaseUrl = normalizeCodePublicBaseUrl(publicBaseUrl);
  const normalizedToken = normalizeText(webChatRunToken);
  const normalizedRepository = normalizeRepository(workspaceRepository);
  const normalizedThreadId = normalizeThreadId(threadId);
  const normalizedRunId = normalizeRunId(runId);
  const normalizedWorkerUrl = normalizeBaseUrl(workerUrl);
  const normalizedAdminToken = normalizeText(adminToken) || normalizedToken;
  const normalizedAttachmentRootPath = normalizeText(attachmentRootPath);
  if (
    !normalizedPublicBaseUrl ||
    !normalizedToken ||
    !normalizedRepository ||
    !normalizedThreadId ||
    !normalizedRunId ||
    typeof fetchImpl !== "function" ||
    typeof sendRequest !== "function" ||
    typeof getAppServerThreadId !== "function" ||
    typeof getAppServerTurnId !== "function"
  ) {
    return {
      start: () => {},
      stop: async () => {},
    };
  }

  let timer = null;
  let stopped = false;
  let polling = false;
  let lastSequence = 0;

  const acknowledge = async (acknowledgements) => {
    if (!Array.isArray(acknowledgements) || acknowledgements.length === 0) {
      return;
    }
    await fetchImpl(
      buildAppServerRouteUrl({
        publicBaseUrl: normalizedPublicBaseUrl,
        path: "/api/chat/runs/app-server/control",
      }),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${normalizedToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          workspace_repository: normalizedRepository,
          thread_id: normalizedThreadId,
          run_id: normalizedRunId,
          acknowledgements,
        }),
      },
    ).catch(() => null);
  };

  const poll = async () => {
    if (stopped || polling) {
      return;
    }
    polling = true;
    try {
      const query = new URLSearchParams({
        workspace_repository: normalizedRepository,
        thread_id: normalizedThreadId,
        run_id: normalizedRunId,
        after_sequence: String(lastSequence),
      });
      const response = await fetchImpl(
        buildAppServerRouteUrl({
          publicBaseUrl: normalizedPublicBaseUrl,
          path: "/api/chat/runs/app-server/control",
          query,
        }),
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${normalizedToken}`,
            Accept: "application/json",
          },
        },
      );
      if (!response?.ok) {
        return;
      }
      const payload = normalizeObject(await response.json().catch(() => null));
      const requests = Array.isArray(payload.requests) ? payload.requests : [];
      const acknowledgements = [];
      for (const rawRequest of requests) {
        const request = normalizeObject(rawRequest);
        const requestId = normalizeText(request.request_id || request.requestId);
        const kind = normalizeText(request.kind).toLowerCase();
        const sequence = Number(request.sequence || 0) || 0;
        const appServerThreadId = getAppServerThreadId();
        if (!requestId || !appServerThreadId) {
          continue;
        }
        if (kind !== "steer" && kind !== "interrupt") {
          lastSequence = Math.max(lastSequence, sequence);
          continue;
        }
        try {
          const appServerTurnId = getAppServerTurnId();
          if (!appServerTurnId) {
            continue;
          }
          if (kind === "steer") {
            const content = normalizeText(request.content);
            const attachments = parseAttachmentList(request.attachments);
            const materializedAttachments = attachments.length > 0
              ? await materializeWebChatAttachmentsImpl({
                  attachments,
                  attachmentRootPath: path.join(
                    normalizedAttachmentRootPath || os.tmpdir(),
                    normalizeText(requestId).replace(/[^A-Za-z0-9._:-]/g, "-"),
                  ),
                  workerUrl: normalizedWorkerUrl,
                  adminToken: normalizedAdminToken,
                  threadId: normalizedThreadId,
                  commandEnv,
                })
              : [];
            const inputText = buildAppServerSteerInputText({
              content,
              attachments: materializedAttachments,
            });
            if (!inputText) {
              throw new Error("Steer content is empty.");
            }
            await sendRequest("turn/steer", {
              threadId: appServerThreadId,
              expectedTurnId: appServerTurnId,
              input: [{ type: "text", text: inputText }],
            });
            acknowledgements.push({ request_id: requestId, status: "accepted" });
          } else {
            await sendRequest("turn/interrupt", {
              threadId: appServerThreadId,
              turnId: appServerTurnId,
            });
            acknowledgements.push({ request_id: requestId, status: "accepted" });
          }
        } catch (error) {
          acknowledgements.push({
            request_id: requestId,
            status: "failed",
            error: extractErrorMessage(error),
          });
        }
        lastSequence = Math.max(lastSequence, sequence);
      }
      await acknowledge(acknowledgements);
    } catch {
      // Control polling is best-effort; final run status still comes from Codex.
    } finally {
      polling = false;
    }
  };

  return {
    start() {
      if (timer || stopped) {
        return;
      }
      timer = setInterval(() => {
        void poll();
      }, APP_SERVER_CONTROL_POLL_INTERVAL_MS);
      timer.unref?.();
      void poll();
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (polling) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}

async function runCodexAppServer({
  codexPath,
  model,
  task,
  workspacePath,
  commandEnv,
  timeoutSeconds,
  mode = "fresh",
  sessionId = "",
  appServerContext = null,
}) {
  const normalizedModel = normalizeText(model) || DEFAULT_CODEX_MODEL;
  const normalizedTask = normalizeText(task);
  const normalizedMode = normalizeText(mode).toLowerCase() === "resume" ? "resume" : "fresh";
  const normalizedSessionId = normalizeCodexSessionId(sessionId);
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

  return new Promise((resolve) => {
    const startMs = Date.now();
    let stderr = "";
    let currentAgentMessageItemId = "";
    let currentAgentMessageOutput = "";
    let lastAgentMessageOutput = "";
    let agentMessageSequence = 0;
    let timedOut = false;
    let settled = false;
    let appServerThreadId = "";
    let activeTurnId = "";
    let nextRequestId = 1;
    let appServerTraceCount = 0;
    const appServerNotificationCounts = new Map();
    const pendingRequests = new Map();
    const progressReporter = createAppServerProgressReporter(appServerContext || {});
    let controlPoller = null;
    progressReporter.enqueue({
      event_id: `app_server:${Date.now()}:transport_started`,
      kind: "transport_started",
      label: "Starting Codex",
      status: "running",
      at: Date.now(),
    });

    const child = spawn(codexPath, ["app-server", "--listen", "stdio://"], {
      cwd: workspacePath,
      env: applyCodexNodeOptions({ ...commandEnv }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const appendOutput = (target, chunk) => {
      const nextChunk = String(chunk || "");
      if (!nextChunk) {
        return target;
      }
      return truncate(`${target}${nextChunk}`, MAX_OUTPUT_CHARS * 2);
    };

    const getAssistantOutput = () => lastAgentMessageOutput || currentAgentMessageOutput;

    const startAgentMessage = (params) => {
      agentMessageSequence += 1;
      const itemId = extractAppServerItemId(params) || `agent_message:${agentMessageSequence}`;
      if (itemId !== currentAgentMessageItemId) {
        currentAgentMessageItemId = itemId;
        currentAgentMessageOutput = "";
      }
    };

    const appendAgentMessageDelta = (params) => {
      const itemId = extractAppServerItemId(params);
      if (itemId && itemId !== currentAgentMessageItemId) {
        currentAgentMessageItemId = itemId;
        currentAgentMessageOutput = "";
      }
      currentAgentMessageOutput = appendOutput(
        currentAgentMessageOutput,
        extractAppServerAgentDelta(params),
      );
    };

    const completeAgentMessage = (params) => {
      const itemId = extractAppServerItemId(params);
      const completedText = extractAppServerCompletedAgentText(params);
      if (itemId && itemId !== currentAgentMessageItemId) {
        currentAgentMessageItemId = itemId;
        currentAgentMessageOutput = "";
      }
      const output = completedText || currentAgentMessageOutput;
      if (output) {
        lastAgentMessageOutput = truncate(output, MAX_OUTPUT_CHARS * 2);
      }
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

    const finish = async (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      await controlPoller?.stop?.();
      await progressReporter.flush();
      for (const pending of pendingRequests.values()) {
        pending.reject(new Error("Codex app-server closed before the request completed."));
      }
      pendingRequests.clear();
      try {
        child.stdin?.end();
      } catch {
        // ignore stdin close failure
      }
      killChild("SIGTERM");
      const notificationSummary = summarizeCountMap(appServerNotificationCounts);
      if (notificationSummary) {
        log("Codex app-server notifications summarized", notificationSummary);
      }
      const normalizedStderr = normalizeText(stderr);
      if (normalizedStderr) {
        if (result.ok) {
          log("Codex app-server stderr captured", `chars=${normalizedStderr.length}`);
        } else {
          process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
        }
      }
      resolve({
        ...result,
        durationMs: Date.now() - startMs,
      });
    };

    const sendNotification = (method, params = {}) => {
      if (method === "initialized") {
        log("Codex app-server notification sent", "method=initialized");
      }
      child.stdin?.write(`${JSON.stringify({ method, params })}\n`);
    };

    const describeAppServerRequestParams = (params = {}) => {
      const normalizedParams = normalizeObject(params);
      const sandboxPolicy = normalizeObject(normalizedParams.sandboxPolicy);
      const input = Array.isArray(normalizedParams.input) ? normalizedParams.input : [];
      return [
        normalizedParams.approvalPolicy ? `approval_policy=${normalizeText(normalizedParams.approvalPolicy)}` : "",
        normalizedParams.sandbox ? `sandbox=${normalizeText(normalizedParams.sandbox)}` : "",
        sandboxPolicy.type ? `sandbox_policy=${normalizeText(sandboxPolicy.type)}` : "",
        input.length ? `input_items=${input.length}` : "",
        normalizedParams.threadId ? "has_thread_id=true" : "",
        normalizedParams.cwd ? "has_cwd=true" : "",
        normalizedParams.model ? "has_model=true" : "",
      ].filter(Boolean).join(" ");
    };

    const logAppServerTrace = (message, details = "") => {
      if (appServerTraceCount >= 80) {
        return;
      }
      appServerTraceCount += 1;
      log(message, details);
    };

    const sendRequest = (method, params = {}) => new Promise((requestResolve, requestReject) => {
      const id = nextRequestId;
      nextRequestId += 1;
      logAppServerTrace(
        "Codex app-server request sent",
        `id=${id} method=${normalizeAppServerMethod(method)} ${describeAppServerRequestParams(params)}`.trim(),
      );
      pendingRequests.set(id, { resolve: requestResolve, reject: requestReject, method });
      child.stdin?.write(`${JSON.stringify({ method, id, params })}\n`);
    });

    const handleNotification = (method, params) => {
      const normalizedMethod = normalizeAppServerMethod(method);
      incrementCount(appServerNotificationCounts, normalizedMethod);
      if (shouldTraceAppServerNotification(normalizedMethod)) {
        logAppServerTrace(
          "Codex app-server notification received",
          describeAppServerNotificationTrace(normalizedMethod, params),
        );
      }
      const progressEvent = summarizeAppServerProgressNotification({
        method: normalizedMethod,
        params,
      });
      if (progressEvent) {
        progressReporter.enqueue(progressEvent);
      }
      if (normalizedMethod === "turn/started") {
        activeTurnId = extractAppServerTurnId(params) || activeTurnId;
      }
      if (normalizedMethod === "item/started" && isAppServerAgentMessageItem(params)) {
        startAgentMessage(params);
      }
      if (normalizedMethod === "item/agentMessage/delta") {
        appendAgentMessageDelta(params);
      }
      if (normalizedMethod === "item/completed" && isAppServerAgentMessageItem(params)) {
        completeAgentMessage(params);
      }
      if (normalizedMethod === "turn/completed") {
        const status = extractAppServerTurnStatus(params);
        const ok = !/failed|error|cancel/i.test(status);
        void finish({
          ok,
          output: truncate(normalizeText(getAssistantOutput()), MAX_OUTPUT_CHARS),
          diagnosticOutput: truncate(stderr, MAX_OUTPUT_CHARS),
          reason: ok ? "" : `Codex app-server turn completed with status ${status || "unknown"}.`,
          exitCode: ok ? 0 : 1,
          signal: "",
          timedOut: false,
        });
      }
    };

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const trimmedLine = normalizeText(line);
      if (!trimmedLine) {
        return;
      }
      let message = null;
      try {
        message = JSON.parse(trimmedLine);
      } catch {
        stderr = appendOutput(stderr, `${trimmedLine}\n`);
        return;
      }
      const object = normalizeObject(message);
      if (Object.prototype.hasOwnProperty.call(object, "id")) {
        const id = Number(object.id);
        const pending = pendingRequests.get(id);
        if (pending) {
          pendingRequests.delete(id);
          if (object.error) {
            logAppServerTrace(
              "Codex app-server request failed",
              `id=${id} method=${normalizeAppServerMethod(pending.method)} error=${truncate(extractErrorMessage(object.error), 300)}`,
            );
            pending.reject(new Error(extractErrorMessage(object.error, `${pending.method} failed.`)));
          } else {
            logAppServerTrace(
              "Codex app-server request completed",
              `id=${id} method=${normalizeAppServerMethod(pending.method)}`,
            );
            pending.resolve(object.result || {});
          }
          return;
        }
        if (object.method) {
          logAppServerTrace(
            "Codex app-server server request rejected",
            `id=${id} method=${normalizeAppServerMethod(object.method)}`,
          );
          child.stdin?.write(
            `${JSON.stringify({
              id,
              error: {
                code: -32601,
                message: "Codeq8 runner does not support server-initiated app-server requests.",
              },
            })}\n`,
          );
        }
        return;
      }
      if (object.method) {
        handleNotification(object.method, object.params || {});
      }
    });

    child.stderr?.on("data", (chunk) => {
      const text = String(chunk || "");
      if (text) {
        stderr = appendOutput(stderr, text);
      }
    });

    child.on("error", (error) => {
      void finish({
        ok: false,
        output: truncate(normalizeText(getAssistantOutput()), MAX_OUTPUT_CHARS),
        diagnosticOutput: truncate(stderr, MAX_OUTPUT_CHARS),
        reason: extractErrorMessage(error),
        exitCode: -1,
        signal: "spawn_error",
        timedOut,
      });
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      void finish({
        ok: false,
        output: truncate(normalizeText(getAssistantOutput()), MAX_OUTPUT_CHARS),
        diagnosticOutput: truncate(stderr, MAX_OUTPUT_CHARS),
        reason: timedOut
          ? `Codex app-server timed out after ${Math.floor(timeoutMs / 1000)} seconds.`
          : `Codex app-server exited with code=${Number.isFinite(code) ? code : "null"} signal=${signal || "none"}.`,
        exitCode: Number.isFinite(code) ? Number(code) : -1,
        signal: signal || "",
        timedOut,
      });
    });

    const timeoutMs = Math.max(30, timeoutSeconds) * 1000;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killChild("SIGTERM");
      setTimeout(() => {
        killChild("SIGKILL");
      }, 8000).unref();
    }, timeoutMs);

    (async () => {
      await sendRequest("initialize", {
        clientInfo: {
          name: "codeq8_web_chat_runner",
          title: "Codeq8 Web Chat Runner",
          version: "0.1.0",
        },
      });
      sendNotification("initialized", {});
      const threadResult =
        normalizedMode === "resume"
          ? await sendRequest("thread/resume", {
              threadId: normalizedSessionId,
              model: normalizedModel,
              cwd: workspacePath,
              approvalPolicy: "never",
              sandbox: "danger-full-access",
            })
          : await sendRequest("thread/start", {
              model: normalizedModel,
              cwd: workspacePath,
              approvalPolicy: "never",
              sandbox: "danger-full-access",
            });
      appServerThreadId = extractAppServerThreadId(threadResult);
      if (!appServerThreadId) {
        throw new Error("Codex app-server did not return a thread id.");
      }
      controlPoller = createAppServerControlPoller({
        ...(appServerContext || {}),
        sendRequest,
        getAppServerThreadId: () => appServerThreadId,
        getAppServerTurnId: () => activeTurnId,
      });
      controlPoller.start();
      const turnResult = await sendRequest("turn/start", {
        threadId: appServerThreadId,
        input: [{ type: "text", text: normalizedTask }],
        cwd: workspacePath,
        model: normalizedModel,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "dangerFullAccess",
        },
        effort: DEFAULT_CODEX_REASONING_EFFORT,
      });
      activeTurnId = extractAppServerTurnId(turnResult) || activeTurnId;
    })().catch((error) => {
      void finish({
        ok: false,
        output: truncate(normalizeText(getAssistantOutput()), MAX_OUTPUT_CHARS),
        diagnosticOutput: truncate(stderr, MAX_OUTPUT_CHARS),
        reason: extractErrorMessage(error, "Codex app-server run failed."),
        exitCode: -1,
        signal: "",
        timedOut,
      });
    });
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
  appServerContext = null,
}) {
  const normalizedModel = normalizeText(model) || DEFAULT_CODEX_MODEL;
  const normalizedTask = normalizeText(task);
  const normalizedMode = normalizeText(mode).toLowerCase() === "resume" ? "resume" : "fresh";
  const normalizedSessionId = normalizeCodexSessionId(sessionId);
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

  return runCodexAppServer({
    codexPath,
    model: normalizedModel,
    task: normalizedTask,
    workspacePath,
    commandEnv,
    timeoutSeconds,
    mode: normalizedMode,
    sessionId: normalizedSessionId,
    appServerContext,
  });
}

export function applyCodexNodeOptions(commandEnv = {}) {
  const codexNodeOptions = normalizeText(commandEnv.CODEQ8_CODEX_NODE_OPTIONS);
  if (codexNodeOptions) {
    commandEnv.NODE_OPTIONS = codexNodeOptions;
  }
  return commandEnv;
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

async function pushRememberedThreadBranch({
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

  // Remembered thread branches are the only place where the runner is allowed
  // to rescue committed work Codex forgot to push. Keep this to one explicit
  // push on the checked-out branch so AJ does not lose local commits to a
  // prompt slip, but do not turn it into generic divergence resolution.
  const pushed = await runProcessCapture(
    "git",
    ["push", "--set-upstream", "origin", `HEAD:refs/heads/${normalizedBranch}`],
    {
      cwd: workspacePath,
      env: commandEnv,
    },
  );
  if (!pushed.ok) {
    return {
      ok: false,
      error: `Unable to push ${normalizedBranch}: ${summarizeGitProcessFailure(pushed)}`,
    };
  }

  return {
    ok: true,
    error: "",
  };
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

function workspaceHeadChangedSinceBaseline({
  baselineState = null,
  currentState = null,
}) {
  const baselineHead = normalizeText(baselineState?.headCommitSha);
  const currentHead = normalizeText(currentState?.headCommitSha);
  return Boolean(baselineHead && currentHead && baselineHead !== currentHead);
}

function protectedBranchStateIsCleanRemoteSync({
  currentState = null,
}) {
  const current = currentState || {};
  return (
    current.hasRemoteBranch === true &&
    current.hasWorkingTreeChanges !== true &&
    parsePositiveInteger(current.aheadCount, 0) === 0 &&
    normalizeText(current.headCommitSha) &&
    normalizeText(current.headCommitSha) === normalizeText(current.remoteHeadCommitSha)
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
    let currentState = await readWorkspacePersistenceState({
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
    const cleanProtectedBranchRemoteSync =
      normalizeText(writeMode) === "branch_and_pr" &&
      !branchIsRemembered &&
      protectedBranchStateIsCleanRemoteSync({
        currentState,
      });

    if (
      normalizeText(writeMode) === "branch_and_pr" &&
      !branchIsRemembered &&
      meaningfulRepoWork &&
      !cleanProtectedBranchRemoteSync
    ) {
      result.skippedProtectedBranch = normalizedBranch;
      result.error = `Codex left repo changes on protected branch ${normalizedBranch}. Create and switch to a normal git branch before finishing.`;
      return result;
    }

    if (!branchIsRemembered) {
      return result;
    }

    result.resolvedWriteBranch = normalizedBranch;
    const headChangedSinceBaseline = workspaceHeadChangedSinceBaseline({
      baselineState,
      currentState,
    });
    const hasCommittedBranchProgress =
      currentState.aheadCount > 0 ||
      headChangedSinceBaseline ||
      (!currentState.hasRemoteBranch
        ? await branchHasCommitsAgainstBase({
            workspacePath,
            commandEnv,
            branch: normalizedBranch,
            baseBranch,
          }).catch(() => false)
        : false);
    const shouldAttemptRescuePush =
      meaningfulRepoWork &&
      hasCommittedBranchProgress &&
      (!currentState.hasRemoteBranch || currentState.aheadCount > 0);
    if (shouldAttemptRescuePush) {
      const pushed = await pushRememberedThreadBranch({
        workspacePath,
        commandEnv,
        branch: normalizedBranch,
      });
      if (!pushed.ok) {
        result.pendingRemoteSync = pushed.error;
        result.error = pushed.error;
        return result;
      }
      result.pushed = true;
      currentState = await readWorkspacePersistenceState({
        workspacePath,
        commandEnv,
        branch: normalizedBranch,
      });
    }

    const requiresManualPush =
      meaningfulRepoWork && (!currentState.hasRemoteBranch || currentState.aheadCount > 0);
    if (requiresManualPush) {
      result.pendingRemoteSync = currentState.hasRemoteBranch
        ? `Branch ${normalizedBranch} still has ${currentState.aheadCount} local commit(s) ahead of origin/${normalizedBranch}. Codex must push them explicitly.`
        : `Branch ${normalizedBranch} only exists in the local runner workspace. Codex must push it explicitly before Codeq8 can link existing pull request metadata.`;
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
    const shouldAttachPullRequest =
      !requiresManualPush &&
      currentState.hasRemoteBranch &&
      shouldLookUpPullRequest({
        sourceType,
        writeMode,
        hasBranchChangesForReview,
        meaningfulRepoWork,
      });

    if (shouldAttachPullRequest) {
      const pullRequest = await findPullRequestForBranch({
        repository,
        headRepository: headRepository || repository,
        headBranch: normalizedBranch,
        baseBranch,
        token: gitToken,
      });
      if (!pullRequest.ok) {
        result.error = pullRequest.error || "Unable to load pull request.";
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

async function findPullRequestForBranch({
  repository,
  headRepository,
  headBranch,
  baseBranch,
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
  if (!listed.ok) {
    return {
      ok: false,
      error:
        normalizeText(listed.payload?.message || listed.payload?.error) ||
        `Unable to load pull requests (${listed.status}).`,
    };
  }
  const existingPulls = Array.isArray(listed.payload) ? listed.payload : [];
  if (existingPulls.length > 0) {
    const first = normalizeObject(existingPulls[0]);
    const existingPullRequestNumber = parsePositiveInteger(first.number, 0);
    return {
      ok: true,
      pullRequest: {
        number: existingPullRequestNumber,
        title: normalizeText(first.title),
        url: normalizeText(first.html_url || first.url),
      },
      existing: true,
    };
  }

  return {
    ok: true,
    pullRequest: null,
    existing: false,
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

  const writableRemoteUrl = buildGithubCloneUrl(cloneRepository, "");
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
  const publicBaseUrl =
    normalizeText(process.env.CODE_PUBLIC_BASE_URL) || DEFAULT_CODE_PUBLIC_URL;
  const adminToken = resolveWebChatRunnerAdminToken(process.env);
  const workspaceRepository = normalizeText(process.env.CODE_WORKSPACE_REPOSITORY);
  const threadId = normalizeText(process.env.CODE_CHAT_THREAD_ID);
  const messageId = normalizeText(process.env.CODE_CHAT_MESSAGE_ID);
  const runId = normalizeText(process.env.CODE_CHAT_RUN_ID);
  const sourceType = normalizeText(process.env.CODE_CHAT_SOURCE_TYPE) || "default_branch";
  const githubLogin = normalizeText(process.env.CODE_CHAT_GITHUB_LOGIN);
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

  const webChatRunToken = resolveWebChatRunToken(commandEnv);
  const reportRunnerDiagnostic = createWebChatRunnerDiagnosticReporter({
    publicBaseUrl,
    webChatRunToken,
    workspaceRepository,
    threadId,
    runId,
    messageId,
  });
  let runtimeManifest;
  try {
    runtimeManifest = await assertWebChatRunnerRuntimeCompatibility({
      publicBaseUrl,
      webChatRunToken,
      workspaceRepository,
      threadId,
      runId,
    });
    await reportRunnerDiagnostic({
      event: "runner_runtime_manifest_validated",
      details: {
        contract_version: normalizeText(runtimeManifest.contract_version),
        capabilities_count: Array.isArray(runtimeManifest.capabilities)
          ? runtimeManifest.capabilities.length
          : 0,
        authorized_paths_count: Array.isArray(runtimeManifest.authorized_paths)
          ? runtimeManifest.authorized_paths.length
          : 0,
        scoped_authorized_paths_count: Array.isArray(runtimeManifest.scoped_authorized_paths)
          ? runtimeManifest.scoped_authorized_paths.length
          : 0,
        runner_required_paths_count: Array.isArray(runtimeManifest.runner_required_paths)
          ? runtimeManifest.runner_required_paths.length
          : 0,
        codex_transport: "app-server",
      },
    });
  } catch (error) {
    await reportRunnerDiagnostic({
      event: "runner_runtime_manifest_validation_failed",
      failureClass: "runner_runtime_manifest_validation_failed",
      severity: "error",
      ok: false,
      details: {
        error: extractErrorMessage(error),
      },
    });
    throw error;
  }
  log(
    "Validated Codeq8 runner runtime manifest",
    `contract=${normalizeText(runtimeManifest.contract_version)} capabilities=${Array.isArray(runtimeManifest.capabilities) ? runtimeManifest.capabilities.length : 0} authorized_paths=${Array.isArray(runtimeManifest.authorized_paths) ? runtimeManifest.authorized_paths.length : 0}`,
  );
  const serverOwnedCodeq8FileSyncEnabled = supportsServerOwnedCodeq8FileSync(runtimeManifest);
  const serverOwnedDiscordDmChatEnabled = supportsServerOwnedDiscordDmChat(runtimeManifest);
  log(
    "Resolved runner-owned codeq8.md workspace sync capability",
    serverOwnedCodeq8FileSyncEnabled ? "enabled" : "disabled",
  );
  log(
    "Resolved runner-owned Discord DM capability",
    serverOwnedDiscordDmChatEnabled ? "enabled" : "disabled",
  );

  const codexPath = await resolveCodexPath(commandEnv);
  let preparedWorkspace = null;
  let runRuntime = null;
  let preparedCodeq8Cli = { available: false, reason: "" };
  let preparedRunnerDiscordDmCli = { available: false, commandName: "" };
  let startedAt = 0;
  let assistantMessage = "";
  let persistedCodexSessionState = normalizeCodexSessionState(null);
  let nonFatalCodexSessionLoadWarning = "";
  let executionMode = "fresh";
  let threadTargetRestartCount = 0;
  let codexResumeRecoveryCount = 0;
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
      const hydratedCodeq8File = serverOwnedCodeq8FileSyncEnabled
        ? await hydrateServerOwnedCodeq8File({
            publicBaseUrl,
            webChatRunToken,
            workspaceRepository: activeWorkspaceRepository,
            threadId,
            runId,
            workspacePath: preparedWorkspace.workspacePath,
          })
        : null;
      if (hydratedCodeq8File) {
        log(
          "Hydrated runner-owned codeq8.md file",
          `path=${hydratedCodeq8File.relativePath} revision=${hydratedCodeq8File.latestRevisionId}`,
        );
      }

      const attemptRunRuntime = await createWebChatRunRuntime(threadId);
      runRuntime = attemptRunRuntime;
      const codexCommandEnv = { ...commandEnv };
      applyCodeq8CliRuntimeEnv({
        commandEnv: codexCommandEnv,
        publicBaseUrl,
        runtimeHomePath: attemptRunRuntime.homePath,
      });
      preparedRunnerDiscordDmCli = serverOwnedDiscordDmChatEnabled
        ? await prepareRunnerDiscordDmCli({
            commandEnv: codexCommandEnv,
            runtimeHomePath: attemptRunRuntime.homePath,
          })
        : { available: false, commandName: "" };
      if (preparedRunnerDiscordDmCli.available) {
        log(
          "Prepared runner-owned Discord DM helper",
          `command=${preparedRunnerDiscordDmCli.commandName}`,
        );
      }
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
        commandEnv: codexCommandEnv,
      });

      try {
        log(
          "Using runner-local Codex authentication for web chat run",
          `owner=${githubLogin} codex_home=${attemptRunRuntime.codexHome}`,
        );
        const validatedCodexAuth = await validateRunnerCodexAuth({
          codexPath,
          codexHome: attemptRunRuntime.codexHome,
          workspacePath: preparedWorkspace.workspacePath,
          commandEnv: codexCommandEnv,
        });
        if (!validatedCodexAuth.ok) {
          throw new Error(
            validatedCodexAuth.reason ||
              "Codex is not logged in on this self-hosted runner.",
          );
        }

        preparedCodeq8Cli = await prepareCodeq8Cli({
          commandEnv: codexCommandEnv,
          runtimeHomePath: attemptRunRuntime.homePath,
        });
        if (preparedCodeq8Cli.available) {
          log(
            "Prepared codeq8 CLI for web chat run",
            `path=${preparedCodeq8Cli.binPath} config_home=${normalizeText(codexCommandEnv.CODEQ8_CONFIG_HOME)}`,
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
            runId,
            thread,
            reportRunnerDiagnostic,
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
            executionMode = "resume";
            resumeAttemptedAt = Date.now();
            resumeTargetShift =
              threadTargetRestartCount > 0 ||
              (
                normalizeText(codexSessionState.target_signature) &&
                normalizeText(codexSessionState.target_signature) !== currentTargetSignature
              );
            const previousRunMarker = buildWebChatRunMarker({
              threadId,
              runId: codexSessionState.last_run_id,
            });
            const previousRunMarkerPresent = sessionContainsWebChatRunMarker({
              sessionFileContents: loadedCodexSession.sessionFileContents,
              marker: previousRunMarker,
            });
            await reportRunnerDiagnostic({
              event: "runner_resume_selected",
              mode: "resume",
              details: {
                session_state: summarizeCodexSessionStateForDiagnostic(codexSessionState),
                target_signature_hash: hashDiagnosticValue(currentTargetSignature),
                target_shift: resumeTargetShift,
                previous_run_marker_hash: hashDiagnosticValue(previousRunMarker),
                previous_run_marker_present: previousRunMarkerPresent,
                previous_run_marker_action:
                  previousRunMarker && !previousRunMarkerPresent ? "report_only" : "none",
                session_file_contents_bytes: Buffer.byteLength(
                  String(loadedCodexSession.sessionFileContents || ""),
                  "utf8",
                ),
              },
            });
            if (previousRunMarker && !previousRunMarkerPresent) {
              await reportRunnerDiagnostic({
                event: "runner_session_marker_missing",
                failureClass: "runner_session_marker_missing",
                severity: "warning",
                ok: false,
                mode: "resume",
                details: {
                  expected_last_run_id: codexSessionState.last_run_id,
                  marker_hash: hashDiagnosticValue(previousRunMarker),
                  bundle_revision: codexSessionState.bundle_revision,
                  action: "report_only",
                },
              });
            }
            await reportRunnerDiagnostic({
              event: "runner_session_restore_started",
              mode: "resume",
              details: {
                session_state: summarizeCodexSessionStateForDiagnostic(codexSessionState),
                session_file_contents_bytes: Buffer.byteLength(
                  String(loadedCodexSession.sessionFileContents || ""),
                  "utf8",
                ),
              },
            });
            await restoreCodexSessionBundle({
              codexHome: attemptRunRuntime.codexHome,
              sessionFileRelativePath: codexSessionState.session_file_relative_path,
              sessionFileContents: loadedCodexSession.sessionFileContents,
            });
            await reportRunnerDiagnostic({
              event: "runner_session_restore_finished",
              mode: "resume",
              details: {
                session_state: summarizeCodexSessionStateForDiagnostic(codexSessionState),
              },
            });
            prompt = await buildResumePrompt({
              publicBaseUrl,
              webChatRunToken: resolveWebChatRunToken(codexCommandEnv),
              repository: activeWorkspaceRepository,
              threadId,
              runId,
              messageId,
              sourceType: activeSourceType,
              branchContext: activeBranchContext,
              workspacePersistenceState,
              threadSpecText,
              promptText,
              recentUserMessagesPromptText,
              recentChecksPromptText,
              codeq8Cli: preparedCodeq8Cli,
              attachments: materializedAttachments,
              referencedThreads,
              targetShift: resumeTargetShift ? targetBeforeAttempt : null,
              serverOwnedCodeq8FilePath: hydratedCodeq8File?.relativePath || "",
              runnerDiscordDmCommand: preparedRunnerDiscordDmCli.commandName,
            });
          } else {
            executionMode = "fresh";
            prompt = await buildCodexPrompt({
              publicBaseUrl,
              webChatRunToken: resolveWebChatRunToken(codexCommandEnv),
              repository: activeWorkspaceRepository,
              threadTitle: activeThreadTitle,
              threadId,
              runId,
              messageId,
              sourceType: activeSourceType,
              branchContext: activeBranchContext,
              workspacePersistenceState,
              threadSpecText,
              promptText,
              recentChecksPromptText,
              codeq8Cli: preparedCodeq8Cli,
              attachments: materializedAttachments,
              referencedThreads,
              serverOwnedCodeq8FilePath: hydratedCodeq8File?.relativePath || "",
              runnerDiscordDmCommand: preparedRunnerDiscordDmCli.commandName,
            });
          }
        } catch (sessionError) {
          const sessionMessage = extractErrorMessage(sessionError);
          if (isSupersededWebChatRunError(sessionMessage)) {
            log(
              "Web chat run was superseded before Codex prompt construction; exiting without recording a session error",
              `thread_id=${threadId} run_id=${runId}`,
            );
            return;
          }
          await safePersistCodexSessionError({
            workerUrl,
            adminToken,
            threadId,
            runId,
            error: sessionMessage,
            lastResumedAt: resumeAttemptedAt,
            expectedBundleRevision,
          });
          await reportRunnerDiagnostic({
            event: "runner_prompt_setup_failed",
            failureClass: "runner_prompt_setup_failed",
            severity: "error",
            ok: false,
            mode: executionMode,
            details: {
              error: sessionMessage,
              expected_bundle_revision: expectedBundleRevision,
            },
          });
          throw sessionError;
        }

        const currentRunMarker = buildWebChatRunMarker({ threadId, runId });
        prompt = appendWebChatRunMarkerToPrompt({
          prompt,
          marker: currentRunMarker,
        });
        await reportRunnerDiagnostic({
          event: "runner_prompt_prepared",
          mode: executionMode,
          details: {
            prompt_chars: prompt.length,
            marker_hash: hashDiagnosticValue(currentRunMarker),
            attachments_count: materializedAttachments.length,
            referenced_threads_count: referencedThreads.length,
            target_shift: resumeTargetShift,
            thread_target_restart_count: threadTargetRestartCount,
          },
        });

        if (!startedAt) {
          startedAt = Date.now();
        }
        try {
          const runningCallbackPayload = await postRunCallback({
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
                  : "Codex is working.",
              resolved_write_branch: preparedWorkspace.durableWriteBranch || undefined,
              started_at: startedAt,
              metadata: buildCodexRunMetadata({
                model: codexModel,
                mode: executionMode,
                extra: {
                  bundle_revision: persistedCodexSessionState.bundle_revision || 0,
                  thread_target_restart_count: threadTargetRestartCount,
                },
              }),
            },
          });
          if (shouldStopBeforeCodexForRunCallbackPayload(runningCallbackPayload)) {
            log(
              "Web chat run was already cancelled before Codex started; exiting",
              `thread_id=${threadId} run_id=${runId}`,
            );
            return;
          }
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
        await reportRunnerDiagnostic({
          event: "runner_codex_command_started",
          mode: executionMode,
          details: {
            repository: activeWorkspaceRepository,
            branch: preparedWorkspace.effectiveWriteBranch,
            model: codexModel,
            session_state: summarizeCodexSessionStateForDiagnostic(codexSessionState),
            thread_target_restart_count: threadTargetRestartCount,
          },
        });

        const execution = await runCodex({
          codexPath,
          model: codexModel,
          task: prompt,
          workspacePath: preparedWorkspace.workspacePath,
          commandEnv: codexCommandEnv,
          timeoutSeconds,
          mode: executionMode,
          sessionId: codexSessionState.session_id,
          appServerContext: {
            publicBaseUrl,
            webChatRunToken: resolveWebChatRunToken(codexCommandEnv),
            workspaceRepository: activeWorkspaceRepository,
            threadId,
            runId,
            workerUrl,
            adminToken,
            attachmentRootPath: path.join(attemptRunRuntime.homePath, "control-attachments"),
            commandEnv: codexCommandEnv,
          },
        });
        await reportRunnerDiagnostic({
          event: "runner_codex_command_finished",
          failureClass: execution.ok
            ? "runner_codex_command_finished"
            : "runner_codex_command_failed",
          severity: execution.ok ? "trace" : "error",
          ok: execution.ok,
          mode: executionMode,
          details: {
            exit_code: execution.exitCode,
            signal: execution.signal || "",
            timed_out: execution.timedOut,
            duration_ms: execution.durationMs,
            output_chars: normalizeText(execution.output).length,
            diagnostic_output_chars: normalizeText(execution.diagnosticOutput).length,
            reason: execution.ok ? "" : execution.reason,
          },
        });
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
          await reportRunnerDiagnostic({
            event: "runner_resume_fallback_used",
            failureClass: "runner_resume_fallback_used",
            severity: "warning",
            ok: false,
            mode: "resume",
            details: {
              reason: resumeFailureMessage,
              retry_count: codexResumeRecoveryCount,
              invalidated_session_state: summarizeCodexSessionStateForDiagnostic(
                invalidatedSession.codexSessionState,
              ),
            },
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
        const promptSyncResult = await flushServerOwnedCodeq8File({
          publicBaseUrl,
          webChatRunToken: resolveWebChatRunToken(codexCommandEnv),
          workspaceRepository: activeWorkspaceRepository,
          threadId,
          runId,
          hydratedFile: hydratedCodeq8File,
          assistantMessage,
        });
        assistantMessage = truncate(promptSyncResult.assistantMessage, MAX_OUTPUT_CHARS);
        if (promptSyncResult.promptSaved) {
          log(
            "Persisted runner-owned codeq8.md changes",
            `revision=${promptSyncResult.latestRevisionId || "<unknown>"}`,
          );
        }

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
        const finalWorkspaceState = await readFinalWorkspaceStateCallbackPayload({
          workspacePath: preparedWorkspace.workspacePath,
          commandEnv,
          branch: finalBranch,
        });

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
                final_workspace_state: finalWorkspaceState || undefined,
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
              mode: executionMode,
              expectedRunMarker: currentRunMarker,
              reportRunnerDiagnostic,
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
            mode: executionMode,
            expectedRunMarker: currentRunMarker,
            reportRunnerDiagnostic,
          });
          log(
            "Persisted Codex session bundle",
            `mode=${executionMode} revision=${persistedCodexSessionState.bundle_revision} bytes=${persistedCodexSessionState.bundle_size_bytes}`,
          );
        } catch (sessionError) {
          const sessionMessage =
            sessionError instanceof Error ? sessionError.message : String(sessionError);
          if (shouldContinueAfterCodexSessionPersistenceFailure(sessionMessage)) {
            nonFatalCodexSessionLoadWarning = truncate(
              [
                nonFatalCodexSessionLoadWarning,
                `Continuing without an updated Codex session bundle after a transient persistence failure: ${sessionMessage}`,
              ]
                .filter(Boolean)
                .join("\n\n"),
              1000,
            );
            persistedCodexSessionState = codexSessionState;
            await reportRunnerDiagnostic({
              event: "runner_session_persistence_failed_nonfatal",
              failureClass: "runner_session_persistence_failed_nonfatal",
              severity: "warning",
              ok: false,
              mode: executionMode,
              details: {
                error: sessionMessage,
                fallback_session_state: summarizeCodexSessionStateForDiagnostic(
                  persistedCodexSessionState,
                ),
                expected_bundle_revision: expectedBundleRevision,
              },
            });
            log(
              "WARN",
              "Continuing after transient Codex session persistence failure",
              `thread_id=${threadId} run_id=${runId} reason=${truncate(sessionMessage, 500)}`,
            );
          } else {
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
          publicBaseUrl,
          webChatRunToken: resolveWebChatRunToken(commandEnv),
          workspacePath: preparedWorkspace.workspacePath,
          commandEnv,
          sourceType: activeSourceType,
          branch: finalBranch,
          writeMode: activeBranchContext.write_mode,
          repository: activeWorkspaceRepository,
          threadId,
          runId,
          headRepository: preparedWorkspace.cloneRepository,
          baseBranch: preparedWorkspace.baseBranch,
          gitToken: workspaceGitToken,
          protectedBranches: preparedWorkspace.protectedBranches,
          baselineState: workspacePersistenceState,
          threadTitle: activeThreadTitle,
          assistantMessage,
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
          const executionFailureDetails =
            [execution.reason, execution.diagnosticOutput]
              .map((entry) => normalizeText(entry))
              .filter(Boolean)
              .join("\n\n") || "Web chat runner failed.";
          const userVisibleFailureMessage = toUserVisibleRunnerFailureMessage(
            executionFailureDetails,
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
            final_workspace_state: finalWorkspaceState || undefined,
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
        await reportRunnerDiagnostic({
          event: "runner_run_finished",
          failureClass: "runner_run_finished",
          mode: executionMode,
          details: {
            status: "completed",
            duration_ms: execution.durationMs,
            exit_code: execution.exitCode,
            signal: execution.signal || "",
            timed_out: execution.timedOut,
            recovered_transport_failure: recoveredTransportFailure,
            persisted_session_state: summarizeCodexSessionStateForDiagnostic(
              persistedCodexSessionState,
            ),
            resolved_write_branch:
              persistenceResult.resolvedWriteBranch ||
              preparedWorkspace.durableWriteBranch ||
              "",
            resolved_pull_request_number: resolvedPullRequestNumber,
            has_resolved_pull_request_url: Boolean(resolvedPullRequestUrl),
            thread_target_restart_count: threadTargetRestartCount,
          },
        });
        log(
          "Web chat runner completed successfully",
          `duration_ms=${execution.durationMs}`,
        );
        return;
      } catch (error) {
        throw error;
      } finally {
        if (runRuntime === attemptRunRuntime) {
          runRuntime = null;
        }
        await cleanupWebChatRunRuntime(attemptRunRuntime);
      }
    }
  } catch (error) {
    const message = extractErrorMessage(error);
    log("ERROR", message);
    const failureFinalWorkspaceState = preparedWorkspace?.workspacePath
      ? await readFinalWorkspaceStateCallbackPayload({
          workspacePath: preparedWorkspace.workspacePath,
          commandEnv,
        }).catch(() => null)
      : null;
    await reportRunnerDiagnostic({
      event: "runner_run_finished",
      failureClass: "runner_run_failed",
      severity: "error",
      ok: false,
      mode: executionMode,
      details: {
        status: "failed",
        error: message,
        started: Boolean(startedAt),
        persisted_session_state: summarizeCodexSessionStateForDiagnostic(
          persistedCodexSessionState,
        ),
        final_workspace_state: failureFinalWorkspaceState || null,
        thread_target_restart_count: threadTargetRestartCount,
        nonfatal_session_warning: nonFatalCodexSessionLoadWarning,
      },
    });

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
          final_workspace_state: failureFinalWorkspaceState || undefined,
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
  appendWebChatRunMarkerToPrompt,
  buildCodexPrompt,
  buildCodexRunMetadata,
  buildGitHubActionsControlPlaneUrl,
  buildWebChatRunMarker,
  buildWebChatRunnerDiagnosticRequest,
  buildResumePrompt,
  buildFinalWorkspaceStateCallbackPayload,
  buildUploadedCodexSessionStoredValue,
  captureCodexSessionBundle,
  checkoutPreparedWorkspaceBranch,
  checkoutOriginBranch,
  clearGitOperationState,
  loadCodexSessionStateForExecution,
  clearRecoverableCodexSessionErrorState,
  configureWorkspaceGitCredentialHelper,
  configureWorkspacePushPolicy,
  findBrokenRemoteTrackingRefs,
  flushServerOwnedCodeq8File,
  hydrateServerOwnedCodeq8File,
  applyCodeq8CliRuntimeEnv,
  isInvalidCodexSessionBundleError,
  isRecoverableWorkspaceRefRefreshFailure,
  isRecoverableCodexTransportFailure,
  isRecoverableCodexResumeFailure,
  isRecoverableCodexSessionErrorState,
  isSupersededWebChatRunError,
  shouldContinueAfterCodexSessionPersistenceFailure,
  parseCodexSessionBundleContents,
  isRetryableCodexSessionPersistenceError,
  prepareWebChatCodexSessionUpload,
  persistCapturedCodexSessionBundleWithRetries,
  persistWorkspaceProgress,
  postRunCallback,
  prepareCodeq8Cli,
  prepareRunnerDiscordDmCli,
  prepareGitHubCliAuth,
  pushRememberedThreadBranch,
  findPullRequestForBranch,
  refreshWorkspaceRemoteRefs,
  buildFirebaseStorageDownloadUrl,
  materializeWebChatAttachments,
  normalizeAttachmentRecord,
  postWebChatRunnerDiagnostic,
  readFirebaseStorageAttachment,
  readFirebaseStorageSignedAttachment,
  readWebChatAttachment,
  readWebChatAttachmentReadUrl,
  validateRunnerCodexAuth,
  uploadPreparedWebChatCodexSessionBundle,
  discardPreparedWebChatCodexSessionBundle,
  DEFAULT_TIMEOUT_SECONDS,
  requestWorkspaceGitToken,
  requestServerOwnedCodeq8File,
  requestWebChatRunnerRuntimeManifest,
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
  sessionContainsWebChatRunMarker,
  assertWebChatRunnerRuntimeCompatibility,
  shouldLookUpPullRequest,
  shouldStopBeforeCodexForRunCallbackPayload,
  shouldTreatCodexFailureAsCompleted,
  stripLeadingCodexTransportNoise,
  extractUserVisibleFailureHeadline,
  saveServerOwnedCodeq8File,
  toUserVisibleRunnerFailureMessage,
};

const executedAsScript =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (executedAsScript) {
  await main();
}
