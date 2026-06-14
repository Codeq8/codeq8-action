import { z } from "zod";

import { WEB_CHAT_RUNNER_RUNTIME_CONTRACT_VERSION } from "./web-chat-runner-runtime-manifest.mjs";

export const WEB_CHAT_RUNNER_CODEQ8_FILE_SYNC_CAPABILITY = "server_owned_codeq8_file_sync";
export const WEB_CHAT_RUNNER_CODEQ8_FILE_PATH = "/api/chat/runs/codeq8-file";
export const WEB_CHAT_RUNNER_CODEQ8_FILE_SAVE_PATH = "/api/chat/runs/codeq8-file/save";
export const WEB_CHAT_RUNNER_DIAGNOSTIC_PATH = "/api/chat/runs/diagnostic";
export const WEB_CHAT_RUNNER_CODEX_GOAL_PATH = "/api/chat/runs/goal";
export const WEB_CHAT_RUNNER_DISCORD_DM_CHAT_CAPABILITY = "server_owned_discord_dm_chat";
export const WEB_CHAT_RUNNER_DISCORD_DM_LIST_PATH = "/api/chat/runs/discord-dm/list";
export const WEB_CHAT_RUNNER_DISCORD_DM_SEND_PATH = "/api/chat/runs/discord-dm/send";
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

export const webChatRunnerDiscordDmChatMessageSchema = z.object({
  event_id: z.string().trim().default(""),
  message_id: z.string().trim().default(""),
  event_kind: z.string().trim().default(""),
  direction: z.string().trim().default(""),
  created_at: z.number().int().nonnegative().default(0),
  content_text: z.string().default(""),
  transcript_text: z.string().default(""),
});

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

export const webChatRunnerCodeq8FileResponseSchema = z.object({
  ok: z.literal(true),
  contract_version: z.literal(WEB_CHAT_RUNNER_RUNTIME_CONTRACT_VERSION),
  prompt_file_path: z.string().trim().min(1),
  repo_workflow_prompt_markdown: z.string(),
  latest_revision_id: z.string().trim().min(1),
  latest_revision_number: z.number().int().nonnegative(),
});

export const webChatRunnerCodeq8FileSaveResponseSchema = z.object({
  ok: z.literal(true),
  contract_version: z.literal(WEB_CHAT_RUNNER_RUNTIME_CONTRACT_VERSION),
  prompt_file_path: z.string().trim().min(1),
  unchanged: z.boolean(),
  latest_revision_id: z.string().trim().min(1),
  latest_revision_number: z.number().int().nonnegative(),
});

export const webChatRunnerDiscordDmListResponseSchema = z.object({
  ok: z.literal(true),
  contract_version: z.literal(WEB_CHAT_RUNNER_RUNTIME_CONTRACT_VERSION),
  messages: z.array(webChatRunnerDiscordDmChatMessageSchema).default([]),
  page_count: z.number().int().nonnegative(),
  has_more: z.boolean(),
  next_before_created_at: z.number().int().nonnegative().default(0),
  next_before_event_id: z.string().trim().default(""),
});

export const webChatRunnerDiscordDmSendResponseSchema = z.object({
  ok: z.literal(true),
  contract_version: z.literal(WEB_CHAT_RUNNER_RUNTIME_CONTRACT_VERSION),
  sent: z.boolean(),
  recorded: z.boolean(),
  skipped: z.boolean().default(false),
  reason: z.string().trim().default(""),
  message_id: z.string().trim().default(""),
  event_id: z.string().trim().default(""),
});

function normalizeText(value) {
  return String(value || "").trim();
}

export function supportsServerOwnedCodeq8FileSync(manifest) {
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
    capabilitySet.has(WEB_CHAT_RUNNER_CODEQ8_FILE_SYNC_CAPABILITY) &&
    pathSet.has(WEB_CHAT_RUNNER_CODEQ8_FILE_PATH) &&
    pathSet.has(WEB_CHAT_RUNNER_CODEQ8_FILE_SAVE_PATH)
  );
}

export function supportsServerOwnedDiscordDmChat(manifest) {
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
    capabilitySet.has(WEB_CHAT_RUNNER_DISCORD_DM_CHAT_CAPABILITY) &&
    pathSet.has(WEB_CHAT_RUNNER_DISCORD_DM_LIST_PATH) &&
    pathSet.has(WEB_CHAT_RUNNER_DISCORD_DM_SEND_PATH)
  );
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
