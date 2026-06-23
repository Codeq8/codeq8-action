import { z } from "zod";

import { WEB_CHAT_RUNNER_RUNTIME_CONTRACT_VERSION } from "./web-chat-runner-runtime-manifest.mjs";

export const WEB_CHAT_RUNNER_DIAGNOSTIC_PATH = "/api/chat/runs/diagnostic";
export const WEB_CHAT_RUNNER_CODEX_GOAL_PATH = "/api/chat/runs/goal";
export const WEB_CHAT_RUNNER_APP_SERVER_TURN_CONTROL_CAPABILITY =
  "codex_app_server_turn_control";
export const WEB_CHAT_RUNNER_CODEX_GOALS_CAPABILITY =
  "codex_app_server_thread_goals";
export const WEB_CHAT_RUNNER_APP_SERVER_PROGRESS_HISTORY_CAPABILITY =
  "codex_app_server_progress_history";
// AppServer live progress/control uses one Firebase session bootstrap and then
// Firestore listen/write semantics. Do not add the legacy AppServer event or
// control HTTP routes back to the required runner contract; that turns active
// chat transport into a request polling surface.
export const WEB_CHAT_RUNNER_APP_SERVER_FIRESTORE_SESSION_PATH =
  "/api/chat/runs/app-server/firebase-session";

export const webChatRunnerRuntimeManifestResponseSchema = z.object({
  ok: z.literal(true),
  contract_version: z.literal(WEB_CHAT_RUNNER_RUNTIME_CONTRACT_VERSION),
  capabilities: z.array(z.string().trim().min(1)).default([]),
  authorized_paths: z.array(z.string().trim().min(1)).default([]),
  scoped_authorized_paths: z.array(z.string().trim().min(1)).default([]),
  runner_required_paths: z.array(z.string().trim().min(1)).default([]),
});

export const webChatRunnerCodexGoalStateSchema = z.object({
  objective: z.string().default(""),
  status: z.string().trim().default(""),
  token_budget: z.number().int().positive().nullable().default(null),
  tokens_used: z.number().int().nonnegative().default(0),
  time_used_seconds: z.number().int().nonnegative().default(0),
  created_at: z.number().int().nonnegative().default(0),
  updated_at: z.number().int().nonnegative().default(0),
  last_run_id: z.string().trim().default(""),
  last_turn_id: z.string().trim().default(""),
});

export const webChatRunnerPromptResponseSchema = z.object({
  ok: z.literal(true),
  contract_version: z.literal(WEB_CHAT_RUNNER_RUNTIME_CONTRACT_VERSION),
  prompt: z.string(),
  codex_goal_state: webChatRunnerCodexGoalStateSchema.nullable().default(null),
});

export const webChatRunnerDiagnosticResponseSchema = z.object({
  ok: z.boolean(),
  report: z
    .object({
      ok: z.boolean().optional(),
      skipped: z.boolean().optional(),
      reason: z.string().optional(),
      status: z.number().optional(),
      error: z.string().optional(),
    })
    .optional(),
});

function normalizeText(value) {
  return String(value || "").trim();
}

export function supportsCodexThreadGoals(manifest) {
  const parsed = webChatRunnerRuntimeManifestResponseSchema.safeParse(manifest);
  if (!parsed.success) {
    return false;
  }
  const capabilitySet = new Set(
    parsed.data.capabilities.map((entry) => normalizeText(entry)).filter(Boolean),
  );
  const pathSet = new Set(
    parsed.data.authorized_paths.map((entry) => normalizeText(entry)).filter(Boolean),
  );
  return (
    capabilitySet.has(WEB_CHAT_RUNNER_CODEX_GOALS_CAPABILITY) &&
    pathSet.has(WEB_CHAT_RUNNER_CODEX_GOAL_PATH)
  );
}

export function supportsAppServerProgressHistory(manifest) {
  const parsed = webChatRunnerRuntimeManifestResponseSchema.safeParse(manifest);
  if (!parsed.success) {
    return false;
  }
  const capabilitySet = new Set(
    parsed.data.capabilities.map((entry) => normalizeText(entry)).filter(Boolean),
  );
  return capabilitySet.has(WEB_CHAT_RUNNER_APP_SERVER_PROGRESS_HISTORY_CAPABILITY);
}
