#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_CODE_PUBLIC_URL = "https://codeq8.com";
const DEFAULT_CODE_WORKER_URL = "https://control.codeq8.com";

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(value, fallback = "") {
  const normalized = normalizeText(value || fallback).replace(/\/+$/, "");
  return normalized;
}

function readFlag(args, names, fallback = "") {
  const aliases = Array.isArray(names) ? names : [names];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    for (const name of aliases) {
      if (arg === name) {
        return normalizeText(args[index + 1]);
      }
      if (arg.startsWith(`${name}=`)) {
        return normalizeText(arg.slice(name.length + 1));
      }
    }
  }
  return fallback;
}

function hasFlag(args, names) {
  const aliases = Array.isArray(names) ? names : [names];
  return args.some((arg) => aliases.includes(arg));
}

function removeFlags(args, flagNamesWithValues = [], booleanFlagNames = []) {
  const valueFlags = new Set(flagNamesWithValues);
  const booleanFlags = new Set(booleanFlagNames);
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if ([...valueFlags].some((flag) => arg.startsWith(`${flag}=`))) {
      continue;
    }
    if (booleanFlags.has(arg)) {
      continue;
    }
    positional.push(arg);
  }
  return positional;
}

function buildContext(env = process.env) {
  const publicBaseUrl = normalizeBaseUrl(
    env.CODE_PUBLIC_BASE_URL || env.CODEQ8_PUBLIC_BASE_URL,
    DEFAULT_CODE_PUBLIC_URL,
  );
  const workerUrl = normalizeBaseUrl(
    env.CODE_WORKER_URL || env.CODE_WORKER_CANONICAL_URL,
    DEFAULT_CODE_WORKER_URL,
  );
  return {
    publicBaseUrl,
    workerUrl,
    token: normalizeText(env.CODE_WEB_CHAT_RUN_TOKEN),
    githubSessionCookie: normalizeText(env.CODEQ8_TRIGGERING_GITHUB_WEB_SESSION_COOKIE),
    workspaceRepository: normalizeText(env.CODE_WORKSPACE_REPOSITORY),
    threadId: normalizeText(env.CODE_CHAT_THREAD_ID),
    runId: normalizeText(env.CODE_CHAT_RUN_ID),
  };
}

function requireContext(context) {
  const missing = [];
  if (!context.publicBaseUrl) missing.push("CODE_PUBLIC_BASE_URL");
  if (!context.workerUrl) missing.push("CODE_WORKER_URL");
  if (!context.token) missing.push("CODE_WEB_CHAT_RUN_TOKEN");
  if (!context.workspaceRepository) missing.push("CODE_WORKSPACE_REPOSITORY");
  if (!context.threadId) missing.push("CODE_CHAT_THREAD_ID");
  if (!context.runId) missing.push("CODE_CHAT_RUN_ID");
  if (missing.length > 0) {
    throw new Error(`Missing Codeq8 runner environment: ${missing.join(", ")}.`);
  }
}

function buildHeaders(context, extra = {}) {
  const headers = {
    Authorization: `Bearer ${context.token}`,
    Accept: "application/json",
    ...extra,
  };
  if (context.githubSessionCookie) {
    headers.Cookie = `code_github_session=${context.githubSessionCookie}`;
  }
  return headers;
}

function appendParentQuery(searchParams, context) {
  searchParams.set("workspace_repository", context.workspaceRepository);
  searchParams.set("thread_id", context.threadId);
  searchParams.set("run_id", context.runId);
}

function parentBody(context, extra = {}) {
  return {
    workspace_repository: context.workspaceRepository,
    thread_id: context.threadId,
    run_id: context.runId,
    ...extra,
  };
}

