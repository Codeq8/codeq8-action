const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;

export const GITHUB_ACTIONS_API_VERSION = "2026-03-10";
export const CODEQ8_CHAT_RUN_WORKFLOW_FILE = "codeq8-chat-run.yml";
export const CODEQ8_CHAT_RUN_WORKFLOW_NAME = "Codeq8 chat run";
export const CODEQ8_CHAT_RUN_REPOSITORY_DISPATCH_EVENT = "codeq8_web_chat_run";
export const CODEQ8_CHATGPT_ACCOUNT_AUTH_WORKFLOW_FILE = "codeq8-chatgpt-account-auth.yml";
export const CODEQ8_CHATGPT_ACCOUNT_AUTH_WORKFLOW_NAME = "Codeq8 ChatGPT account auth";

/**
 * @typedef {{
 *   url: string;
 *   init: RequestInit;
 * }} GitHubActionsRequest
 */

/**
 * @typedef {{
 *   repository?: string;
 *   runId?: string;
 *   serverUrl?: string;
 * }} GitHubActionsRunHtmlUrlOptions
 */

function normalizeText(value) {
  return String(value ?? "").trim();
}

export function normalizeRepository(value) {
  const normalized = normalizeText(value);
  return REPOSITORY_PATTERN.test(normalized) ? normalized : "";
}

export function normalizeGitRef(value) {
  const normalized = normalizeText(value)
    .replace(/^refs\/heads\//i, "")
    .replace(/^origin\//i, "");
  if (
    !normalized ||
    normalized.toLowerCase() === "head" ||
    normalized.startsWith("/") ||
    normalized.includes("..")
  ) {
    return "";
  }
  return GIT_REF_PATTERN.test(normalized) ? normalized : "";
}

function resolveCurrentCodeq8FallbackRef(env = {}) {
  const normalizedVercelEnvironment = normalizeText(
    env.VERCEL_ENV || env.VERCEL_TARGET_ENV || "",
  ).toLowerCase();
  if (normalizedVercelEnvironment === "production") {
    return "production";
  }
  return "main";
}

export function resolveCurrentControlPlaneRepository(env = {}) {
  return (
    normalizeRepository(env.CODE_CONTROL_PLANE_REPOSITORY || "") ||
    normalizeRepository(env.GITHUB_REPOSITORY || "") ||
    normalizeRepository(
      `${normalizeText(env.VERCEL_GIT_REPO_OWNER || "")}/${normalizeText(env.VERCEL_GIT_REPO_SLUG || "")}`,
    )
  );
}

export function resolveCurrentCodeq8GitRef(env = {}) {
  return (
    normalizeGitRef(env.VERCEL_GIT_COMMIT_REF || "") ||
    normalizeGitRef(env.GITHUB_HEAD_REF || "") ||
    normalizeGitRef(env.GITHUB_REF_NAME || "") ||
    resolveCurrentCodeq8FallbackRef(env)
  );
}

export function resolveCurrentCodeq8DeploymentRef(env = {}) {
  return resolveCurrentCodeq8FallbackRef(env);
}

export function resolveRepositoryWorkflowDispatchRef(options = {}) {
  const { workspaceRepository = "", env = {} } = options || {};
  const normalizedWorkspaceRepository = normalizeRepository(workspaceRepository);
  const currentControlPlaneRepository = resolveCurrentControlPlaneRepository(env);

  if (
    normalizedWorkspaceRepository &&
    currentControlPlaneRepository &&
    normalizedWorkspaceRepository.toLowerCase() === currentControlPlaneRepository.toLowerCase()
  ) {
    return resolveCurrentCodeq8GitRef(env);
  }

  // External repositories should run the workflow infrastructure from the deployed
  // environment branch (`main` for preview/main staging, `production` for production).
  // The runner still fetches and switches the workspace to the thread's actual branch
  // from the dispatched payload, so this only selects the workflow/action contract.
  return resolveCurrentCodeq8DeploymentRef(env);
}

export function resolveThreadWorkspaceDispatchRef({
  associatedBranch = "",
  repositoryDefaultBranch = "",
} = {}) {
  const normalizedAssociatedBranch = normalizeGitRef(associatedBranch);
  const normalizedDefaultBranch = normalizeGitRef(repositoryDefaultBranch);

  if (normalizedAssociatedBranch) {
    return normalizedAssociatedBranch;
  }

  return normalizedDefaultBranch || "main";
}

export function normalizeWebChatId(value) {
  const normalized = normalizeText(value);
  return THREAD_ID_PATTERN.test(normalized) ? normalized : "";
}

export function buildGitHubActionsRunHtmlUrl({
  repository,
  runId,
  serverUrl = "https://github.com",
} = /** @type {GitHubActionsRunHtmlUrlOptions} */ ({})) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedRunId = normalizeWebChatId(runId);
  const normalizedServerUrl = normalizeText(serverUrl).replace(/\/+$/, "");
  if (!normalizedRepository || !normalizedRunId || !normalizedServerUrl) {
    return "";
  }
  return `${normalizedServerUrl}/${normalizedRepository}/actions/runs/${encodeURIComponent(normalizedRunId)}`;
}

export function createWebChatRunId({
  messageId = "",
  existingRunId = "",
} = {}) {
  const normalizedExistingRunId = normalizeWebChatId(existingRunId);
  if (normalizedExistingRunId) {
    return normalizedExistingRunId;
  }

  const messageSuffix = normalizeText(messageId).replace(/^wcm_/i, "");
  const candidate = normalizeWebChatId(`wcr_${messageSuffix}`);
  if (candidate) {
    return candidate;
  }

  return normalizeWebChatId(`wcr_${crypto.randomUUID()}`);
}

export function buildGitHubActionsWorkflowDispatchRequest({
  repository,
  ref,
  token,
  workflowId = CODEQ8_CHAT_RUN_WORKFLOW_FILE,
  runPayload,
  returnRunDetails = true,
} = /** @type {{
 *   repository?: string;
 *   ref?: string;
 *   token?: string;
 *   workflowId?: string;
 *   runPayload?: unknown;
 *   returnRunDetails?: boolean;
 * }} */ ({})) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedRef = normalizeGitRef(ref) || "main";
  const normalizedToken = normalizeText(token);
  const normalizedWorkflowId = encodeURIComponent(
    normalizeText(workflowId) || CODEQ8_CHAT_RUN_WORKFLOW_FILE,
  );
  if (!normalizedRepository || !normalizedToken) {
    throw new Error("repository and token are required.");
  }

  const [owner, repo] = normalizedRepository.split("/", 2);
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${normalizedWorkflowId}/dispatches`,
  );
  if (returnRunDetails) {
    url.searchParams.set("return_run_details", "true");
  }

  /** @type {GitHubActionsRequest} */
  return {
    url: url.toString(),
    init: {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${normalizedToken}`,
        "Content-Type": "application/json",
        "User-Agent": "codeq8-control-plane",
        "X-GitHub-Api-Version": GITHUB_ACTIONS_API_VERSION,
      },
      body: JSON.stringify({
        ref: normalizedRef,
        inputs: {
          run_payload_json: JSON.stringify(runPayload || {}),
        },
      }),
      cache: /** @type {RequestCache} */ ("no-store"),
    },
  };
}

