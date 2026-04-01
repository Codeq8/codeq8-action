import { GITHUB_OAUTH_APP_SETTINGS_URL } from "./github-app-access.js";
import {
  encodeRepositoryPath,
  normalizeBranchName,
  normalizeRepository,
  normalizeText,
  readPositiveInteger,
} from "./web-chat-github-read.mjs";

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function oauthStartLink(returnTo) {
  return `/api/github/oauth/start?return_to=${encodeURIComponent(returnTo)}`;
}

function repositoryOwner(value) {
  const normalized = normalizeRepository(value);
  if (!normalized) {
    return "";
  }
  const [owner] = normalized.split("/", 1);
  return normalizeText(owner);
}

function normalizeBranchList(value) {
  const candidates = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const seen = new Set();
  const branches = [];
  for (const candidate of candidates) {
    const normalized = normalizeBranchName(candidate);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    branches.push(normalized);
  }
  return branches;
}

function normalizeStringList(value) {
  const candidates = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const values = [];
  for (const candidate of candidates) {
    const normalized = normalizeText(candidate);
    if (!normalized) {
      continue;
    }
    values.push(normalized);
  }
  return values;
}

function normalizeCheckName(value) {
  return normalizeText(value).slice(0, 200);
}

function normalizeWorkspaceProfile(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === "profile_1" || normalized === "profile_2" ? normalized : "";
}

export function normalizeChatPolicyConfig(value) {
  const normalized = normalizeObject(value);
  if (Object.keys(normalized).length === 0) {
    return null;
  }
  if (readPositiveInteger(normalized.version) !== 1) {
    return "invalid";
  }

  const ci = normalizeObject(normalized.ci);
  const chat = normalizeObject(normalized.chat);
  const bootstrap = normalizeObject(normalized.bootstrap);
  const prompt = normalizeObject(normalized.prompt);
  const checks = normalizeObject(ci.checks);
  const defaultBranch =
    normalizeBranchName(ci.default_branch || ci.defaultBranch || normalized.default_branch || "") ||
    "";
  const nodeVersion =
    normalizeText(ci.node_version || ci.nodeVersion || normalized.ci_node_version || "") || "";
  const profile =
    normalizeWorkspaceProfile(
      ci.profile || ci.workspace_profile || ci.workspaceProfile || normalized.profile || "",
    ) || "";
  const ciCheckNamePr = normalizeCheckName(
    checks.pr || checks.pull_request || ci.ci_check_name_pr || normalized.ci_check_name_pr || "",
  );
  const ciCheckNameMain = normalizeCheckName(
    checks.main || checks.push || ci.ci_check_name_main || normalized.ci_check_name_main || "",
  );
  const ciPr = normalizeStringList(ci.pr || ci.ci_pr || normalized.ci_pr || []);
  const ciMain = normalizeStringList(ci.main || ci.ci_main || normalized.ci_main || []);
  const protectedBranches = normalizeBranchList(
    chat.protected_branches || chat.protectedBranches || [],
  );
  const productionBranch =
    normalizeBranchName(chat.production_branch || chat.productionBranch || "") || "";
  const bootstrapInstall = normalizeStringList(
    bootstrap.install || bootstrap.commands || normalized.bootstrap_install || [],
  );
  const promptExtraInstructionsFile = normalizeText(
    prompt.extra_instructions_file ||
      prompt.extraInstructionsFile ||
      normalized.prompt_extra_instructions_file ||
      "",
  );
  const promptExtraCommonInstructionsFile = normalizeText(
    prompt.extra_common_instructions_file ||
      prompt.extraCommonInstructionsFile ||
      normalized.prompt_extra_common_instructions_file ||
      "",
  );

  const result = { version: 1 };
  if (
    defaultBranch ||
    nodeVersion ||
    profile ||
    ciCheckNamePr ||
    ciCheckNameMain ||
    ciPr.length > 0 ||
    ciMain.length > 0
  ) {
    result.ci = {};
    if (defaultBranch) {
      result.ci.default_branch = defaultBranch;
    }
    if (nodeVersion) {
      result.ci.node_version = nodeVersion;
    }
    if (profile) {
      result.ci.profile = profile;
    }
    if (ciCheckNamePr || ciCheckNameMain) {
      result.ci.checks = {};
      if (ciCheckNamePr) {
        result.ci.checks.pr = ciCheckNamePr;
      }
      if (ciCheckNameMain) {
        result.ci.checks.main = ciCheckNameMain;
      }
    }
    if (ciPr.length > 0) {
      result.ci.pr = ciPr;
    }
    if (ciMain.length > 0) {
      result.ci.main = ciMain;
    }
  }
  if (protectedBranches.length > 0 || productionBranch) {
    result.chat = {};
    if (protectedBranches.length > 0) {
      result.chat.protected_branches = protectedBranches;
    }
    if (productionBranch) {
      result.chat.production_branch = productionBranch;
    }
  }
  if (bootstrapInstall.length > 0) {
    result.bootstrap = {
      install: bootstrapInstall,
    };
  }
  if (promptExtraInstructionsFile || promptExtraCommonInstructionsFile) {
    result.prompt = {};
    if (promptExtraInstructionsFile) {
      result.prompt.extra_instructions_file = promptExtraInstructionsFile;
    }
    if (promptExtraCommonInstructionsFile) {
      result.prompt.extra_common_instructions_file = promptExtraCommonInstructionsFile;
    }
  }
  return result;
}

