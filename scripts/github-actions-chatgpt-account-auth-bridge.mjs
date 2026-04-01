#!/usr/bin/env node

import fs from "node:fs/promises";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { normalizeRepository } from "../lib/github-actions-control-plane.js";
import { DEFAULT_CODE_WORKER_BASE_URL, resolveWorkerBaseUrl } from "../lib/code-worker-url.mjs";

const RUNNER_SCRIPT_PATH = fileURLToPath(
  new URL("./web-chat-account-auth-runner.mjs", import.meta.url),
);

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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
    return parseJsonText(workflowDispatchInputs.run_payload_json, "workflow_dispatch auth payload");
  }
  const clientPayload = normalizeObject(event.client_payload);
  if (clientPayload.run_payload_json) {
    return parseJsonText(clientPayload.run_payload_json, "repository_dispatch auth payload");
  }
  return clientPayload;
}

export async function readGitHubActionsChatGptAuthPayload({
  env = process.env,
  eventPayload = null,
  readFileImpl = async (filePath) => fs.readFile(filePath, "utf8"),
} = {}) {
  const directPayloadJson = normalizeText(
    env.CODEQ8_CHATGPT_AUTH_PAYLOAD_JSON || env.CODEQ8_CHATGPT_AUTH_PAYLOAD || "",
  );
  if (directPayloadJson) {
    return parseJsonText(directPayloadJson, "CODEQ8_CHATGPT_AUTH_PAYLOAD_JSON");
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

export function normalizeGitHubActionsChatGptAuthPayload(value) {
  const normalized = normalizeObject(value);
  return {
    auth_session_id: normalizeText(
      normalized.auth_session_id || normalized.authSessionId,
    ),
    auth_session_token: normalizeText(
      normalized.auth_session_token || normalized.authSessionToken,
    ),
    owner_github_login: normalizeText(
      normalized.owner_github_login || normalized.ownerGithubLogin,
    ),
    workspace_repository: normalizeRepository(
      normalized.workspace_repository || normalized.workspaceRepository,
    ),
    control_plane_repository: normalizeRepository(
      normalized.control_plane_repository || normalized.controlPlaneRepository,
    ),
  };
}

export function buildChatGptAuthRunnerEnv({
  payload,
  env = process.env,
} = {}) {
  const normalizedPayload = normalizeGitHubActionsChatGptAuthPayload(payload);
  if (
    !normalizedPayload.auth_session_id ||
    !normalizedPayload.auth_session_token ||
    !normalizedPayload.owner_github_login ||
    !normalizedPayload.workspace_repository
  ) {
    throw new Error(
      "auth_session_id, auth_session_token, owner_github_login, and workspace_repository are required.",
    );
  }

  const accountWorkerUrl = resolveWorkerBaseUrl(env, DEFAULT_CODE_WORKER_BASE_URL);
  if (!accountWorkerUrl) {
    throw new Error("CODE_WORKER_URL is required.");
  }

  return {
    ...env,
    CODE_WORKER_URL: accountWorkerUrl,
    CODE_WORKER_CANONICAL_URL: accountWorkerUrl,
    CODE_WORKSPACE_REPOSITORY: normalizedPayload.workspace_repository,
    CODE_CHATGPT_AUTH_SESSION_ID: normalizedPayload.auth_session_id,
    CODE_CHATGPT_AUTH_SESSION_TOKEN: normalizedPayload.auth_session_token,
    CODE_CHATGPT_AUTH_SESSION_OWNER_GITHUB_LOGIN: normalizedPayload.owner_github_login,
    CODE_CONTROL_PLANE_REPOSITORY:
      normalizedPayload.control_plane_repository ||
      normalizeRepository(env.GITHUB_REPOSITORY || ""),
    CODEQ8_EXECUTION_BACKEND: "github_actions",
    CODEQ8_CONTROL_PLANE_RUN_ID: normalizeText(env.GITHUB_RUN_ID || ""),
    CODEQ8_CONTROL_PLANE_URL: buildGitHubActionsRunUrl(env),
  };
}

async function main() {
  const payload = await readGitHubActionsChatGptAuthPayload();
  const runnerEnv = buildChatGptAuthRunnerEnv({ payload });

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER_SCRIPT_PATH], {
      stdio: "inherit",
      env: runnerEnv,
      cwd: process.cwd(),
    });
    child.on("close", (code) => {
      if (Number(code || 0) === 0) {
        resolve(undefined);
        return;
      }
      reject(
        new Error(
          `ChatGPT auth runner exited with code ${Number.isFinite(code) ? Number(code) : -1}.`,
        ),
      );
    });
    child.on("error", reject);
  });
}

const executedAsScript =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (executedAsScript) {
  await main();
}
