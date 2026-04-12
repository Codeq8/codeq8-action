import { z } from "zod";

import { WEB_CHAT_RUNNER_RUNTIME_CONTRACT_VERSION } from "./web-chat-runner-runtime-manifest.mjs";

export const WEB_CHAT_RUNNER_CODEQ8_FILE_SYNC_CAPABILITY = "server_owned_codeq8_file_sync";
export const WEB_CHAT_RUNNER_CODEQ8_FILE_PATH = "/api/chat/runs/codeq8-file";
export const WEB_CHAT_RUNNER_CODEQ8_FILE_SAVE_PATH = "/api/chat/runs/codeq8-file/save";

export const webChatRunnerRuntimeManifestResponseSchema = z.object({
  ok: z.literal(true),
  contract_version: z.literal(WEB_CHAT_RUNNER_RUNTIME_CONTRACT_VERSION),
  capabilities: z.array(z.string().trim().min(1)).default([]),
  authorized_paths: z.array(z.string().trim().min(1)).default([]),
});

export const webChatRunnerPromptResponseSchema = z.object({
  ok: z.literal(true),
  contract_version: z.literal(WEB_CHAT_RUNNER_RUNTIME_CONTRACT_VERSION),
  prompt: z.string(),
});

export const webChatRunnerPullRequestPresentationResponseSchema = z.object({
  ok: z.literal(true),
  contract_version: z.literal(WEB_CHAT_RUNNER_RUNTIME_CONTRACT_VERSION),
  title: z.string(),
  body: z.string(),
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