export function mergeChatPolicyConfigs(primary, fallback) {
  if (!primary && !fallback) {
    return null;
  }

  const merged = { version: 1 };
  const defaultBranch =
    normalizeBranchName(primary?.ci?.default_branch || fallback?.ci?.default_branch || "") || "";
  const nodeVersion =
    normalizeText(primary?.ci?.node_version || fallback?.ci?.node_version || "") || "";
  const profile =
    normalizeWorkspaceProfile(primary?.ci?.profile || fallback?.ci?.profile || "") || "";
  const ciCheckNamePr =
    normalizeCheckName(primary?.ci?.checks?.pr || fallback?.ci?.checks?.pr || "") || "";
  const ciCheckNameMain =
    normalizeCheckName(primary?.ci?.checks?.main || fallback?.ci?.checks?.main || "") || "";
  const ciPr =
    normalizeStringList(primary?.ci?.pr).length > 0
      ? normalizeStringList(primary?.ci?.pr)
      : normalizeStringList(fallback?.ci?.pr);
  const ciMain =
    normalizeStringList(primary?.ci?.main).length > 0
      ? normalizeStringList(primary?.ci?.main)
      : normalizeStringList(fallback?.ci?.main);
  const protectedBranches = normalizeBranchList([
    ...(primary?.chat?.protected_branches || []),
    ...(fallback?.chat?.protected_branches || []),
  ]);
  const productionBranch =
    normalizeBranchName(
      primary?.chat?.production_branch || fallback?.chat?.production_branch || "",
    ) || "";
  const bootstrapInstall =
    normalizeStringList(primary?.bootstrap?.install).length > 0
      ? normalizeStringList(primary?.bootstrap?.install)
      : normalizeStringList(fallback?.bootstrap?.install);
  const promptExtraInstructionsFile =
    normalizeText(
      primary?.prompt?.extra_instructions_file ||
        fallback?.prompt?.extra_instructions_file ||
        "",
    ) || "";
  const promptExtraCommonInstructionsFile =
    normalizeText(
      primary?.prompt?.extra_common_instructions_file ||
        fallback?.prompt?.extra_common_instructions_file ||
        "",
    ) || "";

  if (
    defaultBranch ||
    nodeVersion ||
    profile ||
    ciCheckNamePr ||
    ciCheckNameMain ||
    ciPr.length > 0 ||
    ciMain.length > 0
  ) {
    merged.ci = {};
    if (defaultBranch) {
      merged.ci.default_branch = defaultBranch;
    }
    if (nodeVersion) {
      merged.ci.node_version = nodeVersion;
    }
    if (profile) {
      merged.ci.profile = profile;
    }
    if (ciCheckNamePr || ciCheckNameMain) {
      merged.ci.checks = {};
      if (ciCheckNamePr) {
        merged.ci.checks.pr = ciCheckNamePr;
      }
      if (ciCheckNameMain) {
        merged.ci.checks.main = ciCheckNameMain;
      }
    }
    if (ciPr.length > 0) {
      merged.ci.pr = ciPr;
    }
    if (ciMain.length > 0) {
      merged.ci.main = ciMain;
    }
  }
  if (protectedBranches.length > 0 || productionBranch) {
    merged.chat = {};
    if (protectedBranches.length > 0) {
      merged.chat.protected_branches = protectedBranches;
    }
    if (productionBranch) {
      merged.chat.production_branch = productionBranch;
    }
  }
  if (bootstrapInstall.length > 0) {
    merged.bootstrap = {
      install: bootstrapInstall,
    };
  }
  if (promptExtraInstructionsFile || promptExtraCommonInstructionsFile) {
    merged.prompt = {};
    if (promptExtraInstructionsFile) {
      merged.prompt.extra_instructions_file = promptExtraInstructionsFile;
    }
    if (promptExtraCommonInstructionsFile) {
      merged.prompt.extra_common_instructions_file = promptExtraCommonInstructionsFile;
    }
  }
  return merged;
}