async function requestJson({
  context,
  fetchImpl,
  routeBase,
  path: routePath,
  method = "GET",
  query = null,
  body = null,
}) {
  const base = routeBase === "worker" ? context.workerUrl : context.publicBaseUrl;
  const url = new URL(routePath, `${base}/`);
  if (query instanceof URLSearchParams) {
    for (const [key, value] of query.entries()) {
      if (normalizeText(value)) {
        url.searchParams.set(key, value);
      }
    }
  }
  const response = await fetchImpl(url.toString(), {
    method,
    headers: buildHeaders(context, body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok || payload?.ok === false) {
    throw new Error(
      normalizeText(payload?.error) ||
        `Codeq8 request failed (${response.status || 0}) for ${routePath}.`,
    );
  }
  return payload;
}

function payloadObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function payloadArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstText(...values) {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const normalized = normalizeNumber(value, 0);
    if (normalized > 0) {
      return normalized;
    }
  }
  return 0;
}

function normalizeEpochMs(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function formatTimestamp(value) {
  const epochMs = normalizeEpochMs(value);
  return epochMs > 0 ? new Date(epochMs).toISOString() : "";
}

function formatThreadTarget(thread) {
  const branchContext = payloadObject(thread.branch_context || thread.branchContext);
  const pullRequestNumber = normalizeInteger(
    branchContext.pull_request_number || branchContext.pullRequestNumber,
    0,
  );
  if (pullRequestNumber > 0) {
    return `#${pullRequestNumber}`;
  }
  return (
    normalizeText(branchContext.context_branch || branchContext.contextBranch) ||
    normalizeText(branchContext.base_branch || branchContext.baseBranch) ||
    normalizeText(thread.source_type || thread.sourceType)
  );
}

function formatThreadRunStatus(thread) {
  return (
    normalizeText(thread.latest_run_status || thread.latestRunStatus) ||
    normalizeText(payloadObject(thread.latest_run || thread.latestRun).status) ||
    normalizeText(payloadObject(thread.run || {}).status)
  );
}

function formatThreadUpdatedAt(thread) {
  return formatTimestamp(
    thread.updated_at ||
      thread.updatedAt ||
      thread.last_message_at ||
      thread.lastMessageAt ||
      thread.created_at ||
      thread.createdAt,
  );
}

function readThreadParentThreadId(thread) {
  return firstText(thread.parent_thread_id, thread.parentThreadId);
}

function formatThreadRelation(thread) {
  const parentThreadId = readThreadParentThreadId(thread);
  return parentThreadId ? `child-of:${parentThreadId}` : "top-level";
}

function writeCompactThreadList(
  stdout,
  payload,
  { assignedLabel = "me", childrenOfThreadId = "", showRelationColumn = false, status = "" } = {},
) {
  const threads = payloadArray(payload.threads);
  const repository = normalizeText(payload.repository);
  const normalizedStatus = normalizeText(status || payload.status || "");
  stdout.write(`Repository: ${repository || "(unknown)"}\n`);
  if (childrenOfThreadId) {
    stdout.write(`Children of: ${childrenOfThreadId}\n`);
  } else {
    stdout.write(`Assigned: ${assignedLabel || "me"}\n`);
  }
  if (normalizedStatus) {
    stdout.write(`Status: ${normalizedStatus}\n`);
  }
  const lifecycleFilter = firstText(payload.lifecycle_filter, payload.lifecycleFilter);
  if (lifecycleFilter) {
    stdout.write(`Lifecycle filter: ${lifecycleFilter}\n`);
  }
  const lifecycleNote = firstText(payload.lifecycle_note, payload.lifecycleNote);
  if (lifecycleNote) {
    stdout.write(`Lifecycle note: ${lifecycleNote}\n`);
  } else if (childrenOfThreadId) {
    stdout.write("Lifecycle note: Child thread listing currently supports the active/open lifecycle only.\n");
  }
  stdout.write("\n");

  if (threads.length === 0) {
    stdout.write(
      childrenOfThreadId
        ? "No open child threads.\n"
        : "No matching assigned threads.\n",
    );
  } else {
    stdout.write(
      showRelationColumn
        ? "thread_id\tstatus\trelation\trun\ttarget\tupdated_at\ttitle\n"
        : "thread_id\tstatus\trun\ttarget\tupdated_at\ttitle\n",
    );
    for (const entry of threads) {
      const thread = payloadObject(entry);
      const columns = [
        normalizeText(thread.thread_id || thread.threadId),
        normalizeText(thread.status),
      ];
      if (showRelationColumn) {
        columns.push(formatThreadRelation(thread));
      }
      columns.push(
        formatThreadRunStatus(thread),
        formatThreadTarget(thread),
        formatThreadUpdatedAt(thread),
        normalizeText(thread.title || "(untitled)").replace(/\s+/g, " "),
      );
      stdout.write(columns.join("\t") + "\n");
    }
  }

  stdout.write("\n");
  stdout.write(`Page count: ${normalizeInteger(payload.page_count || payload.pageCount, 0)}\n`);
  stdout.write(`Has more: ${payload.has_more || payload.hasMore ? "yes" : "no"}\n`);
  const nextUpdatedAt = normalizeEpochMs(payload.next_before_updated_at || payload.nextBeforeUpdatedAt);
  const nextThreadId = normalizeText(payload.next_before_thread_id || payload.nextBeforeThreadId);
  if (nextUpdatedAt || nextThreadId) {
    stdout.write(
      `Next: --before-updated-at ${nextUpdatedAt || ""} --before-thread-id ${nextThreadId}\n`,
    );
  }
}

function truncateText(value, maxLength = 240) {
  const normalized = redactSensitiveText(normalizeText(value).replace(/\s+/g, " "));
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function isSensitiveOutputKey(key) {
  const normalized = normalizeText(key).toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (
    new Set([
      "token_budget",
      "tokenbudget",
      "tokens_used",
      "tokensused",
      "token_usage",
      "tokenusage",
      "token_usage_updates",
      "tokenusageupdates",
    ]).has(normalized)
  ) {
    return false;
  }
  return (
    /(^|_)(authorization|cookie|credential|handoff|password|secret|session|token)($|_)/i.test(
      normalized,
    ) ||
    /(^|_)api_?key($|_)/i.test(normalized) ||
    /(^|_)private_?key($|_)/i.test(normalized) ||
    normalized === "session_bundle_key" ||
    normalized === "bundle_storage_key"
  );
}

function redactSensitiveText(value) {
  return normalizeText(value)
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /\b(thread_stream_token|thread_record_handoff|run_record_handoff|repository_access_handoff|codex_session_state|github_web_session_cookie|session_id|session_file_relative_path|session_bundle_key|bundle_storage_key|authorization|cookie|credential|handoff|token|secret|password|api_key|private_key)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[redacted]",
    );
}

function sanitizeForOutput(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForOutput(entry));
  }
  if (value && typeof value === "object") {
    const sanitized = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isSensitiveOutputKey(key)) {
        continue;
      }
      sanitized[key] = sanitizeForOutput(entry);
    }
    return sanitized;
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  return value;
}

function writeJson(stdout, payload) {
  stdout.write(`${JSON.stringify(sanitizeForOutput(payload), null, 2)}\n`);
}

