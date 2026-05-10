import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEQ8_MAIN_STAGING_BASE_URL,
  CODEQ8_PRODUCTION_BASE_URL,
  buildCodeq8PrWakeupPayload,
  reportCodeq8PrWakeup,
  resolveCodeq8PrWakeupBaseUrl,
} from "./github-actions-pr-wakeup.mjs";

test("resolveCodeq8PrWakeupBaseUrl routes Codeq8 non-production branches to main staging", () => {
  assert.equal(
    resolveCodeq8PrWakeupBaseUrl({ repository: "Codeq8/Codeq8", refName: "main" }),
    CODEQ8_MAIN_STAGING_BASE_URL,
  );
  assert.equal(
    resolveCodeq8PrWakeupBaseUrl({ repository: "Codeq8/Codeq8", refName: "feature/test" }),
    CODEQ8_MAIN_STAGING_BASE_URL,
  );
});

test("resolveCodeq8PrWakeupBaseUrl routes production and external repositories to production", () => {
  assert.equal(
    resolveCodeq8PrWakeupBaseUrl({ repository: "Codeq8/Codeq8", refName: "production" }),
    CODEQ8_PRODUCTION_BASE_URL,
  );
  assert.equal(
    resolveCodeq8PrWakeupBaseUrl({ repository: "example/project", refName: "main" }),
    CODEQ8_PRODUCTION_BASE_URL,
  );
});

test("buildCodeq8PrWakeupPayload builds workflow_run wakeups", () => {
  const result = buildCodeq8PrWakeupPayload({
    env: {
      GITHUB_REPOSITORY: "Codeq8/Codeq8",
      GITHUB_EVENT_NAME: "workflow_run",
      GITHUB_RUN_ID: "10",
      GITHUB_RUN_ATTEMPT: "2",
    },
    eventPayload: {
      workflow_run: {
        id: 123,
        run_attempt: 4,
        name: "CI",
        conclusion: "success",
        head_sha: "abc123",
        pull_requests: [{ number: 42, head: { sha: "def456" } }],
      },
    },
  });

  assert.equal(result.skipped, false);
  assert.deepEqual(result.payload, {
    repository: "Codeq8/Codeq8",
    pull_request_number: 42,
    head_sha: "def456",
    event_kind: "workflow_run.CI",
    conclusion: "success",
    idempotency_key: "Codeq8/Codeq8:42:workflow_run.CI:123:4:def456",
    workflow_run_id: "123",
    workflow_run_attempt: 4,
  });
});

test("buildCodeq8PrWakeupPayload builds pull_request_review wakeups", () => {
  const result = buildCodeq8PrWakeupPayload({
    env: {
      GITHUB_REPOSITORY: "Codeq8/Codeq8",
      GITHUB_EVENT_NAME: "pull_request_review",
      GITHUB_RUN_ID: "55",
      GITHUB_RUN_ATTEMPT: "1",
    },
    eventPayload: {
      pull_request: { number: 42, head: { sha: "abc123" } },
      review: { state: "approved" },
    },
  });

  assert.equal(result.skipped, false);
  assert.equal(result.payload.event_kind, "pull_request_review.approved");
  assert.equal(result.payload.conclusion, "approved");
  assert.equal(result.payload.workflow_run_id, "55");
});

test("buildCodeq8PrWakeupPayload skips events without a pull request", () => {
  const result = buildCodeq8PrWakeupPayload({
    env: {
      GITHUB_REPOSITORY: "Codeq8/Codeq8",
      GITHUB_EVENT_NAME: "workflow_run",
    },
    eventPayload: {
      workflow_run: {
        name: "CI",
        pull_requests: [],
      },
    },
  });

  assert.deepEqual(result, { skipped: true, reason: "missing pull request number" });
});

test("reportCodeq8PrWakeup posts to the wakeup endpoint with the workflow token", async () => {
  let request;
  const result = await reportCodeq8PrWakeup({
    env: {
      GITHUB_REPOSITORY: "example/project",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_RUN_ID: "5",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_TOKEN: "token-value",
      CODEQ8_WAKEUP_PULL_REQUEST_NUMBER: "7",
      CODEQ8_WAKEUP_HEAD_SHA: "abc123",
      CODEQ8_WAKEUP_CONCLUSION: "success",
    },
    eventPayload: {},
    fetchImpl: async (url, init) => {
      request = { url: url.toString(), init };
      return {
        ok: true,
        status: 202,
        text: async () => "accepted",
      };
    },
  });

  assert.equal(result.status, 202);
  assert.equal(request.url, "https://codeq8.com/api/v1/codeq8-wakeups");
  assert.equal(request.init.headers.authorization, "Bearer token-value");
  assert.deepEqual(JSON.parse(request.init.body), {
    repository: "example/project",
    pull_request_number: 7,
    head_sha: "abc123",
    event_kind: "workflow_dispatch",
    conclusion: "success",
    idempotency_key: "example/project:7:workflow_dispatch:5:1:abc123",
    workflow_run_id: "5",
    workflow_run_attempt: 1,
  });
});
