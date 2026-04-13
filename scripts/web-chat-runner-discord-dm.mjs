#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  WEB_CHAT_RUNNER_DISCORD_DM_LIST_PATH,
  WEB_CHAT_RUNNER_DISCORD_DM_SEND_PATH,
  webChatRunnerDiscordDmListResponseSchema,
  webChatRunnerDiscordDmSendResponseSchema,
} from "../lib/web-chat-runner-runtime-contract.mjs";

function normalizeText(value) {
  return String(value || "").trim();
}

function print(message = "") {
  process.stdout.write(`${message}\n`);
}

function printError(message) {
  process.stderr.write(`codeq8-discord-dm: ${message}\n`);
}

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(normalizeText(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function consumeOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) {
    return { value: "", args };
  }
  if (index + 1 >= args.length) {
    throw new Error(`${name} requires a value.`);
  }
  return {
    value: normalizeText(args[index + 1]),
    args: args.slice(0, index).concat(args.slice(index + 2)),
  };
}

function consumeAllOptions(args, name) {
  let nextArgs = args.slice();
  let value = "";
  while (nextArgs.includes(name)) {
    const consumed = consumeOption(nextArgs, name);
    value = consumed.value;
    nextArgs = consumed.args;
  }
  return { value, args: nextArgs };
}

function consumeAllOptionsByNames(args, names) {
  let nextArgs = args.slice();
  let value = "";
  for (const name of names) {
    const consumed = consumeAllOptions(nextArgs, name);
    if (consumed.value) {
      value = consumed.value;
    }
    nextArgs = consumed.args;
  }
  return { value, args: nextArgs };
}

function parseFlag(args, names) {
  return args.some((arg) => names.includes(arg));
}

async function readStdinText() {
  if (process.stdin.isTTY) {
    return "";
  }
  return await new Promise((resolve, reject) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
    });
    process.stdin.on("end", () => {
      resolve(buffer);
    });
    process.stdin.on("error", reject);
  });
}

function resolveRuntimeBaseUrl(env = process.env) {
  return normalizeText(env.CODE_PUBLIC_BASE_URL || env.CODEQ8_BASE_URL || "https://codeq8.com");
}

function resolveRuntimeRunToken(env = process.env) {
  return normalizeText(env.CODE_WEB_CHAT_RUN_TOKEN);
}

function resolveRuntimeRequestContext(env = process.env) {
  return {
    workspaceRepository: normalizeText(env.CODE_WORKSPACE_REPOSITORY),
    threadId: normalizeText(env.CODE_CHAT_THREAD_ID),
    runId: normalizeText(env.CODE_CHAT_RUN_ID),
  };
}

function extractErrorMessage(payload, fallback = "") {
  if (payload instanceof Error) {
    return extractErrorMessage(payload.message, fallback);
  }
  if (
    typeof payload === "string" ||
    typeof payload === "number" ||
    typeof payload === "boolean" ||
    typeof payload === "bigint"
  ) {
    return normalizeText(payload);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return normalizeText(fallback);
  }
  for (const candidate of [
    payload.error,
    payload.message,
    payload.reason,
    payload.detail,
    payload.details,
    payload.cause,
  ]) {
    const extracted = extractErrorMessage(candidate, "");
    if (extracted) {
      return extracted;
    }
  }
  return normalizeText(fallback);
}

async function requestRunnerDiscordDmJson({
  path,
  body,
  responseSchema,
  fetchImpl = globalThis.fetch,
  env = process.env,
}) {
  const baseUrl = resolveRuntimeBaseUrl(env).replace(/\/+$/, "");
  const runToken = resolveRuntimeRunToken(env);
  const { workspaceRepository, threadId, runId } = resolveRuntimeRequestContext(env);
  if (!baseUrl || !runToken || !workspaceRepository || !threadId || !runId) {
    throw new Error(
      "CODE_PUBLIC_BASE_URL, CODE_WEB_CHAT_RUN_TOKEN, CODE_WORKSPACE_REPOSITORY, CODE_CHAT_THREAD_ID, and CODE_CHAT_RUN_ID are required.",
    );
  }

  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      workspace_repository: workspaceRepository,
      thread_id: threadId,
      run_id: runId,
      ...body,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      extractErrorMessage(payload, `Discord DM runner request failed (${response.status}).`),
    );
  }
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Discord DM runner returned an invalid payload.");
  }
  return parsed.data;
}

export async function listRunnerDiscordDmMessages(
  {
    limit = 20,
    beforeCreatedAt = 0,
    beforeEventId = "",
  } = {},
  dependencyOverrides = {},
) {
  return await requestRunnerDiscordDmJson({
    path: WEB_CHAT_RUNNER_DISCORD_DM_LIST_PATH,
    body: {
      limit: parsePositiveInteger(limit, 20),
      before_created_at: Math.max(0, parsePositiveInteger(beforeCreatedAt, 0)),
      before_event_id: normalizeText(beforeEventId),
    },
    responseSchema: webChatRunnerDiscordDmListResponseSchema,
    ...dependencyOverrides,
  });
}