function compactObject(entries) {
  const output = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

function summarizeThreadForOutput(thread, payload = {}) {
  const normalized = payloadObject(thread);
  const summary = compactObject({
    thread_id: firstText(
      normalized.thread_id,
      normalized.threadId,
      payload.child_thread_id,
      payload.target_thread_id,
      payload.thread_id,
    ),
    repository: readThreadRepository(normalized, payload),
    title: truncateText(firstText(normalized.title), 160),
    parent_thread_id: firstText(
      normalized.parent_thread_id,
      normalized.parentThreadId,
      payload.target_parent_thread_id,
      payload.targetParentThreadId,
    ),
    status: firstText(normalized.status, payload.status),
    aggregate_status: firstText(normalized.aggregate_status, normalized.aggregateStatus),
    source_type: firstText(normalized.source_type, normalized.sourceType),
    assigned_to_kind: firstText(normalized.assigned_to_kind, normalized.assignedToKind),
    assigned_to_github_login: firstText(
      normalized.assigned_to_github_login,
      normalized.assignedToGithubLogin,
    ),
    updated_at: normalizeEpochMs(normalized.updated_at || normalized.updatedAt),
  });
  return sanitizeForOutput(summary);
}

function summarizeRunForOutput(run) {
  const normalized = payloadObject(run);
  return sanitizeForOutput(
    compactObject({
      run_id: firstText(normalized.run_id, normalized.runId),
      status: firstText(normalized.status),
      started_at: normalizeEpochMs(normalized.started_at || normalized.startedAt),
      updated_at: normalizeEpochMs(normalized.updated_at || normalized.updatedAt),
    }),
  );
}

function summarizeMessageForOutput(message) {
  const summary = summarizeThreadMessage(message);
  return sanitizeForOutput(compactObject(summary));
}

function summarizeGoalForOutput(goal) {
  const normalized = payloadObject(goal);
  return sanitizeForOutput(
    compactObject({
      objective: truncateText(firstText(normalized.objective), 240),
      status: firstText(normalized.status),
      created_at: normalizeEpochMs(normalized.created_at || normalized.createdAt),
      updated_at: normalizeEpochMs(normalized.updated_at || normalized.updatedAt),
    }),
  );
}

function parentSummaryFields(payload) {
  const runnerParentThreadId = firstText(
    payload.runner_parent_thread_id,
    payload.runnerParentThreadId,
    payload.parent_thread_id,
    payload.parentThreadId,
  );
  const runnerParentRunId = firstText(
    payload.runner_parent_run_id,
    payload.runnerParentRunId,
    payload.parent_run_id,
    payload.parentRunId,
  );
  const runnerParentRepository = firstText(
    payload.runner_parent_workspace_repository,
    payload.runnerParentWorkspaceRepository,
    payload.parent_workspace_repository,
    payload.parentWorkspaceRepository,
  );
  return compactObject({
    runner_parent_thread_id: runnerParentThreadId,
    runner_parent_run_id: runnerParentRunId,
    runner_parent_workspace_repository: runnerParentRepository,
    // Backward-compatible aliases for callers that still read parent_*.
    parent_thread_id: runnerParentThreadId,
    parent_run_id: runnerParentRunId,
    parent_workspace_repository: runnerParentRepository,
  });
}

function readThreadOutputId(payload, fallback = "") {
  const thread = payloadObject(payload.thread);
  return firstText(
    payload.child_thread_id,
    payload.childThreadId,
    payload.target_thread_id,
    payload.targetThreadId,
    payload.assigned_thread_id,
    payload.assignedThreadId,
    payload.thread_id,
    payload.threadId,
    thread.thread_id,
    thread.threadId,
    fallback,
  );
}

function readDelegatedDispatchState(payload) {
  if (payload.delegated_dispatch_failed || payload.delegatedDispatchFailed) {
    return "failed";
  }
  if (payload.delegated) {
    return "delegated";
  }
  if (payload.ok) {
    return "created";
  }
  return "";
}

function buildDelegatedThreadCreateOutput(payload) {
  const thread = summarizeThreadForOutput(payload.thread, payload);
  const threadId = readThreadOutputId(payload);
  const message = summarizeMessageForOutput(payload.message);
  const followUpMessageCommand = threadId
    ? `codeq8 threads message ${threadId} --text "..."`
    : "";
  return compactObject({
    ok: Boolean(payload.ok),
    delegated: Boolean(payload.delegated),
    child_thread_id: threadId,
    delegated_dispatch_failed: payload.delegated_dispatch_failed ? true : undefined,
    dispatch_state: readDelegatedDispatchState(payload),
    ...parentSummaryFields(payload),
    thread,
    run: summarizeRunForOutput(payload.run),
    message,
    follow_up_inspect_command: threadId ? `codeq8 threads inspect ${threadId}` : "",
    follow_up_message_command: followUpMessageCommand,
    follow_up_command: followUpMessageCommand,
  });
}

function buildDelegatedThreadMessageOutput(payload, fallbackThreadId) {
  const thread = summarizeThreadForOutput(payload.thread, payload);
  const threadId = readThreadOutputId(payload, fallbackThreadId);
  const message = summarizeMessageForOutput(payload.message);
  return compactObject({
    ok: Boolean(payload.ok),
    delegated: Boolean(payload.delegated),
    child_thread_id: threadId,
    ...parentSummaryFields(payload),
    thread,
    message,
    follow_up_command: threadId ? `codeq8 threads inspect ${threadId}` : "",
  });
}

function buildAssignedThreadOutput(payload, fallbackThreadId) {
  return compactObject({
    ok: Boolean(payload.ok),
    assigned: Boolean(payload.assigned),
    updated: payload.updated !== false,
    assigned_thread_id: readThreadOutputId(payload, fallbackThreadId),
    assigned_to_github_login: firstText(payload.assigned_to_github_login, payload.assignedToGithubLogin),
    assigned_by_github_login: firstText(payload.assigned_by_github_login, payload.assignedByGithubLogin),
    ...parentSummaryFields(payload),
    thread: summarizeThreadForOutput(payload.thread, payload),
    error: firstText(payload.error),
  });
}

function buildThreadGoalOutput(payload, fallbackThreadId) {
  return compactObject({
    ok: Boolean(payload.ok),
    updated: payload.updated !== false,
    cleared: Boolean(payload.cleared),
    target_thread_id: readThreadOutputId(payload, fallbackThreadId),
    ...parentSummaryFields(payload),
    thread: summarizeThreadForOutput(payload.thread, payload),
    codex_goal_state: summarizeGoalForOutput(payload.codex_goal_state || payload.codexGoalState),
    error: firstText(payload.error),
  });
}

function readThreadBranchContext(thread) {
  return payloadObject(thread.branch_context || thread.branchContext);
}

function readThreadGitHubContext(thread) {
  return payloadObject(thread.github_context || thread.githubContext);
}

function readThreadPullRequest(thread) {
  const branchContext = readThreadBranchContext(thread);
  const githubContext = readThreadGitHubContext(thread);
  const githubPullRequest = payloadObject(
    githubContext.pull_request || githubContext.pullRequest,
  );
  const pullRequestNumber = firstPositiveNumber(
    branchContext.pull_request_number,
    branchContext.pullRequestNumber,
    githubPullRequest.number,
    githubPullRequest.pull_request_number,
  );
  return {
    number: pullRequestNumber,
    url: firstText(
      branchContext.pull_request_url,
      branchContext.pullRequestUrl,
      githubPullRequest.html_url,
      githubPullRequest.url,
    ),
    base_branch: firstText(
      branchContext.pull_request_base_branch,
      branchContext.pullRequestBaseBranch,
      payloadObject(githubPullRequest.base).ref,
    ),
    head_branch: firstText(
      branchContext.pull_request_head_branch,
      branchContext.pullRequestHeadBranch,
      payloadObject(githubPullRequest.head).ref,
    ),
  };
}

function readThreadRepository(thread, payload) {
  const githubContext = readThreadGitHubContext(thread);
  const repository = payloadObject(githubContext.repository);
  return firstText(
    thread.workspace_repository,
    thread.workspaceRepository,
    payload.repository,
    repository.full_name,
    repository.fullName,
  );
}

function summarizeThreadMessage(message) {
  const normalized = payloadObject(message);
  return {
    message_id: firstText(normalized.message_id, normalized.messageId),
    role: firstText(normalized.role),
    created_at: normalizeEpochMs(normalized.created_at || normalized.createdAt),
    preview: truncateText(
      firstText(
        normalized.content,
        normalized.text,
        normalized.preview,
        normalized.message,
      ),
      320,
    ),
  };
}

function readProgressCandidate(value) {
  const candidate = payloadObject(value);
  if (Object.keys(candidate).length === 0) {
    return null;
  }
  const events = payloadArray(candidate.events || candidate.progress_events || candidate.progressEvents);
  const latestEvent = payloadObject(events[events.length - 1]);
  const latestReasoningEvent = [...events]
    .reverse()
    .map((event) => payloadObject(event))
    .find((event) =>
      /reasoning/i.test(firstText(event.item_type, event.itemType, event.kind, event.type)),
    );
  const label = firstText(
    candidate.label,
    candidate.latest_label,
    candidate.latestLabel,
    candidate.status_text,
    candidate.statusText,
    latestEvent.label,
    latestEvent.text,
    latestEvent.message,
  );
  const reasoning = firstText(
    candidate.reasoning,
    candidate.latest_reasoning,
    candidate.latestReasoning,
    latestReasoningEvent?.label,
    latestReasoningEvent?.text,
    latestReasoningEvent?.message,
  );
  const status = firstText(candidate.status, latestEvent.status);
  const revision = firstText(candidate.revision, candidate.version);
  const updatedAt = normalizeEpochMs(
    candidate.updated_at ||
      candidate.updatedAt ||
      latestEvent.updated_at ||
      latestEvent.updatedAt ||
      latestEvent.created_at ||
      latestEvent.createdAt,
  );
  if (!label && !reasoning && !status && !revision && !updatedAt) {
    return null;
  }
  return {
    status,
    label: truncateText(label, 240),
    reasoning: truncateText(reasoning, 240),
    revision,
    updated_at: updatedAt,
  };
}

function readThreadProgressFacts(payload, thread) {
  const threadAppServer = payloadObject(thread.app_server || thread.appServer);
  const payloadAppServer = payloadObject(payload.app_server || payload.appServer);
  const candidates = [
    payload.progress,
    payload.live_status,
    payload.liveStatus,
    payload.app_server_progress,
    payload.appServerProgress,
    payloadAppServer.progress,
    payloadAppServer.live_status,
    thread.progress,
    thread.live_status,
    thread.liveStatus,
    thread.app_server_progress,
    thread.appServerProgress,
    threadAppServer.progress,
    threadAppServer.live_status,
  ];
  for (const candidate of candidates) {
    const progress = readProgressCandidate(candidate);
    if (progress) {
      return progress;
    }
  }
  return null;
}

function buildThreadInspectSnapshot(payload) {
  const thread = payloadObject(payload.thread);
  const branchContext = readThreadBranchContext(thread);
  const pullRequest = readThreadPullRequest(thread);
  const progress = readThreadProgressFacts(payload, thread);
  const targetThreadId = firstText(
    payload.target_thread_id,
    payload.child_thread_id,
    payload.thread_id,
    thread.thread_id,
    thread.threadId,
  );
  const runnerParentThreadId = firstText(
    payload.runner_parent_thread_id,
    payload.runnerParentThreadId,
    payload.parent_thread_id,
    payload.parentThreadId,
  );
  const runnerParentRunId = firstText(
    payload.runner_parent_run_id,
    payload.runnerParentRunId,
    payload.parent_run_id,
    payload.parentRunId,
  );
  const runnerParentRepository = firstText(
    payload.runner_parent_workspace_repository,
    payload.runnerParentWorkspaceRepository,
    payload.parent_workspace_repository,
    payload.parentWorkspaceRepository,
  );
  const targetParentThreadId = firstText(
    payload.target_parent_thread_id,
    payload.targetParentThreadId,
    thread.parent_thread_id,
    thread.parentThreadId,
  );
  const latestRunId = firstText(
    thread.latest_run_id,
    thread.latestRunId,
    payloadObject(thread.latest_run || thread.latestRun).run_id,
    payloadObject(thread.run).run_id,
  );
  const latestRunStatus = formatThreadRunStatus(thread);
  const latestRunStartedAt = normalizeEpochMs(
    thread.latest_run_started_at ||
      thread.latestRunStartedAt ||
      payloadObject(thread.latest_run || thread.latestRun).started_at ||
      payloadObject(thread.run).started_at,
  );
  const latestRunUpdatedAt = normalizeEpochMs(
    thread.last_run_at ||
      thread.lastRunAt ||
      thread.latest_run_at ||
      thread.latestRunAt ||
      payloadObject(thread.latest_run || thread.latestRun).updated_at ||
      payloadObject(thread.run).updated_at,
  );
  const recentMessages = payloadArray(payload.messages)
    .map((message) => summarizeThreadMessage(message))
    .filter((message) => message.message_id || message.role || message.preview);

  return {
    ok: Boolean(payload.ok),
    inspected: true,
    runner_parent_thread_id: runnerParentThreadId,
    runner_parent_run_id: runnerParentRunId,
    runner_parent_workspace_repository: runnerParentRepository,
    target_parent_thread_id: targetParentThreadId,
    target_thread_id: targetThreadId,
    thread: {
      thread_id: targetThreadId,
      repository: readThreadRepository(thread, payload),
      title: truncateText(thread.title || "(untitled)", 160),
      parent_thread_id: targetParentThreadId,
      status: firstText(thread.status),
      aggregate_status: firstText(thread.aggregate_status, thread.aggregateStatus),
      source_type: firstText(thread.source_type, thread.sourceType),
      assigned_to_kind: firstText(thread.assigned_to_kind, thread.assignedToKind),
      assigned_to_github_login: firstText(
        thread.assigned_to_github_login,
        thread.assignedToGithubLogin,
      ),
      updated_at: normalizeEpochMs(thread.updated_at || thread.updatedAt),
    },
    run: {
      run_id: latestRunId,
      status: latestRunStatus,
      started_at: latestRunStartedAt,
      updated_at: latestRunUpdatedAt,
    },
    checks: {
      latest_state: firstText(thread.latest_check_state, thread.latestCheckState),
    },
    pull_request: pullRequest,
    branch: {
      context_branch: firstText(branchContext.context_branch, branchContext.contextBranch),
      base_branch: firstText(branchContext.base_branch, branchContext.baseBranch),
      head_branch: firstText(
        branchContext.pull_request_head_branch,
        branchContext.pullRequestHeadBranch,
        branchContext.write_branch,
        branchContext.writeBranch,
      ),
      target: formatThreadTarget(thread),
    },
    latest_message: {
      role: firstText(thread.latest_message_role, thread.latestMessageRole),
      preview: truncateText(
        firstText(thread.latest_message_preview, thread.latestMessagePreview),
        240,
      ),
      at: normalizeEpochMs(thread.last_message_at || thread.lastMessageAt),
    },
    progress: progress || {
      status: "",
      label: "",
      reasoning: "",
      revision: "",
      updated_at: 0,
    },
    recent_messages: recentMessages,
    page: {
      count: normalizeInteger(payload.page_count || payload.pageCount, recentMessages.length),
      total_count: normalizeInteger(payload.total_count || payload.totalCount, recentMessages.length),
      has_more: Boolean(payload.has_more || payload.hasMore),
      next_before_created_at: normalizeEpochMs(
        payload.next_before_created_at || payload.nextBeforeCreatedAt,
      ),
      next_before_message_id: firstText(
        payload.next_before_message_id,
        payload.nextBeforeMessageId,
      ),
    },
    follow_up_command: targetThreadId
      ? `codeq8 threads message ${targetThreadId} --text "..."`
      : "",
  };
}

function writeThreadInspect(stdout, snapshot) {
  const thread = payloadObject(snapshot.thread);
  const run = payloadObject(snapshot.run);
  const checks = payloadObject(snapshot.checks);
  const pullRequest = payloadObject(snapshot.pull_request);
  const branch = payloadObject(snapshot.branch);
  const latestMessage = payloadObject(snapshot.latest_message);
  const progress = payloadObject(snapshot.progress);
  const page = payloadObject(snapshot.page);
  const recentMessages = payloadArray(snapshot.recent_messages);

  stdout.write(`Thread: ${thread.thread_id || snapshot.target_thread_id || "(unknown)"}\n`);
  stdout.write(`Title: ${thread.title || "(untitled)"}\n`);
  stdout.write(`Repository: ${thread.repository || "(unknown)"}\n`);
  const statusLine = [
    thread.status ? `status=${thread.status}` : "",
    thread.aggregate_status ? `aggregate=${thread.aggregate_status}` : "",
  ].filter(Boolean).join(" ");
  stdout.write(`State: ${statusLine || "(unknown)"}\n`);
  if (thread.assigned_to_kind || thread.assigned_to_github_login) {
    stdout.write(
      `Assignee: ${[thread.assigned_to_kind, thread.assigned_to_github_login]
        .filter(Boolean)
        .join(" ") || "(unknown)"}\n`,
    );
  }
  if (snapshot.runner_parent_thread_id || snapshot.runner_parent_run_id) {
    stdout.write(
      `Runner parent: ${[
        snapshot.runner_parent_thread_id,
        snapshot.runner_parent_run_id ? `run=${snapshot.runner_parent_run_id}` : "",
      ].filter(Boolean).join(" ") || "(unknown)"}\n`,
    );
  }
  if (thread.parent_thread_id || snapshot.target_parent_thread_id) {
    stdout.write(`Target parent: ${thread.parent_thread_id || snapshot.target_parent_thread_id}\n`);
  } else {
    stdout.write("Target parent: (none)\n");
  }
  const pullRequestLabel = pullRequest.number
    ? `PR #${pullRequest.number}${pullRequest.url ? ` ${pullRequest.url}` : ""}`
    : "";
  const branchLabel = [
    branch.target ? `target=${branch.target}` : "",
    branch.head_branch || branch.base_branch
      ? `${branch.head_branch || "?"} -> ${branch.base_branch || "?"}`
      : "",
  ].filter(Boolean).join(" ");
  stdout.write(`Source: ${pullRequestLabel || branchLabel || thread.source_type || "(unknown)"}\n`);
  if (run.run_id || run.status) {
    stdout.write(
      `Run: ${[run.run_id, run.status].filter(Boolean).join(" ") || "(unknown)"}`,
    );
    const runTimes = [
      run.started_at ? `started ${formatTimestamp(run.started_at)}` : "",
      run.updated_at ? `updated ${formatTimestamp(run.updated_at)}` : "",
    ].filter(Boolean).join(", ");
    stdout.write(runTimes ? ` (${runTimes})\n` : "\n");
  }
  stdout.write(`Checks: ${checks.latest_state || "(none)"}\n`);
  if (progress.status || progress.label || progress.reasoning) {
    stdout.write(
      `Progress: ${[
        progress.status ? `status=${progress.status}` : "",
        progress.label,
        progress.reasoning ? `reasoning=${progress.reasoning}` : "",
      ].filter(Boolean).join(" | ")}\n`,
    );
  }
  if (latestMessage.role || latestMessage.preview) {
    stdout.write(
      `Latest message: ${[
        latestMessage.role,
        latestMessage.preview,
        latestMessage.at ? formatTimestamp(latestMessage.at) : "",
      ].filter(Boolean).join(" | ")}\n`,
    );
  }
  stdout.write("\nRecent messages:\n");
  if (recentMessages.length === 0) {
    stdout.write("- (none returned)\n");
  } else {
    for (const message of recentMessages) {
      const createdAt = message.created_at ? `${formatTimestamp(message.created_at)} ` : "";
      stdout.write(
        `- ${createdAt}${message.role || "message"}: ${message.preview || "(empty)"}\n`,
      );
    }
  }
  stdout.write("\n");
  stdout.write(`Follow-up: ${snapshot.follow_up_command || "codeq8 threads message <thread-id> --text \"...\""}\n`);
  stdout.write(
    `Page: ${page.count || recentMessages.length} message(s), has more: ${
      page.has_more ? "yes" : "no"
    }\n`,
  );
  if (page.next_before_created_at || page.next_before_message_id) {
    stdout.write(
      `Next: --before-created-at ${page.next_before_created_at || ""} --before-message-id ${
        page.next_before_message_id || ""
      }\n`,
    );
  }
}

function writeDelegatedThreadCreate(stdout, snapshot) {
  const thread = payloadObject(snapshot.thread);
  const run = payloadObject(snapshot.run);
  const message = payloadObject(snapshot.message);
  const threadId = snapshot.child_thread_id || thread.thread_id || "(unknown)";
  const statusLine = [
    thread.status ? `status=${thread.status}` : "",
    run.status ? `run=${run.status}` : "",
    snapshot.dispatch_state ? `dispatch=${snapshot.dispatch_state}` : "",
  ].filter(Boolean).join(" ");

  stdout.write(`Created thread: ${threadId}\n`);
  stdout.write(`Title: ${thread.title || "(untitled)"}\n`);
  stdout.write(`Repository: ${thread.repository || snapshot.parent_workspace_repository || "(unknown)"}\n`);
  stdout.write(`State: ${statusLine || "(unknown)"}\n`);
  if (snapshot.parent_thread_id || snapshot.parent_run_id) {
    stdout.write(
      `Parent: ${[snapshot.parent_thread_id, snapshot.parent_run_id ? `run=${snapshot.parent_run_id}` : ""]
        .filter(Boolean)
        .join(" ")}\n`,
    );
  }
  if (message.preview || message.message_id || message.role) {
    stdout.write(
      `Initial message: ${[
        message.role,
        message.message_id,
        message.preview,
      ].filter(Boolean).join(" | ")}\n`,
    );
  }
  stdout.write("\n");
  stdout.write(
    `Follow-up inspect: ${snapshot.follow_up_inspect_command || `codeq8 threads inspect ${threadId}`}\n`,
  );
  stdout.write(
    `Follow-up message: ${snapshot.follow_up_message_command || snapshot.follow_up_command || `codeq8 threads message ${threadId} --text "..."`}\n`,
  );
}

function printHelp(stdout) {
  stdout.write(
    [
      "Codeq8 runner helper",
      "",
      "Usage:",
      "  codeq8 threads mine [--status active|all] [--limit 25]",
      "  codeq8 threads search [--search text] [--status active|all] [--limit 25]",
      "  codeq8 threads children [parent-thread-id] [--status active] [--limit 25] [--json]",
      "  codeq8 threads context <thread-id> [--limit 20]",
      "  codeq8 threads inspect <thread-id> [--limit 12] [--json]",
      "  codeq8 threads assign <thread-id> [--assigned-to me]",
      "  codeq8 threads create --title title --message text [--assigned-to codeq8|me] [--json]",
      "  codeq8 threads message <thread-id> --text text",
      "  codeq8 threads archive <thread-id>  (alias: close)",
      "  codeq8 threads reopen <thread-id>",
      "  codeq8 threads goal <thread-id> --objective text [--status active|paused]",
      "  codeq8 threads goal <thread-id> --clear",
      "  codeq8 threads state <thread-id> [--limit 50]",
      "  codeq8 attachments get --attachment <attachment-id> [--thread <thread-id>] [--output file]",
      "  codeq8 github issue attachments <url|number> [--repo owner/repo] [--comments] --output-dir dir",
      "",
      "Authentication is read from the Codeq8 runner environment. Tokens are never printed.",
      "Assigned thread lists label child rows as child-of:<parent-thread-id>.",
      "Child thread listing defaults to the current parent thread and currently supports the active/open lifecycle only.",
      "",
    ].join("\n"),
  );
}

async function handleThreadsCommand({ args, context, fetchImpl, stdout }) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "help") {
    printHelp(stdout);
    return 0;
  }

  if (command === "mine") {
    const query = new URLSearchParams();
    const status = readFlag(rest, "--status", "active");
    appendParentQuery(query, context);
    query.set("status", status);
    query.set("assigned_to", "me");
    query.set("search", readFlag(rest, ["--search", "--query", "-q"]));
    query.set("limit", readFlag(rest, "--limit", "25"));
    query.set("before_updated_at", readFlag(rest, "--before-updated-at"));
    query.set("before_thread_id", readFlag(rest, "--before-thread-id"));
    const payload = await requestJson({
      context,
      fetchImpl,
      routeBase: "public",
      path: "/api/chat/runs/thread-search",
      query,
    });
    writeCompactThreadList(stdout, payload, {
      assignedLabel: "me",
      showRelationColumn: true,
      status,
    });
    return 0;
  }

  if (command === "search" || command === "list") {
    const query = new URLSearchParams();
    appendParentQuery(query, context);
    query.set("status", readFlag(rest, "--status", "active"));
    query.set("search", readFlag(rest, ["--search", "--query", "-q"]));
    query.set("limit", readFlag(rest, "--limit", "25"));
    query.set("before_updated_at", readFlag(rest, "--before-updated-at"));
    query.set("before_thread_id", readFlag(rest, "--before-thread-id"));
    query.set("pull_request_number", readFlag(rest, "--pull-request-number"));
    query.set("pull_request_url", readFlag(rest, "--pull-request-url"));
    writeJson(
      stdout,
      await requestJson({
        context,
        fetchImpl,
        routeBase: "public",
        path: "/api/chat/runs/thread-search",
        query,
      }),
    );
    return 0;
  }

  if (command === "children" || command === "child-list") {
    const positional = removeFlags(rest, [
      "--status",
      "--limit",
      "--before-updated-at",
      "--before-thread-id",
    ], ["--json"]);
    const parentThreadId = normalizeText(positional[0]) || context.threadId;
    const status = readFlag(rest, "--status", "active");
    if (status && status.toLowerCase() !== "active") {
      throw new Error("codeq8 threads children currently supports --status active only.");
    }
    const query = new URLSearchParams();
    appendParentQuery(query, context);
    query.set("children_of_thread_id", parentThreadId);
    query.set("status", status);
    query.set("limit", readFlag(rest, "--limit", "25"));
    query.set("before_updated_at", readFlag(rest, "--before-updated-at"));
    query.set("before_thread_id", readFlag(rest, "--before-thread-id"));
    const payload = await requestJson({
      context,
      fetchImpl,
      routeBase: "public",
      path: "/api/chat/runs/thread-search",
      query,
    });
    if (hasFlag(rest, "--json")) {
      writeJson(stdout, payload);
    } else {
      writeCompactThreadList(stdout, payload, {
        childrenOfThreadId: firstText(
          payload.children_of_thread_id,
          payload.childrenOfThreadId,
          parentThreadId,
        ),
        status,
      });
    }
    return 0;
  }

  if (command === "context" || command === "show") {
    const positional = removeFlags(rest, ["--limit", "--before-created-at", "--before-message-id"]);
    const targetThreadId = normalizeText(positional[0]);
    if (!targetThreadId) {
      throw new Error("thread id is required.");
    }
    const query = new URLSearchParams();
    appendParentQuery(query, context);
    query.set("target_thread_id", targetThreadId);
    query.set("limit", readFlag(rest, "--limit", "20"));
    query.set("before_created_at", readFlag(rest, "--before-created-at"));
    query.set("before_message_id", readFlag(rest, "--before-message-id"));
    writeJson(
      stdout,
      await requestJson({
        context,
        fetchImpl,
        routeBase: "public",
        path: "/api/chat/runs/thread-context",
        query,
      }),
    );
    return 0;
  }

  if (command === "inspect") {
    const positional = removeFlags(
      rest,
      ["--limit", "--before-created-at", "--before-message-id"],
      ["--json"],
    );
    const childThreadId = normalizeText(positional[0]);
    if (!childThreadId) {
      throw new Error("thread id is required.");
    }
    const query = new URLSearchParams();
    appendParentQuery(query, context);
    query.set("child_thread_id", childThreadId);
    query.set("limit", readFlag(rest, "--limit", "12"));
    query.set("before_created_at", readFlag(rest, "--before-created-at"));
    query.set("before_message_id", readFlag(rest, "--before-message-id"));
    const payload = await requestJson({
      context,
      fetchImpl,
      routeBase: "public",
      path: "/api/chat/runs/delegated-thread-state",
      query,
    });
    const snapshot = buildThreadInspectSnapshot(payload);
    if (hasFlag(rest, "--json")) {
      writeJson(stdout, snapshot);
    } else {
      writeThreadInspect(stdout, snapshot);
    }
    return 0;
  }

  if (command === "assign") {
    const positional = removeFlags(rest, ["--assigned-to"]);
    const assignedThreadId = normalizeText(positional[0]);
    if (!assignedThreadId) {
      throw new Error("thread id is required.");
    }
    const payload = await requestJson({
      context,
      fetchImpl,
      routeBase: "public",
      path: "/api/chat/runs/assigned-thread",
      method: "POST",
      body: parentBody(context, {
        assigned_thread_id: assignedThreadId,
        assigned_to_github_login: readFlag(rest, "--assigned-to", "me"),
      }),
    });
    writeJson(stdout, buildAssignedThreadOutput(payload, assignedThreadId));
    return 0;
  }

  if (command === "create") {
    const title = readFlag(rest, "--title");
    const message = readFlag(rest, ["--message", "--text"]);
    if (!message) {
      throw new Error("--message is required.");
    }
    const assignedTo = readFlag(rest, "--assigned-to");
    const body = parentBody(context, {
      title,
      initial_message: {
        role: "user",
        content: message,
      },
    });
    if (assignedTo) {
      if (assignedTo.toLowerCase() === "codeq8") {
        body.assigned_to_kind = "codeq8";
      } else {
        body.assigned_to_github_login = assignedTo;
      }
    }
    const payload = await requestJson({
      context,
      fetchImpl,
      routeBase: "public",
      path: "/api/chat/runs/delegated-threads",
      method: "POST",
      body,
    });
    const output = buildDelegatedThreadCreateOutput(payload);
    if (hasFlag(rest, "--json")) {
      writeJson(stdout, output);
    } else {
      writeDelegatedThreadCreate(stdout, output);
    }
    return 0;
  }

  if (command === "message" || command === "send") {
    const positional = removeFlags(rest, ["--text", "--message"]);
    const childThreadId = normalizeText(positional[0]);
    const content = readFlag(rest, ["--text", "--message"]);
    if (!childThreadId) {
      throw new Error("thread id is required.");
    }
    if (!content) {
      throw new Error("--text is required.");
    }
    const payload = await requestJson({
      context,
      fetchImpl,
      routeBase: "public",
      path: "/api/chat/runs/delegated-thread-messages",
      method: "POST",
      body: parentBody(context, {
        child_thread_id: childThreadId,
        content,
        role: "user",
      }),
    });
    writeJson(stdout, buildDelegatedThreadMessageOutput(payload, childThreadId));
    return 0;
  }

  if (command === "archive" || command === "close") {
    const positional = removeFlags(rest);
    const targetThreadId = normalizeText(positional[0]);
    if (!targetThreadId) {
      throw new Error("thread id is required.");
    }
    const payload = await requestJson({
      context,
      fetchImpl,
      routeBase: "public",
      path: "/api/chat/runs/thread-archive",
      method: "POST",
      body: parentBody(context, {
        target_thread_id: targetThreadId,
      }),
    });
    const thread = payloadObject(payload.thread);
    writeJson(stdout, {
      ok: true,
      thread_id: normalizeText(thread.thread_id) || targetThreadId,
      status: normalizeText(thread.status) || "archived",
      updated: payload.updated !== false,
    });
    return 0;
  }

  if (command === "reopen") {
    const positional = removeFlags(rest);
    const targetThreadId = normalizeText(positional[0]);
    if (!targetThreadId) {
      throw new Error("thread id is required.");
    }
    const payload = await requestJson({
      context,
      fetchImpl,
      routeBase: "public",
      path: "/api/chat/runs/thread-reopen",
      method: "POST",
      body: parentBody(context, {
        target_thread_id: targetThreadId,
      }),
    });
    const thread = payloadObject(payload.thread);
    writeJson(stdout, {
      ok: true,
      thread_id: normalizeText(thread.thread_id) || targetThreadId,
      status: normalizeText(thread.status) || "active",
      updated: payload.updated !== false,
    });
    return 0;
  }

  if (command === "goal" || command === "set-goal") {
    const positional = removeFlags(
      rest,
      ["--objective", "--goal", "--text", "--status"],
      ["--clear"],
    );
    const targetThreadId = normalizeText(positional[0]);
    const clear = hasFlag(rest, "--clear");
    const objective = readFlag(rest, ["--objective", "--goal", "--text"]);
    const status = readFlag(rest, "--status");
    if (!targetThreadId) {
      throw new Error("thread id is required.");
    }
    if (clear && objective) {
      throw new Error("--objective must be omitted when --clear is used.");
    }
    if (!clear && !objective) {
      throw new Error("--objective is required unless --clear is used.");
    }
    if (status && !["active", "paused"].includes(status.toLowerCase())) {
      throw new Error("--status must be active or paused.");
    }
    const payload = await requestJson({
      context,
      fetchImpl,
      routeBase: "public",
      path: "/api/chat/runs/thread-goal",
      method: "POST",
      body: parentBody(context, {
        target_thread_id: targetThreadId,
        ...(clear
          ? { clear: true }
          : {
              objective,
              ...(status ? { status: status.toLowerCase() } : {}),
            }),
      }),
    });
    writeJson(stdout, buildThreadGoalOutput(payload, targetThreadId));
    return 0;
  }

  if (command === "state") {
    const positional = removeFlags(rest, ["--limit", "--before-created-at", "--before-message-id"]);
    const childThreadId = normalizeText(positional[0]);
    if (!childThreadId) {
      throw new Error("thread id is required.");
    }
    const query = new URLSearchParams();
    appendParentQuery(query, context);
    query.set("child_thread_id", childThreadId);
    query.set("limit", readFlag(rest, "--limit", "50"));
    query.set("before_created_at", readFlag(rest, "--before-created-at"));
    query.set("before_message_id", readFlag(rest, "--before-message-id"));
    writeJson(
      stdout,
      await requestJson({
        context,
        fetchImpl,
        routeBase: "public",
        path: "/api/chat/runs/delegated-thread-state",
        query,
      }),
    );
    return 0;
  }

  throw new Error(`Unknown threads command: ${command}.`);
}

