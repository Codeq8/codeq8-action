#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  appendParentQuery,
  buildAssignedThreadOutput,
  buildContext,
  buildDelegatedThreadCreateOutput,
  buildDelegatedThreadMessageOutput,
  buildThreadGoalOutput,
  buildThreadTitleOutput,
  firstText,
  formatTimestamp,
  formatThreadRunStatus,
  formatThreadTarget,
  hasFlag,
  normalizeEpochMs,
  normalizeInteger,
  normalizeText,
  parentBody,
  payloadArray,
  payloadObject,
  readFlag,
  requireContext,
  readThreadBranchContext,
  readThreadProgressFacts,
  readThreadPullRequest,
  readThreadRepository,
  removeFlags,
  requestJson,
  summarizeThreadMessage,
  truncateText,
  writeCompactThreadList,
  writeJson,
} from "./runner-helper-support.js";
import type { FileCommandOptions, JsonRecord, RunnerCliOptions, StdoutLike, ThreadCommandOptions } from "./runner-helper-support.js";

function buildThreadInspectSnapshot(payload: JsonRecord): JsonRecord {
  const thread = payloadObject(payload.thread);
  const branchContext = readThreadBranchContext(thread);
  const pullRequest = readThreadPullRequest(thread);
  const progress = readThreadProgressFacts(payload, thread);
  const targetThreadId = firstText(
    payload.target_thread_id,
    payload.thread_id,
    thread.thread_id,
    thread.threadId,
  );
  const runnerParentThreadId = firstText(
    payload.runner_parent_thread_id,
    payload.runnerParentThreadId,
  );
  const runnerParentRunId = firstText(
    payload.runner_parent_run_id,
    payload.runnerParentRunId,
  );
  const runnerParentRepository = firstText(
    payload.runner_parent_workspace_repository,
    payload.runnerParentWorkspaceRepository,
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
    target_thread_id: targetThreadId,
    thread: {
      thread_id: targetThreadId,
      repository: readThreadRepository(thread, payload),
      title: truncateText(thread.title || "(untitled)", 160),
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

function writeThreadInspect(stdout: StdoutLike, snapshot: JsonRecord): void {
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
    for (const entry of recentMessages) {
      const message = payloadObject(entry);
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

function writeDelegatedThreadCreate(stdout: StdoutLike, snapshot: JsonRecord): void {
  const thread = payloadObject(snapshot.thread);
  const run = payloadObject(snapshot.run);
  const message = payloadObject(snapshot.message);
  const threadId = snapshot.target_thread_id || thread.thread_id || "(unknown)";
  const statusLine = [
    thread.status ? `status=${thread.status}` : "",
    run.status ? `run=${run.status}` : "",
    snapshot.dispatch_state ? `dispatch=${snapshot.dispatch_state}` : "",
  ].filter(Boolean).join(" ");

  stdout.write(`Created thread: ${threadId}\n`);
  stdout.write(`Title: ${thread.title || "(untitled)"}\n`);
  stdout.write(`Repository: ${thread.repository || snapshot.runner_parent_workspace_repository || "(unknown)"}\n`);
  stdout.write(`State: ${statusLine || "(unknown)"}\n`);
  if (snapshot.runner_parent_thread_id || snapshot.runner_parent_run_id) {
    stdout.write(
      `Runner: ${[snapshot.runner_parent_thread_id, snapshot.runner_parent_run_id ? `run=${snapshot.runner_parent_run_id}` : ""]
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

function printHelp(stdout: StdoutLike): void {
  stdout.write(
    [
      "Codeq8 runner helper",
      "",
      "Usage:",
      "  codeq8 threads mine [--status active|all] [--limit 25]",
      "  codeq8 threads search [--search text] [--status active|all] [--limit 25]",
      "  codeq8 threads context <thread-id> [--limit 20]",
      "  codeq8 threads inspect <thread-id> [--limit 12] [--json]",
      "  codeq8 threads assign <thread-id> [--assigned-to me]",
      "  codeq8 threads create --title title --message text [--assigned-to codeq8|me] [--json]",
      "  codeq8 threads message <thread-id> --text text",
      "  codeq8 threads title <thread-id> --title text",
      "  codeq8 threads archive <thread-id>  (alias: close)",
      "  codeq8 threads reopen <thread-id>",
      "  codeq8 threads goal <thread-id> --objective text [--status active|paused]",
      "  codeq8 threads goal <thread-id> --clear",
      "  codeq8 threads state <thread-id> [--limit 50]",
      "  codeq8 attachments get --attachment <attachment-id> [--thread <thread-id>] [--output file]",
      "  codeq8 github issue attachments <url|number> [--repo owner/repo] [--comments] --output-dir dir",
      "",
      "Authentication is read from the Codeq8 runner environment. Tokens are never printed.",
      "",
    ].join("\n"),
  );
}

async function handleThreadsCommand({
  args,
  context,
  fetchImpl,
  stdout,
}: ThreadCommandOptions): Promise<number> {
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
    const targetThreadId = normalizeText(positional[0]);
    if (!targetThreadId) {
      throw new Error("thread id is required.");
    }
    const query = new URLSearchParams();
    appendParentQuery(query, context);
    query.set("target_thread_id", targetThreadId);
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
    const targetThreadId = normalizeText(positional[0]);
    const content = readFlag(rest, ["--text", "--message"]);
    if (!targetThreadId) {
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
        target_thread_id: targetThreadId,
        content,
        role: "user",
      }),
    });
    writeJson(stdout, buildDelegatedThreadMessageOutput(payload, targetThreadId));
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

  if (command === "title" || command === "set-title" || command === "rename") {
    const positional = removeFlags(rest, ["--title", "--name"], ["--json"]);
    const targetThreadId = normalizeText(positional[0]);
    const title = readFlag(rest, ["--title", "--name"]);
    if (!targetThreadId) {
      throw new Error("thread id is required.");
    }
    if (!title) {
      throw new Error("--title is required.");
    }
    const payload = await requestJson({
      context,
      fetchImpl,
      routeBase: "public",
      path: "/api/chat/runs/thread-title",
      method: "POST",
      body: parentBody(context, {
        target_thread_id: targetThreadId,
        title,
      }),
    });
    writeJson(stdout, buildThreadTitleOutput(payload, targetThreadId, title));
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
    const targetThreadId = normalizeText(positional[0]);
    if (!targetThreadId) {
      throw new Error("thread id is required.");
    }
    const query = new URLSearchParams();
    appendParentQuery(query, context);
    query.set("target_thread_id", targetThreadId);
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

function decodeBase64Url(value: unknown): Buffer {
  return Buffer.from(normalizeText(value), "base64url");
}

function sanitizeFileName(value: unknown, fallback = "attachment"): string {
  const normalized = normalizeText(value || fallback)
    .replace(/[\\/]+/g, "-")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/^\.+$/, "")
    .slice(0, 180);
  return normalized || fallback;
}

function extensionForContentType(contentType: unknown): string {
  const normalized = normalizeText(contentType).toLowerCase();
  if (normalized === "image/png") return ".png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return ".jpg";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/svg+xml") return ".svg";
  return "";
}

function ensureFileNameExtension(name: unknown, contentType: unknown): string {
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
}: {
  attachments: JsonRecord[];
  outputDir: string;
  cwd: string;
}): Promise<JsonRecord[]> {
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

async function handleAttachmentsCommand({
  args,
  context,
  fetchImpl,
  stdout,
  cwd,
}: FileCommandOptions): Promise<number> {
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

async function handleGitHubCommand({
  args,
  context,
  fetchImpl,
  stdout,
  cwd,
}: FileCommandOptions): Promise<number> {
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
  cwd = process.cwd(),
}: RunnerCliOptions = {}): Promise<number> {
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
