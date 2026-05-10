#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const CODEQ8_MAIN_STAGING_BASE_URL = "https://codeq8-git-main-iscoot.vercel.app";
export const CODEQ8_PRODUCTION_BASE_URL = "https://codeq8.com";

const NON_EMPTY_TEXT = /\S/;

function text(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function numberText(value) {
  const valueText = text(value);
  if (!valueText) {
    return "";
  }
  const parsed = Number(valueText);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return "";
  }
  return String(parsed);
}

function optionalText(value) {
  const valueText = text(value);
  return NON_EMPTY_TEXT.test(valueText) ? valueText : null;
}

export function resolveCodeq8PrWakeupBaseUrl({ repository, refName } = {}) {
  if (text(repository) === "Codeq8/Codeq8" && text(refName) !== "production") {
    return CODEQ8_MAIN_STAGING_BASE_URL;
  }

  return CODEQ8_PRODUCTION_BASE_URL;
}

function workflowDispatchInputs(env) {
  return {
    pullRequestNumber: numberText(env.CODEQ8_WAKEUP_PULL_REQUEST_NUMBER),
    headSha: optionalText(env.CODEQ8_WAKEUP_HEAD_SHA),
    conclusion: optionalText(env.CODEQ8_WAKEUP_CONCLUSION),
  };
}

export function buildCodeq8PrWakeupPayload({ env = process.env, eventPayload = {} } = {}) {
  const repository = text(env.GITHUB_REPOSITORY || eventPayload.repository?.full_name);
  const eventName = text(env.GITHUB_EVENT_NAME);
  const runId = numberText(env.GITHUB_RUN_ID);
  const runAttemptText = numberText(env.GITHUB_RUN_ATTEMPT);
  const runAttempt = runAttemptText ? Number(runAttemptText) : 0;
  const manualInputs = workflowDispatchInputs(env);

  let pullRequestNumber = manualInputs.pullRequestNumber;
  let headSha = manualInputs.headSha;
  let conclusion = manualInputs.conclusion;
  let eventKind = eventName || "workflow_dispatch";
  let workflowRunId = runId;
  let workflowRunAttempt = runAttempt;

  if (eventName === "workflow_run") {
    const workflowRun = eventPayload.workflow_run || {};
    const workflowRunPullRequest = workflowRun.pull_requests?.[0] || {};
    pullRequestNumber = numberText(workflowRunPullRequest.number);
    headSha = optionalText(workflowRunPullRequest.head?.sha || workflowRun.head_sha);
    conclusion = optionalText(workflowRun.conclusion);
    eventKind = `workflow_run.${text(workflowRun.name) || "unknown"}`;
    workflowRunId = numberText(workflowRun.id) || runId;
    const workflowRunAttemptText = numberText(workflowRun.run_attempt);
    workflowRunAttempt = workflowRunAttemptText ? Number(workflowRunAttemptText) : runAttempt;
  }

  if (eventName === "pull_request_review") {
    pullRequestNumber = numberText(eventPayload.pull_request?.number);
    headSha = optionalText(eventPayload.pull_request?.head?.sha);
    conclusion = optionalText(eventPayload.review?.state);
    eventKind = `pull_request_review.${text(eventPayload.review?.state) || "submitted"}`;
  }

  if (!repository) {
    return { skipped: true, reason: "missing repository" };
  }

  if (!pullRequestNumber) {
    return { skipped: true, reason: "missing pull request number" };
  }

  return {
    skipped: false,
    payload: {
      repository,
      pull_request_number: Number(pullRequestNumber),
      head_sha: headSha,
      event_kind: eventKind,
      conclusion,
      idempotency_key: [
        repository,
        pullRequestNumber,
        eventKind,
        workflowRunId || "manual",
        workflowRunAttempt || 0,
        headSha || "unknown",
      ].join(":"),
      workflow_run_id: workflowRunId || null,
      workflow_run_attempt: workflowRunAttempt || null,
    },
  };
}

export async function readGitHubEventPayload({ env = process.env, readFileImpl = readFile } = {}) {
  const eventPath = text(env.GITHUB_EVENT_PATH);
  if (!eventPath) {
    return {};
  }

  return JSON.parse(await readFileImpl(eventPath, "utf8"));
}

export async function reportCodeq8PrWakeup({
  env = process.env,
  eventPayload,
  readFileImpl = readFile,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!fetchImpl) {
    throw new Error("global fetch is unavailable; Codeq8 PR wakeup requires Node.js 18 or newer");
  }

  const resolvedEventPayload =
    eventPayload === undefined ? await readGitHubEventPayload({ env, readFileImpl }) : eventPayload;
  const payloadResult = buildCodeq8PrWakeupPayload({ env, eventPayload: resolvedEventPayload });
  if (payloadResult.skipped) {
    return payloadResult;
  }

  const token = text(env.GITHUB_TOKEN);
  if (!token) {
    throw new Error("Missing github_token input");
  }

  const baseUrl = resolveCodeq8PrWakeupBaseUrl({
    repository: payloadResult.payload.repository,
    refName: env.GITHUB_REF_NAME,
  });
  const endpoint = new URL("/api/v1/codeq8-wakeups", baseUrl);

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payloadResult.payload),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Codeq8 wakeup failed with ${response.status}: ${responseText}`);
  }

  return {
    skipped: false,
    endpoint: endpoint.toString(),
    status: response.status,
    responseText,
    payload: payloadResult.payload,
  };
}

async function main() {
  const result = await reportCodeq8PrWakeup();
  if (result.skipped) {
    console.log(`Codeq8 PR wakeup skipped: ${result.reason}.`);
    return;
  }

  console.log(`Reported Codeq8 PR wakeup for ${result.payload.repository}#${result.payload.pull_request_number}.`);
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (currentFilePath === invokedFilePath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