function decodeBase64Url(value) {
  return Buffer.from(normalizeText(value), "base64url");
}

function sanitizeFileName(value, fallback = "attachment") {
  const normalized = normalizeText(value || fallback)
    .replace(/[\\/]+/g, "-")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/^\.+$/, "")
    .slice(0, 180);
  return normalized || fallback;
}

function extensionForContentType(contentType) {
  const normalized = normalizeText(contentType).toLowerCase();
  if (normalized === "image/png") return ".png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return ".jpg";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/svg+xml") return ".svg";
  return "";
}

function ensureFileNameExtension(name, contentType) {
  const normalizedName = sanitizeFileName(name);
  if (path.extname(normalizedName)) {
    return normalizedName;
  }
  return `${normalizedName}${extensionForContentType(contentType)}`;
}

async function writeGitHubIssueAttachmentFiles({
  attachments,
  outputDir,
  cwd,
}) {
  const resolvedOutputDir = path.resolve(cwd, outputDir);
  await fs.mkdir(resolvedOutputDir, { recursive: true });
  const usedNames = new Set();
  const materialized = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index] || {};
    const baseName = ensureFileNameExtension(
      attachment.name || `github-issue-attachment-${index + 1}`,
      attachment.content_type || attachment.contentType,
    );
    let fileName = baseName;
    let duplicateIndex = 2;
    while (usedNames.has(fileName.toLowerCase())) {
      const extension = path.extname(baseName);
      const stem = extension ? baseName.slice(0, -extension.length) : baseName;
      fileName = `${stem}-${duplicateIndex}${extension}`;
      duplicateIndex += 1;
    }
    usedNames.add(fileName.toLowerCase());
    const filePath = path.join(resolvedOutputDir, fileName);
    await fs.writeFile(
      filePath,
      decodeBase64Url(
        attachment.file_contents_base64url || attachment.fileContentsBase64Url,
      ),
    );
    materialized.push({
      name: attachment.name || fileName,
      content_type: attachment.content_type || attachment.contentType || "",
      size_bytes: Number(attachment.size_bytes || attachment.sizeBytes || 0) || 0,
      source: attachment.source || {},
      path: filePath,
    });
  }
  return materialized;
}