export function buildWorkspaceSettingsFromCodeq8Config({
  repository,
  config,
  defaultBranch = "",
}) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedConfig = normalizeChatPolicyConfig(config || {}) || { version: 1 };
  const ci = normalizeObject(normalizedConfig.ci);
  const chat = normalizeObject(normalizedConfig.chat);
  const bootstrap = normalizeObject(normalizedConfig.bootstrap);
  const prompt = normalizeObject(normalizedConfig.prompt);
  const profile = normalizeWorkspaceProfile(ci.profile || "") || "profile_1";

  return {
    workspace_repository: normalizedRepository,
    profile,
    default_branch:
      normalizeBranchName(ci.default_branch || defaultBranch || "") ||
      normalizeBranchName(defaultBranch) ||
      "",
    protected_branches: normalizeBranchList(chat.protected_branches || []),
    production_branch: normalizeBranchName(chat.production_branch || "") || "",
    bootstrap_install: normalizeStringList(bootstrap.install || []),
    prompt_extra_instructions_file: normalizeText(prompt.extra_instructions_file || ""),
    prompt_extra_common_instructions_file: normalizeText(
      prompt.extra_common_instructions_file || "",
    ),
    ci_node_version: normalizeText(ci.node_version || ""),
    ci_pr: normalizeStringList(ci.pr || []),
    ci_main: normalizeStringList(ci.main || []),
    ci_check_name_pr: normalizeCheckName(normalizeObject(ci.checks).pr || ""),
    ci_check_name_main: normalizeCheckName(normalizeObject(ci.checks).main || ""),
    updated_at: 0,
    updated_by: "",
  };
}

export async function fetchCodeq8ConfigAtRef({
  repository,
  ref,
  githubAccessToken,
  returnTo = "/",
}) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedRef = normalizeBranchName(ref);
  if (!normalizedRepository || !normalizedRef) {
    return { ok: true, config: null };
  }

  const response = await fetch(
    `https://api.github.com/repos/${encodeRepositoryPath(normalizedRepository)}/contents/codeq8.json?ref=${encodeURIComponent(normalizedRef)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${githubAccessToken}`,
        Accept: "application/vnd.github.raw",
        "User-Agent": "code-chat-api",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    },
  );
  if (response.status === 404) {
    return { ok: true, config: null };
  }
  if (response.status === 401) {
    return {
      ok: false,
      response: Response.json(
        {
          ok: false,
          error: "GitHub login expired. Re-login and try again.",
          link_url: oauthStartLink(returnTo),
        },
        { status: 401 },
      ),
    };
  }
  if (response.status === 403) {
    return {
      ok: false,
      response: Response.json(
        {
          ok: false,
          error: `GitHub account does not have repository access: ${normalizedRepository}.`,
          organization_slug: repositoryOwner(normalizedRepository) || null,
          github_app_settings_url: GITHUB_OAUTH_APP_SETTINGS_URL,
          action_required: "Open the app settings URL and grant organization access for this app.",
        },
        { status: 403 },
      ),
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      response: Response.json(
        {
          ok: false,
          error: `Unable to load codeq8.json from ${normalizedRepository}@${normalizedRef} (${response.status}).`,
        },
        { status: response.status >= 400 ? response.status : 502 },
      ),
    };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(await response.text());
  } catch (error) {
    return {
      ok: false,
      response: Response.json(
        {
          ok: false,
          error: `Invalid codeq8.json in ${normalizedRepository}@${normalizedRef}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        { status: 502 },
      ),
    };
  }

  const normalized = normalizeChatPolicyConfig(parsed);
  if (normalized === "invalid") {
    return {
      ok: false,
      response: Response.json(
        {
          ok: false,
          error: `Invalid codeq8.json in ${normalizedRepository}@${normalizedRef}.`,
        },
        { status: 502 },
      ),
    };
  }
  return {
    ok: true,
    config: normalized,
  };
}

export async function fetchMergedCodeq8Config({
  repository,
  primaryRef,
  fallbackRef = "",
  githubAccessToken,
  returnTo = "/",
}) {
  const primary = await fetchCodeq8ConfigAtRef({
    repository,
    ref: primaryRef,
    githubAccessToken,
    returnTo,
  });
  if (!primary.ok) {
    return primary;
  }

  const normalizedPrimaryRef = normalizeBranchName(primaryRef);
  const normalizedFallbackRef = normalizeBranchName(fallbackRef);
  if (
    !normalizedFallbackRef ||
    !normalizedPrimaryRef ||
    normalizedFallbackRef.toLowerCase() === normalizedPrimaryRef.toLowerCase()
  ) {
    return primary;
  }

  const fallback = await fetchCodeq8ConfigAtRef({
    repository,
    ref: normalizedFallbackRef,
    githubAccessToken,
    returnTo,
  });
  if (!fallback.ok) {
    return fallback;
  }

  return {
    ok: true,
    config: mergeChatPolicyConfigs(primary.config, fallback.config),
  };
}