export function buildGitHubRepositoryDispatchRequest({
  repository,
  token,
  eventType = CODEQ8_CHAT_RUN_REPOSITORY_DISPATCH_EVENT,
  clientPayload,
} = /** @type {{
 *   repository?: string;
 *   token?: string;
 *   eventType?: string;
 *   clientPayload?: unknown;
 * }} */ ({})) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedToken = normalizeText(token);
  const normalizedEventType =
    normalizeText(eventType) || CODEQ8_CHAT_RUN_REPOSITORY_DISPATCH_EVENT;
  const normalizedClientPayload =
    clientPayload && typeof clientPayload === "object" && !Array.isArray(clientPayload)
      ? clientPayload
      : {};
  if (!normalizedRepository || !normalizedToken || !normalizedEventType) {
    throw new Error("repository, token, and eventType are required.");
  }

  const [owner, repo] = normalizedRepository.split("/", 2);
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/dispatches`,
  );

  /** @type {GitHubActionsRequest} */
  return {
    url: url.toString(),
    init: {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${normalizedToken}`,
        "Content-Type": "application/json",
        "User-Agent": "codeq8-control-plane",
        "X-GitHub-Api-Version": GITHUB_ACTIONS_API_VERSION,
      },
      body: JSON.stringify({
        event_type: normalizedEventType,
        client_payload: normalizedClientPayload,
      }),
      cache: /** @type {RequestCache} */ ("no-store"),
    },
  };
}

export function isMissingWorkflowDispatchTriggerResponse({
  status = 0,
  payload,
} = /** @type {{
 *   status?: number;
 *   payload?: unknown;
 * }} */ ({})) {
  const normalizedPayload =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const message = normalizeText(normalizedPayload.message || normalizedPayload.error).toLowerCase();
  return Number(status || 0) === 422 && message.includes("workflow_dispatch") && message.includes("trigger");
}

export function isMissingWorkflowDispatchRefResponse({
  status = 0,
  payload,
} = /** @type {{
 *   status?: number;
 *   payload?: unknown;
 * }} */ ({})) {
  const normalizedPayload =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const message = normalizeText(normalizedPayload.message || normalizedPayload.error).toLowerCase();
  return Number(status || 0) === 422 && message.includes("no ref found for:");
}

export function normalizeGitHubActionsWorkflowDispatchResponse(value) {
  const normalized = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const workflowRunId = normalizeWebChatId(
    normalized.workflow_run_id || normalized.workflowRunId || "",
  );
  return {
    workflow_run_id: workflowRunId,
    run_url: normalizeText(normalized.run_url || normalized.runUrl || ""),
    html_url: normalizeText(normalized.html_url || normalized.htmlUrl || ""),
  };
}

export function buildGitHubActionsWorkflowRunCancelRequest({
  repository,
  runId,
  token,
} = /** @type {{
 *   repository?: string;
 *   runId?: string;
 *   token?: string;
 * }} */ ({})) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedRunId = normalizeWebChatId(runId);
  const normalizedToken = normalizeText(token);
  if (!normalizedRepository || !normalizedRunId || !normalizedToken) {
    throw new Error("repository, runId, and token are required.");
  }

  const [owner, repo] = normalizedRepository.split("/", 2);
  /** @type {GitHubActionsRequest} */
  return {
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(normalizedRunId)}/cancel`,
    init: {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${normalizedToken}`,
        "User-Agent": "codeq8-control-plane",
        "X-GitHub-Api-Version": GITHUB_ACTIONS_API_VERSION,
      },
      cache: /** @type {RequestCache} */ ("no-store"),
    },
  };
}