async function handleAttachmentsCommand({ args, context, fetchImpl, stdout, cwd }) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "help") {
    printHelp(stdout);
    return 0;
  }
  if (command !== "get" && command !== "materialize") {
    throw new Error(`Unknown attachments command: ${command}.`);
  }
  const attachmentId = readFlag(rest, ["--attachment", "--attachment-id"]);
  const threadId = readFlag(rest, "--thread", context.threadId);
  if (!attachmentId) {
    throw new Error("--attachment is required.");
  }
  const query = new URLSearchParams({
    thread_id: threadId,
    attachment_id: attachmentId,
    include_contents: "1",
  });
  const payload = await requestJson({
    context,
    fetchImpl,
    routeBase: "worker",
    path: "/web-chat/attachments/get",
    query,
  });
  const attachment = payload.attachment || {};
  const outputPath = readFlag(rest, "--output");
  if (outputPath) {
    const resolvedOutputPath = path.resolve(cwd, outputPath);
    await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await fs.writeFile(
      resolvedOutputPath,
      decodeBase64Url(payload.file_contents_base64url || payload.fileContentsBase64Url),
    );
    writeJson(stdout, {
      ok: true,
      attachment,
      path: resolvedOutputPath,
    });
    return 0;
  }
  writeJson(stdout, {
    ok: true,
    attachment,
    file_contents_base64url:
      payload.file_contents_base64url || payload.fileContentsBase64Url || "",
  });
  return 0;
}