export async function sendRunnerDiscordDmMessage(
  {
    content = "",
  } = {},
  dependencyOverrides = {},
) {
  const normalizedContent = normalizeText(content);
  if (!normalizedContent) {
    throw new Error("discord dm send requires message content.");
  }
  return await requestRunnerDiscordDmJson({
    path: WEB_CHAT_RUNNER_DISCORD_DM_SEND_PATH,
    body: {
      content: normalizedContent,
    },
    responseSchema: webChatRunnerDiscordDmSendResponseSchema,
    ...dependencyOverrides,
  });
}

function formatMessageContent(message) {
  return (
    normalizeText(message.transcript_text) ||
    normalizeText(message.content_text) ||
    "(empty message)"
  );
}

function printDiscordDmListText(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (messages.length === 0) {
    print("No Discord DM messages found.");
    return;
  }

  for (const message of messages) {
    const createdAt = Number.isFinite(message.created_at)
      ? new Date(message.created_at).toISOString()
      : "";
    const label =
      normalizeText(message.event_kind).toLowerCase() === "discord_voice_memo"
        ? "voice"
        : "text";
    print(`[${label}] ${createdAt} ${formatMessageContent(message)}`.trim());
  }

  if (payload.has_more) {
    print("");
    print(`next_before_created_at=${payload.next_before_created_at || 0}`);
    print(`next_before_event_id=${normalizeText(payload.next_before_event_id)}`);
  }
}

function printDiscordDmSendText(payload) {
  if (payload.skipped) {
    print(`Skipped Discord DM send: ${normalizeText(payload.reason) || "no reason provided"}.`);
    return;
  }
  print(`Sent Discord DM${payload.message_id ? ` ${payload.message_id}` : ""}.`);
  if (!payload.recorded) {
    print("Warning: the DM was sent but not recorded in the Discord DM conversation history.");
  }
}

function renderHelp() {
  return [
    "Codeq8 runner Discord DM helper",
    "",
    "Usage:",
    "  codeq8-discord-dm list [--limit <n>] [--before-created-at <ms>] [--before-event-id <id>] [--json]",
    "  codeq8-discord-dm send [--content <text>] [--json]",
  ].join("\n");
}

export async function handleRunnerDiscordDmCli(args = process.argv.slice(2), dependencyOverrides = {}) {
  const [subcommand = "", ...rest] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    print(renderHelp());
    return 0;
  }

  if (subcommand === "list") {
    let options = rest.slice();
    const limitConsumed = consumeAllOptions(options, "--limit");
    options = limitConsumed.args;
    const beforeCreatedAtConsumed = consumeAllOptions(options, "--before-created-at");
    options = beforeCreatedAtConsumed.args;
    const beforeEventIdConsumed = consumeAllOptions(options, "--before-event-id");
    options = beforeEventIdConsumed.args;
    const json = parseFlag(options, ["--json"]);
    options = options.filter((arg) => arg !== "--json");
    if (options.length > 0) {
      throw new Error(`Unknown discord dm list option: ${options[0]}`);
    }
    const payload = await listRunnerDiscordDmMessages(
      {
        limit: limitConsumed.value,
        beforeCreatedAt: beforeCreatedAtConsumed.value,
        beforeEventId: beforeEventIdConsumed.value,
      },
      dependencyOverrides,
    );
    if (json) {
      print(JSON.stringify(payload, null, 2));
      return 0;
    }
    printDiscordDmListText(payload);
    return 0;
  }

  if (subcommand === "send") {
    let options = rest.slice();
    const contentConsumed = consumeAllOptionsByNames(options, ["--content", "--message"]);
    options = contentConsumed.args;
    const json = parseFlag(options, ["--json"]);
    options = options.filter((arg) => arg !== "--json");
    const positionalContent = normalizeText(options.join(" "));
    const stdinContent =
      normalizeText(contentConsumed.value) || positionalContent ? "" : normalizeText(await readStdinText());
    const content = normalizeText(contentConsumed.value) || positionalContent || stdinContent;
    const unknownOption = options.find((entry) => entry.startsWith("-"));
    if (unknownOption) {
      throw new Error(`Unknown discord dm send option: ${unknownOption}`);
    }
    const payload = await sendRunnerDiscordDmMessage({ content }, dependencyOverrides);
    if (json) {
      print(JSON.stringify(payload, null, 2));
      return 0;
    }
    printDiscordDmSendText(payload);
    return 0;
  }

  throw new Error(`Unknown discord dm subcommand: ${subcommand}`);
}

const executedAsScript =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (executedAsScript) {
  try {
    const exitCode = await handleRunnerDiscordDmCli();
    process.exitCode = exitCode;
  } catch (error) {
    printError(extractErrorMessage(error, "Unknown error."));
    process.exitCode = 1;
  }
}
