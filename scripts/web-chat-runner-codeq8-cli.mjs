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

function writeJson(stdout, payload) {
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printHelp(stdout) {
  stdout.write(
    [
      "Codeq8 runner helper",
      "",
      "Usage:",
      "  codeq8 threads search [--search text] [--status active|all] [--limit 25]",
      "  codeq8 threads context <thread-id> [--limit 20]",
      "  codeq8 threads assign <thread-id> [--assigned-to me]",
      "  codeq8 threads create --title title --message text [--assigned-to codeq8|me]",
      "  codeq8 threads message <thread-id> --text text",
      "  codeq8 threads state <thread-id> [--limit 50]",
      "  codeq8 attachments get --attachment <attachment-id> [--thread <thread-id>] [--output file]",
      "  codeq8 github issue attachments <url|number> [--repo owner/repo] [--comments] --output-dir dir",
      "",
      "Authentication is read from the Codeq8 runner environment. Tokens are never printed.",
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

  if (command === "assign") {
    const positional = removeFlags(rest, ["--assigned-to"]);
    const assignedThreadId = normalizeText(positional[0]);
    if (!assignedThreadId) {
      throw new Error("thread id is required.");
    }
    writeJson(
      stdout,
      await requestJson({
        context,
        fetchImpl,
        routeBase: "public",
        path: "/api/chat/runs/assigned-thread",
        method: "POST",
        body: parentBody(context, {
          assigned_thread_id: assignedThreadId,
          assigned_to_github_login: readFlag(rest, "--assigned-to", "me"),
        }),
      }),
    );
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
    writeJson(
      stdout,
      await requestJson({
        context,
        fetchImpl,
        routeBase: "public",
        path: "/api/chat/runs/delegated-threads",
        method: "POST",
        body,
      }),
    );
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
    writeJson(
      stdout,
      await requestJson({
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
      }),
    );
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
