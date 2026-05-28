#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveCodePublicBaseUrl } from "../lib/code-app-origin.mjs";
import { normalizeBaseUrl } from "../lib/code-worker-url.mjs";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SOURCE_TYPE_VALUES = new Set(["default_branch", "pull_request", "branch"]);
const RUNNER_SCRIPT_PATH = fileURLToPath(new URL("./web-chat-runner.mjs", import.meta.url));

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizeRepository(value) {
  const normalized = normalizeText(value);
  return REPOSITORY_PATTERN.test(normalized) ? normalized : "";
}

function normalizeSourceType(value) {
  const normalized = normalizeText(value).toLowerCase();
  return SOURCE_TYPE_VALUES.has(normalized) ? normalized : "default_branch";
}

function stringifyJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export function buildGitHubActionsRunUrl(env = process.env) {
  const serverUrl = normalizeText(env.GITHUB_SERVER_URL || "").replace(/\/+$/, "");
  const repository = normalizeRepository(env.GITHUB_REPOSITORY || "");
  const runId = normalizeText(env.GITHUB_RUN_ID || "");
  if (!serverUrl || !repository || !runId) {
    return "";
  }
  const encodedRepository = repository
    .split("/")
    .map((entry) => encodeURIComponent(entry))
    .join("/");
  return `${serverUrl}/${encodedRepository}/actions/runs/${encodeURIComponent(runId)}`;
}

