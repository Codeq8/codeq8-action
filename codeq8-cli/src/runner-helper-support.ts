// @ts-nocheck

import process from "node:process";

const DEFAULT_CODE_PUBLIC_URL = "https://codeq8.com";
const DEFAULT_CODE_WORKER_URL = "https://control.codeq8.com";

export function normalizeText(value) {
  return String(value || "").trim();
}

export function normalizeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeBaseUrl(value, fallback = "") {
  const normalized = normalizeText(value || fallback).replace(/\/+$/, "");
  return normalized;
}

export function readFlag(args, names, fallback = "") {
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

export function hasFlag(args, names) {
  const aliases = Array.isArray(names) ? names : [names];
  return args.some((arg) => aliases.includes(arg));
}

export function removeFlags(args, flagNamesWithValues = [], booleanFlagNames = []) {
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

export function buildContext(env = process.env) {
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

export function requireContext(context) {
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

export function buildHeaders(context, extra = {}) {
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

export function appendParentQuery(searchParams, context) {
  searchParams.set("workspace_repository", context.workspaceRepository);
  searchParams.set("thread_id", context.threadId);
  searchParams.set("run_id", context.runId);
}

export function parentBody(context, extra = {}) {
  return {
    workspace_repository: context.workspaceRepository,
    thread_id: context.threadId,
    run_id: context.runId,
    ...extra,
  };
}

export async function requestJson({
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

export function payloadObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function payloadArray(value) {
  return Array.isArray(value) ? value : [];
}

export function firstText(...values) {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

export function firstPositiveNumber(...values) {
  for (const value of values) {
    const normalized = normalizeNumber(value, 0);
    if (normalized > 0) {
      return normalized;
    }
  }
  return 0;
}

export function normalizeEpochMs(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function formatTimestamp(value) {
  const epochMs = normalizeEpochMs(value);
  return epochMs > 0 ? new Date(epochMs).toISOString() : "";
}

export function formatThreadTarget(thread) {
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

export function formatThreadRunStatus(thread) {
  return (
    normalizeText(thread.latest_run_status || thread.latestRunStatus) ||
    normalizeText(payloadObject(thread.latest_run || thread.latestRun).status) ||
    normalizeText(payloadObject(thread.run || {}).status)
  );
}

export function formatThreadUpdatedAt(thread) {
  return formatTimestamp(
    thread.updated_at ||
      thread.updatedAt ||
      thread.last_message_at ||
      thread.lastMessageAt ||
      thread.created_at ||
      thread.createdAt,
  );
}

export function readThreadParentThreadId(thread) {
  return firstText(thread.parent_thread_id, thread.parentThreadId);
}

export function formatThreadRelation(thread) {
  const parentThreadId = readThreadParentThreadId(thread);
  return parentThreadId ? `child-of:${parentThreadId}` : "top-level";
}

export function writeCompactThreadList(
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

export function truncateText(value, maxLength = 240) {
  const normalized = redactSensitiveText(normalizeText(value).replace(/\s+/g, " "));
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function isSensitiveOutputKey(key) {
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

export function redactSensitiveText(value) {
  return normalizeText(value)
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /\b(thread_stream_token|thread_record_handoff|run_record_handoff|repository_access_handoff|codex_session_state|github_web_session_cookie|session_id|session_file_relative_path|session_bundle_key|bundle_storage_key|authorization|cookie|credential|handoff|token|secret|password|api_key|private_key)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[redacted]",
    );
}

export function sanitizeForOutput(value) {
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

export function writeJson(stdout, payload) {
  stdout.write(`${JSON.stringify(sanitizeForOutput(payload), null, 2)}\n`);
}

export function compactObject(entries) {
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

export function summarizeThreadForOutput(thread, payload = {}) {
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
    title_source: firstText(normalized.title_source, normalized.titleSource),
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

export function summarizeRunForOutput(run) {
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

export function summarizeMessageForOutput(message) {
  const summary = summarizeThreadMessage(message);
  return sanitizeForOutput(compactObject(summary));
}

export function summarizeGoalForOutput(goal) {
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

export function parentSummaryFields(payload) {
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

export function readThreadOutputId(payload, fallback = "") {
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

export function readDelegatedDispatchState(payload) {
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

export function buildDelegatedThreadCreateOutput(payload) {
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

export function buildDelegatedThreadMessageOutput(payload, fallbackThreadId) {
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

export function buildAssignedThreadOutput(payload, fallbackThreadId) {
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

export function buildThreadGoalOutput(payload, fallbackThreadId) {
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

export function buildThreadTitleOutput(payload, fallbackThreadId, fallbackTitle) {
  const thread = payloadObject(payload.thread);
  return compactObject({
    ok: Boolean(payload.ok),
    titled: payload.titled !== false,
    updated: payload.updated !== false,
    target_thread_id: readThreadOutputId(payload, fallbackThreadId),
    ...parentSummaryFields(payload),
    title: firstText(payload.title, thread.title, fallbackTitle),
    title_source: firstText(payload.title_source, payload.titleSource, thread.title_source, thread.titleSource),
    thread: summarizeThreadForOutput(thread, payload),
    error: firstText(payload.error),
  });
}

export function readThreadBranchContext(thread) {
  return payloadObject(thread.branch_context || thread.branchContext);
}

export function readThreadGitHubContext(thread) {
  return payloadObject(thread.github_context || thread.githubContext);
}

export function readThreadPullRequest(thread) {
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

export function readThreadRepository(thread, payload) {
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

export function summarizeThreadMessage(message) {
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

export function readProgressCandidate(value) {
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

export function readThreadProgressFacts(payload, thread) {
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