async function handleGitHubCommand({ args, context, fetchImpl, stdout, cwd }) {
  const [resource, command, ...rest] = args;
  if (!resource || resource === "--help" || resource === "help") {
    printHelp(stdout);
    return 0;
  }
  if (resource !== "issue") {
    throw new Error(`Unknown github resource: ${resource}.`);
  }
  if (!command || command === "--help" || command === "help") {
    printHelp(stdout);
    return 0;
  }
  if (command !== "attachments" && command !== "attachment") {
    throw new Error(`Unknown github issue command: ${command}.`);
  }

  const positional = removeFlags(
    rest,
    ["--repo", "--repository", "--output-dir", "--output"],
    ["--comments"],
  );
  const issueReference = normalizeText(positional[0]);
  const repository = readFlag(
    rest,
    ["--repo", "--repository"],
    context.workspaceRepository,
  );
  const outputDir = readFlag(rest, ["--output-dir", "--output"]);
  const includeComments = hasFlag(rest, ["--comments"]);
  if (!issueReference) {
    throw new Error("github issue attachments requires <url|number>.");
  }
  if (!outputDir) {
    throw new Error("github issue attachments requires --output-dir <dir>.");
  }

  const query = new URLSearchParams();
  appendParentQuery(query, context);
  query.set("issue", issueReference);
  query.set("repository", repository);
  query.set("comments", includeComments ? "1" : "");
  const payload = await requestJson({
    context,
    fetchImpl,
    routeBase: "public",
    path: "/api/chat/runs/github/issue-attachments",
    query,
  });
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const materialized = await writeGitHubIssueAttachmentFiles({
    attachments,
    outputDir,
    cwd,
  });
  writeJson(stdout, {
    ok: true,
    issue: payload.issue || {},
    attachments: materialized,
    skipped: Array.isArray(payload.skipped) ? payload.skipped : [],
    output_dir: path.resolve(cwd, outputDir),
  });
  return 0;
}

export async function handleRunnerCodeq8Cli({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdout = process.stdout,
  stderr = process.stderr,
  cwd = process.cwd(),
} = {}) {
  const args = Array.isArray(argv) ? argv.map((entry) => normalizeText(entry)).filter(Boolean) : [];
  if (args.length === 0 || hasFlag(args, ["--help", "-h"]) || args[0] === "help") {
    printHelp(stdout);
    return 0;
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is unavailable in this Node runtime.");
  }
  const context = buildContext(env);
  requireContext(context);

  const [group, ...rest] = args;
  if (group === "threads" || group === "thread" || group === "chat") {
    return await handleThreadsCommand({ args: rest, context, fetchImpl, stdout });
  }
  if (group === "attachments" || group === "attachment") {
    return await handleAttachmentsCommand({ args: rest, context, fetchImpl, stdout, cwd });
  }
  if (group === "github") {
    return await handleGitHubCommand({ args: rest, context, fetchImpl, stdout, cwd });
  }

  throw new Error(`Unknown codeq8 command group: ${group}.`);
}

const executedAsScript =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (executedAsScript) {
  try {
    process.exitCode = await handleRunnerCodeq8Cli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