function parseJsonText(raw, label) {
  try {
    return JSON.parse(String(raw || ""));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to parse ${label}: ${reason}`);
  }
}

function resolveEventPayloadContainer(eventPayload) {
  const event = normalizeObject(eventPayload);
  const workflowDispatchInputs = normalizeObject(event.inputs);
  if (workflowDispatchInputs.run_payload_json) {
    return parseJsonText(workflowDispatchInputs.run_payload_json, "workflow_dispatch run payload");
  }

  const clientPayload = normalizeObject(event.client_payload);
  if (clientPayload.run_payload && typeof clientPayload.run_payload === "object") {
    return clientPayload.run_payload;
  }
  if (clientPayload.run_payload_json) {
    return parseJsonText(clientPayload.run_payload_json, "repository_dispatch run payload");
  }
  if (Object.keys(clientPayload).length > 0) {
    return clientPayload;
  }
  return {};
}

export async function readGitHubActionsChatRunPayload({
  env = process.env,
  eventPayload = null,
  readFileImpl = async (filePath) => fs.readFile(filePath, "utf8"),
} = {}) {
  const directPayloadJson =
    normalizeText(env.CODEQ8_CHAT_RUN_PAYLOAD_JSON || env.CODEQ8_CHAT_RUN_PAYLOAD || "");
  if (directPayloadJson) {
    return parseJsonText(directPayloadJson, "CODEQ8_CHAT_RUN_PAYLOAD_JSON");
  }

  const payloadFile = normalizeText(env.CODEQ8_CHAT_RUN_PAYLOAD_FILE || "");
  if (payloadFile) {
    const raw = await readFileImpl(payloadFile);
    return parseJsonText(raw, payloadFile);
  }

  if (eventPayload && typeof eventPayload === "object") {
    return resolveEventPayloadContainer(eventPayload);
  }

  const eventPath = normalizeText(env.GITHUB_EVENT_PATH || "");
  if (!eventPath) {
    return {};
  }
  const rawEvent = await readFileImpl(eventPath);
  return resolveEventPayloadContainer(parseJsonText(rawEvent, eventPath));
}

export function normalizeGitHubActionsChatRunPayload(value) {
  const normalized = normalizeObject(value);
  const branchContext = normalizeObject(
    normalized.branch_context || normalized.branchContext || {},
  );
  const attachments =
    Array.isArray(normalized.attachments) && normalized.attachments.length > 0
      ? normalized.attachments
      : [];
  const referencedThreads =
    Array.isArray(normalized.referenced_threads || normalized.referencedThreads) &&
    (normalized.referenced_threads || normalized.referencedThreads).length > 0
      ? normalized.referenced_threads || normalized.referencedThreads
      : [];

  return {
    run_id: normalizeText(normalized.run_id || normalized.runId),
    thread_id: normalizeText(normalized.thread_id || normalized.threadId),
    message_id: normalizeText(normalized.message_id || normalized.messageId),
    workspace_repository: normalizeRepository(
      normalized.workspace_repository ||
        normalized.workspaceRepository ||
        normalized.repository,
    ),
    thread_title: normalizeText(
      normalized.thread_title || normalized.threadTitle || normalized.title,
    ),
    source_type: normalizeSourceType(normalized.source_type || normalized.sourceType),
    github_login: normalizeText(normalized.github_login || normalized.githubLogin),
    web_chat_run_token: normalizeText(
      normalized.web_chat_run_token || normalized.webChatRunToken,
    ),
    public_base_url: normalizeText(
      normalized.public_base_url || normalized.publicBaseUrl,
    ),
    thread_spec: normalizeText(normalized.thread_spec || normalized.threadSpec),
    prompt_text: normalizeText(normalized.prompt_text || normalized.promptText),
    recent_user_messages_prompt_text: normalizeText(
      normalized.recent_user_messages_prompt_text ||
        normalized.recentUserMessagesPromptText,
    ),
    recent_checks_prompt_text: normalizeText(
      normalized.recent_checks_prompt_text || normalized.recentChecksPromptText,
    ),
    pull_request_head_repository: normalizeRepository(
      normalized.pull_request_head_repository ||
        normalized.pullRequestHeadRepository,
    ),
    attachments_json:
      normalizeText(normalized.attachments_json || normalized.attachmentsJson) ||
      stringifyJson(attachments),
    referenced_threads_json:
      normalizeText(
        normalized.referenced_threads_json || normalized.referencedThreadsJson,
      ) || stringifyJson(referencedThreads),
    workspace_path: normalizeText(
      normalized.workspace_path || normalized.workspacePath,
    ),
    worker_url: normalizeBaseUrl(normalized.worker_url || normalized.workerUrl),
    worker_canonical_url: normalizeBaseUrl(
      normalized.worker_canonical_url || normalized.workerCanonicalUrl,
    ),
    branch_context: {
      default_branch: normalizeText(
        branchContext.default_branch || branchContext.defaultBranch,
      ),
      protected_branches: Array.isArray(
        branchContext.protected_branches || branchContext.protectedBranches,
      )
        ? branchContext.protected_branches || branchContext.protectedBranches
        : [],
      production_branch: normalizeText(
        branchContext.production_branch || branchContext.productionBranch,
      ),
      context_branch: normalizeText(
        branchContext.context_branch || branchContext.contextBranch,
      ),
      write_mode: normalizeText(branchContext.write_mode || branchContext.writeMode),
      write_branch: normalizeText(
        branchContext.write_branch || branchContext.writeBranch,
      ),
      base_branch: normalizeText(branchContext.base_branch || branchContext.baseBranch),
      pull_request_number: parsePositiveInteger(
        branchContext.pull_request_number || branchContext.pullRequestNumber,
        0,
      ),
      pull_request_url: normalizeText(
        branchContext.pull_request_url || branchContext.pullRequestUrl,
      ),
      pull_request_base_branch: normalizeText(
        branchContext.pull_request_base_branch ||
          branchContext.pullRequestBaseBranch,
      ),
      pull_request_head_branch: normalizeText(
        branchContext.pull_request_head_branch ||
          branchContext.pullRequestHeadBranch,
      ),
    },
    control_plane_repository: normalizeRepository(
      normalized.control_plane_repository || normalized.controlPlaneRepository,
    ),
    control_plane_run_id: normalizeText(
      normalized.control_plane_run_id || normalized.controlPlaneRunId,
    ),
    control_plane_run_attempt: parsePositiveInteger(
      normalized.control_plane_run_attempt || normalized.controlPlaneRunAttempt,
      0,
    ),
    control_plane_workflow_name: normalizeText(
      normalized.control_plane_workflow_name ||
        normalized.controlPlaneWorkflowName,
    ),
    control_plane_job_id: normalizeText(
      normalized.control_plane_job_id || normalized.controlPlaneJobId,
    ),
    control_plane_url: normalizeText(
      normalized.control_plane_url || normalized.controlPlaneUrl,
    ),
  };
}

export function buildWebChatRunnerEnv({
  payload,
  env = process.env,
} = {}) {
  const normalizedPayload = normalizeGitHubActionsChatRunPayload(payload);
  if (
    !normalizedPayload.run_id ||
    !normalizedPayload.thread_id ||
    !normalizedPayload.message_id ||
    !normalizedPayload.workspace_repository ||
    !normalizedPayload.worker_url ||
    !normalizedPayload.prompt_text
  ) {
    throw new Error(
      "run_id, thread_id, message_id, workspace_repository, worker_url, and prompt_text are required.",
    );
  }

  const controlPlaneUrl =
    normalizedPayload.control_plane_url || buildGitHubActionsRunUrl(env);
  const workerUrl = normalizedPayload.worker_url;
  const canonicalWorkerUrl =
    normalizedPayload.worker_canonical_url || normalizedPayload.worker_url;
  const publicBaseUrl =
    normalizeText(normalizedPayload.public_base_url) || resolveCodePublicBaseUrl("", env);
  const nextEnv = {
    ...env,
    GITHUB_ACTIONS: "true",
    CODE_WORKER_URL: workerUrl,
    CODE_WORKER_CANONICAL_URL: canonicalWorkerUrl,
    CODE_PUBLIC_BASE_URL: publicBaseUrl,
    CODE_WORKSPACE_REPOSITORY: normalizedPayload.workspace_repository,
    CODE_WORKSPACE_PATH:
      normalizedPayload.workspace_path || normalizeText(env.GITHUB_WORKSPACE || ""),
    CODE_CHAT_THREAD_ID: normalizedPayload.thread_id,
    CODE_CHAT_THREAD_TITLE: normalizedPayload.thread_title,
    CODE_CHAT_MESSAGE_ID: normalizedPayload.message_id,
    CODE_CHAT_RUN_ID: normalizedPayload.run_id,
    CODE_CHAT_SOURCE_TYPE: normalizedPayload.source_type,
    CODE_CHAT_THREAD_SPEC_TEXT: normalizedPayload.thread_spec,
    CODE_CHAT_GITHUB_LOGIN: normalizedPayload.github_login,
    CODE_CHAT_PROMPT_TEXT: normalizedPayload.prompt_text,
    CODE_CHAT_RECENT_USER_MESSAGES_PROMPT_TEXT:
      normalizedPayload.recent_user_messages_prompt_text,
    CODE_CHAT_RECENT_CHECKS_PROMPT_TEXT:
      normalizedPayload.recent_checks_prompt_text,
    CODE_CHAT_REFERENCED_THREADS_JSON:
      normalizedPayload.referenced_threads_json,
    CODE_CHAT_DEFAULT_BRANCH: normalizedPayload.branch_context.default_branch,
    CODE_CHAT_PROTECTED_BRANCHES: stringifyJson(
      normalizedPayload.branch_context.protected_branches,
    ),
    CODE_CHAT_PRODUCTION_BRANCH:
      normalizedPayload.branch_context.production_branch,
    CODE_CHAT_CONTEXT_BRANCH: normalizedPayload.branch_context.context_branch,
    CODE_CHAT_WRITE_MODE: normalizedPayload.branch_context.write_mode,
    CODE_CHAT_WRITE_BRANCH: normalizedPayload.branch_context.write_branch,
    CODE_CHAT_BASE_BRANCH: normalizedPayload.branch_context.base_branch,
    CODE_CHAT_PULL_REQUEST_NUMBER: normalizedPayload.branch_context.pull_request_number
      ? String(normalizedPayload.branch_context.pull_request_number)
      : "",
    CODE_CHAT_PULL_REQUEST_URL: normalizedPayload.branch_context.pull_request_url,
    CODE_CHAT_PULL_REQUEST_BASE_BRANCH:
      normalizedPayload.branch_context.pull_request_base_branch,
    CODE_CHAT_PULL_REQUEST_HEAD_BRANCH:
      normalizedPayload.branch_context.pull_request_head_branch,
    CODE_CHAT_PULL_REQUEST_HEAD_REPOSITORY:
      normalizedPayload.pull_request_head_repository,
    CODE_CHAT_ATTACHMENTS_JSON: normalizedPayload.attachments_json,
    CODE_WEB_CHAT_RUN_TOKEN: normalizedPayload.web_chat_run_token,
    CODEX_GH_TOKEN: normalizeText(env.CODEX_GH_TOKEN || ""),
    CODEQ8_EXECUTION_BACKEND: "github_actions",
    CODEQ8_CONTROL_PLANE_REPOSITORY:
      normalizedPayload.control_plane_repository ||
      normalizeRepository(env.GITHUB_REPOSITORY || ""),
    CODEQ8_CONTROL_PLANE_RUN_ID:
      normalizedPayload.control_plane_run_id || normalizeText(env.GITHUB_RUN_ID || ""),
    CODEQ8_CONTROL_PLANE_RUN_ATTEMPT:
      String(
        normalizedPayload.control_plane_run_attempt ||
          parsePositiveInteger(env.GITHUB_RUN_ATTEMPT || "", 0),
      ),
    CODEQ8_CONTROL_PLANE_WORKFLOW_NAME:
      normalizedPayload.control_plane_workflow_name ||
      normalizeText(env.GITHUB_WORKFLOW || ""),
    CODEQ8_CONTROL_PLANE_JOB_ID:
      normalizedPayload.control_plane_job_id || normalizeText(env.GITHUB_JOB || ""),
    CODEQ8_CONTROL_PLANE_URL: controlPlaneUrl,
  };

  for (const [key, value] of Object.entries(nextEnv)) {
    if (!normalizeText(value)) {
      delete nextEnv[key];
    }
  }
  return nextEnv;
}

async function spawnRunner({ env = process.env, spawnImpl = spawn } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [RUNNER_SCRIPT_PATH], {
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`web chat runner exited from signal ${signal}`));
        return;
      }
      resolve(Number.isFinite(code) ? code : 1);
    });
  }).then((code) => {
    process.exitCode = Number(code || 0);
  });
}

async function main() {
  const payload = await readGitHubActionsChatRunPayload();
  const runnerEnv = buildWebChatRunnerEnv({ payload });
  await spawnRunner({ env: runnerEnv });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
