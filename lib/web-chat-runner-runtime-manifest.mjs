import runtimeManifest from "./web-chat-runner-runtime-manifest.json" with { type: "json" };

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeList(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((entry) => normalizeText(entry))
        .filter(Boolean),
    ),
  );
}

export const WEB_CHAT_RUNNER_RUNTIME_MANIFEST_PATH = "/api/chat/runs/runtime-manifest";
export const WEB_CHAT_RUNNER_RUNTIME_CONTRACT_VERSION = normalizeText(
  runtimeManifest.contract_version,
);
export const REQUIRED_WEB_CHAT_RUNNER_RUNTIME_CAPABILITIES = Object.freeze(
  normalizeList(runtimeManifest.required_capabilities),
);
export const REQUIRED_WEB_CHAT_RUNNER_RUNTIME_PATHS = Object.freeze(
  normalizeList(runtimeManifest.required_paths),
);

export const WEB_CHAT_RUNNER_RUNTIME_MANIFEST = Object.freeze({
  contract_version: WEB_CHAT_RUNNER_RUNTIME_CONTRACT_VERSION,
  required_capabilities: [...REQUIRED_WEB_CHAT_RUNNER_RUNTIME_CAPABILITIES],
  required_paths: [...REQUIRED_WEB_CHAT_RUNNER_RUNTIME_PATHS],
});
