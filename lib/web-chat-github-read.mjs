import { z } from "zod";

import { GITHUB_OAUTH_APP_SETTINGS_URL } from "./github-app-access.js";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const GITHUB_REPOSITORIES_PER_PAGE = 100;
const GITHUB_VIEWER_SCHEMA = z.object({
  email: z.string().optional().default(""),
});
const GITHUB_VIEWER_EMAIL_RECORD_SCHEMA = z.object({
  email: z.string().optional().default(""),
  primary: z.boolean().optional().default(false),
  verified: z.boolean().optional().default(false),
});
const GITHUB_VIEWER_EMAIL_LIST_SCHEMA = z.array(GITHUB_VIEWER_EMAIL_RECORD_SCHEMA);
const GITHUB_REPOSITORY_LIST_ITEM_SCHEMA = z.object({
  full_name: z.string().optional().default(""),
  archived: z.boolean().optional().default(false),
  disabled: z.boolean().optional().default(false),
  permissions: z
    .object({
      admin: z.boolean().optional().default(false),
      push: z.boolean().optional().default(false),
    })
    .optional()
    .default({}),
});
const GITHUB_REPOSITORY_LIST_SCHEMA = z.array(GITHUB_REPOSITORY_LIST_ITEM_SCHEMA);

export function normalizeText(value) {
  return String(value ?? "").trim();
}

export function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

export function readPositiveInteger(value) {
  const parsed = Number.parseInt(normalizeText(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

export function normalizeRepository(value) {
  const normalized = normalizeText(value);
  if (!REPOSITORY_PATTERN.test(normalized)) {
    return "";
  }
  return normalized;
}

export function normalizeBranchName(value) {
  const raw = normalizeText(value);
  const normalized = raw.startsWith("refs/heads/") ? raw.slice("refs/heads/".length).trim() : raw;
  if (!normalized || normalized.length > 255) {
    return "";
  }
  if (!BRANCH_NAME_PATTERN.test(normalized)) {
    return "";
  }
  return normalized;
}

export function encodeRepositoryPath(repository) {
  return repository
    .split("/")
    .map((value) => encodeURIComponent(value))
    .join("/");
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

export function toApiErrorPayload(response) {
  return response
    .json()
    .then((payload) =>
      payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {},
    )
    .catch(() => ({}));
}

export function readRetryAfterSeconds(response) {
  const retryAfterHeader = normalizeText(response.headers.get("retry-after"));
  const retryAfterSeconds = Number.parseInt(retryAfterHeader, 10);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds;
  }

  const rateLimitResetHeader = normalizeText(response.headers.get("x-ratelimit-reset"));
  const resetAt = Number.parseInt(rateLimitResetHeader, 10);
  if (!Number.isFinite(resetAt) || resetAt <= 0) {
    return 0;
  }
  return Math.max(0, resetAt - Math.floor(Date.now() / 1000));
}

export function readGitHubSsoUrl(response) {
  const ssoHeader = normalizeText(response.headers.get("x-github-sso"));
  if (!ssoHeader) {
    return "";
  }
  const match = ssoHeader.match(/url=([^;]+)/i);
  return match ? normalizeText(match[1]) : "";
}

export function isGitHubRateLimitResponse(response, payload) {
  const remaining = normalizeText(response.headers.get("x-ratelimit-remaining"));
  const message = normalizeText(payload.message).toLowerCase();
  return remaining === "0" || message.includes("rate limit exceeded");
}

export function githubRepositoryAccessErrorResponse({
  repository,
  response,
  payload,
  returnTo,
  defaultErrorPrefix,
}) {
  const normalizedRepository = normalizeRepository(repository);
  if (response.status === 401) {
    return Response.json(
      {
        ok: false,
        error: "GitHub login expired. Re-login and try again.",
        link_url: oauthStartLink(returnTo),
      },
      { status: 401 },
    );
  }

  if (response.status === 403 && isGitHubRateLimitResponse(response, payload)) {
    const retryAfterSeconds = readRetryAfterSeconds(response);
    return Response.json(
      {
        ok: false,
        error: retryAfterSeconds
          ? `GitHub rate limit reached. Retry in about ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} minute${Math.ceil(retryAfterSeconds / 60) === 1 ? "" : "s"}.`
          : "GitHub rate limit reached. Retry in a minute.",
        retry_after_seconds: retryAfterSeconds || null,
      },
      { status: 429 },
    );
  }

  if (response.status === 403) {
    const ssoUrl = readGitHubSsoUrl(response);
    if (ssoUrl) {
      return Response.json(
        {
          ok: false,
          error:
            "GitHub requires SSO authorization before repository access can be used. Authorize GitHub and retry.",
          organization_slug: repositoryOwner(normalizedRepository) || null,
          github_app_settings_url: ssoUrl,
          action_required: "Open GitHub and authorize SSO for this account.",
        },
        { status: 403 },
      );
    }
  }

  if (response.status === 403 || response.status === 404) {
    return Response.json(
      {
        ok: false,
        error: `GitHub account does not have repository access: ${normalizedRepository}.`,
        organization_slug: repositoryOwner(normalizedRepository) || null,
        github_app_settings_url: GITHUB_OAUTH_APP_SETTINGS_URL,
        action_required: "Open the app settings URL and grant organization access for this app.",
      },
      { status: 403 },
    );
  }

  return Response.json(
    {
      ok: false,
      error:
        normalizeText(payload.message) ||
        `${defaultErrorPrefix} (${response.status}).`,
    },
    { status: response.status >= 400 ? response.status : 502 },
  );
}

function githubRepositoryListErrorResponse({
  response,
  payload,
  returnTo,
  defaultErrorPrefix,
}) {
  if (response.status === 401) {
    return Response.json(
      {
        ok: false,
        error: "GitHub login expired. Re-login and try again.",
        link_url: oauthStartLink(returnTo),
      },
      { status: 401 },
    );
  }

  if (response.status === 403 && isGitHubRateLimitResponse(response, payload)) {
    const retryAfterSeconds = readRetryAfterSeconds(response);
    return Response.json(
      {
        ok: false,
        error: retryAfterSeconds
          ? `GitHub rate limit reached. Retry in about ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} minute${Math.ceil(retryAfterSeconds / 60) === 1 ? "" : "s"}.`
          : "GitHub rate limit reached. Retry in a minute.",
        retry_after_seconds: retryAfterSeconds || null,
      },
      { status: 429 },
    );
  }

  if (response.status === 403) {
    const ssoUrl = readGitHubSsoUrl(response);
    if (ssoUrl) {
      return Response.json(
        {
          ok: false,
          error:
            "GitHub requires SSO authorization before repositories can be listed. Authorize GitHub and retry.",
          github_app_settings_url: ssoUrl,
          action_required: "Open GitHub and authorize SSO for this account.",
        },
        { status: 403 },
      );
    }

    return Response.json(
      {
        ok: false,
        error:
          "GitHub denied repository listing for this account. Grant organization access for this app and retry.",
        github_app_settings_url: GITHUB_OAUTH_APP_SETTINGS_URL,
        action_required:
          "Open the app settings URL and grant organization access for this app.",
      },
      { status: 403 },
    );
  }

  return Response.json(
    {
      ok: false,
      error:
        normalizeText(payload.message) ||
        `${defaultErrorPrefix} (${response.status}).`,
    },
    { status: response.status >= 400 ? response.status : 502 },
  );
}

export async function listAccessibleGitHubRepositories({
  githubAccessToken,
  requireWriteAccess = true,
  returnTo = "/",
  userAgent = "code-chat-api",
  maxPages = 20,
  fetchImpl = fetch,
}) {
  const repositories = [];
  const seenRepositories = new Set();
  let totalPages = Math.max(1, readPositiveInteger(maxPages) || 1);

  for (let page = 1; page <= totalPages; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/user/repos?per_page=${GITHUB_REPOSITORIES_PER_PAGE}&page=${page}&sort=updated&direction=desc&affiliation=owner,organization_member,collaborator`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${githubAccessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": userAgent,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
      },
    );

    let payload = {};
    try {
      payload = await response.clone().json();
    } catch {
      payload = {};
    }

    if (!response.ok) {
      return {
        ok: false,
        response: githubRepositoryListErrorResponse({
          response,
          payload: normalizeObject(payload),
          returnTo,
          defaultErrorPrefix: "Unable to list repositories",
        }),
      };
    }

    const parsedPayload = GITHUB_REPOSITORY_LIST_SCHEMA.safeParse(payload);
    if (!parsedPayload.success) {
      return {
        ok: false,
        response: Response.json(
          {
            ok: false,
            error: "GitHub returned an invalid repository list payload.",
          },
          { status: 502 },
        ),
      };
    }

    if (page === 1) {
      const lastPage = readGitHubLastPageNumber(response);
      if (lastPage > 0) {
        totalPages = Math.min(totalPages, lastPage);
      }
    }

    for (const repository of parsedPayload.data) {
      const fullName = normalizeRepository(repository.full_name);
      if (!fullName || repository.archived || repository.disabled) {
        continue;
      }
      if (requireWriteAccess && !repository.permissions.admin && !repository.permissions.push) {
        continue;
      }
      const repositoryKey = fullName.toLowerCase();
      if (seenRepositories.has(repositoryKey)) {
        continue;
      }
      seenRepositories.add(repositoryKey);
      repositories.push(fullName);
    }

    if (parsedPayload.data.length < GITHUB_REPOSITORIES_PER_PAGE) {
      break;
    }
  }

  return {
    ok: true,
    repositories: repositories.sort((left, right) => left.localeCompare(right)),
  };
}

function readGitHubTimestampMs(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeGitHubLabelRecord(value) {
  const normalized = normalizeObject(value);
  const name = normalizeText(normalized.name);
  if (!name) {
    return null;
  }
  return {
    name,
    color: normalizeText(normalized.color),
    description: normalizeText(normalized.description),
  };
}

function normalizeGitHubMilestoneRecord(value) {
  const normalized = normalizeObject(value);
  const number = readPositiveInteger(normalized.number);
  const title = normalizeText(normalized.title);
  if (!number || !title) {
    return null;
  }
  return {
    number,
    title,
    state: normalizeText(normalized.state).toLowerCase(),
    url: normalizeText(normalized.html_url || normalized.url),
    due_at: readGitHubTimestampMs(normalized.due_on),
  };
}

export function normalizeAssignableUserRecord(value) {
  const normalized = normalizeObject(value);
  const githubLogin = normalizeText(normalized.login);
  if (!githubLogin) {
    return null;
  }
  return {
    github_login: githubLogin,
    display_name: normalizeText(normalized.name) || githubLogin,
    avatar_url: normalizeText(normalized.avatar_url),
    profile_url: normalizeText(normalized.html_url || normalized.url),
  };
}

export function normalizeGitHubIssueDetailRecord(value, repository) {
  const normalized = normalizeObject(value);
  if (normalized.pull_request && typeof normalized.pull_request === "object") {
    return null;
  }

  const number = readPositiveInteger(normalized.number);
  const title = normalizeText(normalized.title);
  const url = normalizeText(normalized.html_url || normalized.url);
  if (!number || !title || !url) {
    return null;
  }

  const assignees = Array.isArray(normalized.assignees)
    ? normalized.assignees.map((entry) => normalizeAssignableUserRecord(entry)).filter(Boolean)
    : [];
  const labels = Array.isArray(normalized.labels)
    ? normalized.labels.map((entry) => normalizeGitHubLabelRecord(entry)).filter(Boolean)
    : [];

  return {
    repository,
    number,
    title,
    url,
    state: normalizeText(normalized.state).toLowerCase() || "open",
    body: normalizeText(normalized.body),
    author: normalizeAssignableUserRecord(normalized.user),
    assignees,
    labels,
    milestone: normalizeGitHubMilestoneRecord(normalized.milestone),
    comment_count: Number(normalized.comments || 0) || 0,
    created_at: readGitHubTimestampMs(normalized.created_at),
    updated_at: readGitHubTimestampMs(normalized.updated_at),
  };
}

export function normalizeGitHubIssueCommentRecord(value) {
  const normalized = normalizeObject(value);
  const id = normalizeText(normalized.id);
  const url = normalizeText(normalized.html_url || normalized.url);
  const body = normalizeText(normalized.body);
  if (!id || !url) {
    return null;
  }

  return {
    id,
    url,
    body,
    author: normalizeAssignableUserRecord(normalized.user),
    created_at: readGitHubTimestampMs(normalized.created_at),
    updated_at: readGitHubTimestampMs(normalized.updated_at),
  };
}

export function normalizeGitHubPullRequestDetailRecord(value, repository) {
  const normalized = normalizeObject(value);
  const head = normalizeObject(normalized.head);
  const base = normalizeObject(normalized.base);
  const headRepo = normalizeObject(head.repo);

  const number = readPositiveInteger(normalized.number);
  const title = normalizeText(normalized.title);
  const url = normalizeText(normalized.html_url || normalized.url);
  const headRef = normalizeBranchName(head.ref);
  const baseRef = normalizeBranchName(base.ref);
  if (!number || !title || !url || !headRef || !baseRef) {
    return null;
  }

  const assignees = Array.isArray(normalized.assignees)
    ? normalized.assignees.map((entry) => normalizeAssignableUserRecord(entry)).filter(Boolean)
    : [];
  const labels = Array.isArray(normalized.labels)
    ? normalized.labels.map((entry) => normalizeGitHubLabelRecord(entry)).filter(Boolean)
    : [];

  return {
    repository,
    number,
    title,
    url,
    state: normalizeText(normalized.state).toLowerCase() || "open",
    body: normalizeText(normalized.body),
    draft: Boolean(normalized.draft),
    author: normalizeAssignableUserRecord(normalized.user),
    assignees,
    labels,
    milestone: normalizeGitHubMilestoneRecord(normalized.milestone),
    comment_count: Number(normalized.comments || 0) || 0,
    created_at: readGitHubTimestampMs(normalized.created_at),
    updated_at: readGitHubTimestampMs(normalized.updated_at),
    head_ref: headRef,
    head_sha: normalizeText(head.sha).toLowerCase(),
    head_repository: normalizeRepository(headRepo.full_name || repository),
    base_ref: baseRef,
    base_sha: normalizeText(base.sha).toLowerCase(),
  };
}

function normalizeGitHubRepositoryMetadataRecord(value) {
  const payload = normalizeObject(value);
  const owner = normalizeObject(payload.owner);
  const ownerLogin = normalizeText(owner.login);
  const ownerNodeId = normalizeText(owner.node_id);
  const fullName = normalizeRepository(payload.full_name);
  const defaultBranch = normalizeBranchName(payload.default_branch);
  const repositoryName = normalizeText(payload.name);
  if (!fullName || !defaultBranch || !ownerLogin || !repositoryName) {
    return null;
  }
  return {
    id: normalizeText(payload.id),
    nodeId: normalizeText(payload.node_id),
    name: repositoryName,
    fullName,
    defaultBranch,
    ownerLogin,
    ownerNodeId,
    ownerType: normalizeText(owner.type) || "User",
    ownerAvatarUrl: normalizeText(owner.avatar_url),
    ownerProfileUrl: normalizeText(owner.html_url || owner.url),
  };
}

function normalizeGitHubPullRequestMetadataRecord(value, repository) {
  const payload = normalizeObject(value);
  const head = normalizeObject(payload.head);
  const base = normalizeObject(payload.base);
  const headRepo = normalizeObject(head.repo);
  const normalized = {
    number: readPositiveInteger(payload.number),
    title: normalizeText(payload.title),
    url: normalizeText(payload.html_url || payload.url),
    headRef: normalizeBranchName(head.ref),
    headSha: normalizeText(head.sha).toLowerCase(),
    headRepoFullName: normalizeRepository(headRepo.full_name || repository),
    baseRef: normalizeBranchName(base.ref),
    baseSha: normalizeText(base.sha).toLowerCase(),
  };
  if (!normalized.number || !normalized.headRef || !normalized.baseRef) {
    return null;
  }
  return normalized;
}

function normalizeGitHubIssueMetadataRecord(value, issueNumber) {
  const payload = normalizeObject(value);
  if (payload.pull_request && typeof payload.pull_request === "object") {
    return {
      ok: false,
      response: Response.json(
        {
          ok: false,
          error: `Issue reference must point to an issue, not pull request #${issueNumber}.`,
        },
        { status: 400 },
      ),
    };
  }
  const normalized = {
    number: readPositiveInteger(payload.number),
    title: normalizeText(payload.title),
    url: normalizeText(payload.html_url || payload.url),
  };
  if (!normalized.number || !normalized.title || !normalized.url) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: "GitHub issue metadata is incomplete." },
        { status: 502 },
      ),
    };
  }
  return {
    ok: true,
    issue: normalized,
  };
}

async function persistRepositoryAccess({
  githubLogin,
  repository,
  rememberRepositoryAccessImpl,
}) {
  if (typeof rememberRepositoryAccessImpl !== "function") {
    return;
  }
  const normalizedRepository = normalizeRepository(repository);
  if (!normalizedRepository) {
    return;
  }
  await rememberRepositoryAccessImpl({
    githubLogin: normalizeText(githubLogin),
    repository: normalizedRepository,
  });
}

function buildGitHubApiHeaders(githubAccessToken) {
  return {
    Authorization: `Bearer ${githubAccessToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "code-chat-api",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function fetchGitHubViewerEmail({ githubAccessToken }) {
  const headers = buildGitHubApiHeaders(githubAccessToken);
  const userResponse = await fetch("https://api.github.com/user", {
    method: "GET",
    headers,
    cache: "no-store",
  }).catch(() => null);
  if (userResponse?.ok) {
    const parsedUser = GITHUB_VIEWER_SCHEMA.safeParse(await toApiErrorPayload(userResponse));
    const userEmail = normalizeText(parsedUser.success ? parsedUser.data.email : "").toLowerCase();
    if (userEmail) {
      return userEmail;
    }
  }

  const emailsResponse = await fetch("https://api.github.com/user/emails", {
    method: "GET",
    headers,
    cache: "no-store",
  }).catch(() => null);
  if (!emailsResponse?.ok) {
    return "";
  }

  let rawPayload = [];
  try {
    rawPayload = await emailsResponse.json();
  } catch {
    rawPayload = [];
  }

  const parsedEmails = GITHUB_VIEWER_EMAIL_LIST_SCHEMA.safeParse(rawPayload);
  if (!parsedEmails.success) {
    return "";
  }

  const preferredEmail =
    parsedEmails.data.find((entry) => normalizeText(entry.email) && entry.primary && entry.verified) ||
    parsedEmails.data.find((entry) => normalizeText(entry.email) && entry.verified) ||
    parsedEmails.data.find((entry) => normalizeText(entry.email) && entry.primary) ||
    parsedEmails.data.find((entry) => normalizeText(entry.email)) ||
    null;
  return normalizeText(preferredEmail?.email || "").toLowerCase();
}

export async function fetchGitHubRepositoryMetadata({
  repository,
  githubAccessToken,
  githubLogin = "",
  returnTo = "/",
  rememberRepositoryAccessImpl,
}) {
  const normalizedRepository = normalizeRepository(repository);
  if (!normalizedRepository) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: "workspace_repository is invalid." },
        { status: 400 },
      ),
    };
  }

  const response = await fetch(
    `https://api.github.com/repos/${encodeRepositoryPath(normalizedRepository)}`,
    {
      method: "GET",
      headers: buildGitHubApiHeaders(githubAccessToken),
      cache: "no-store",
    },
  );
  const payload = await toApiErrorPayload(response);
  if (response.ok) {
    const normalizedMetadata = normalizeGitHubRepositoryMetadataRecord(payload);
    if (!normalizedMetadata) {
      return {
        ok: false,
        response: Response.json(
          { ok: false, error: "GitHub repository metadata is incomplete." },
          { status: 502 },
        ),
      };
    }
    await persistRepositoryAccess({
      githubLogin,
      repository: normalizedRepository,
      rememberRepositoryAccessImpl,
    });
    return {
      ok: true,
      repository: normalizedMetadata,
    };
  }

  return {
    ok: false,
    response: githubRepositoryAccessErrorResponse({
      repository: normalizedRepository,
      response,
      payload,
      returnTo,
      defaultErrorPrefix: "Unable to read GitHub repository metadata",
    }),
  };
}

export async function fetchGitHubPullRequestMetadata({
  repository,
  pullRequestNumber,
  githubAccessToken,
  githubLogin = "",
  returnTo = "/",
  rememberRepositoryAccessImpl,
}) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedPullRequestNumber = readPositiveInteger(pullRequestNumber);
  if (!normalizedRepository || !normalizedPullRequestNumber) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: "workspace_repository and pull_request_number are required." },
        { status: 400 },
      ),
    };
  }

  const response = await fetch(
    `https://api.github.com/repos/${encodeRepositoryPath(normalizedRepository)}/pulls/${encodeURIComponent(String(normalizedPullRequestNumber))}`,
    {
      method: "GET",
      headers: buildGitHubApiHeaders(githubAccessToken),
      cache: "no-store",
    },
  );
  const payload = await toApiErrorPayload(response);
  if (response.ok) {
    const normalizedPullRequest = normalizeGitHubPullRequestMetadataRecord(
      payload,
      normalizedRepository,
    );
    if (!normalizedPullRequest) {
      return {
        ok: false,
        response: Response.json(
          { ok: false, error: "GitHub pull request metadata is incomplete." },
          { status: 502 },
        ),
      };
    }
    await persistRepositoryAccess({
      githubLogin,
      repository: normalizedRepository,
      rememberRepositoryAccessImpl,
    });
    return {
      ok: true,
      pullRequest: normalizedPullRequest,
    };
  }
  if (response.status === 404) {
    return {
      ok: false,
      response: Response.json(
        {
          ok: false,
          error: `Pull request not found: ${normalizedRepository}#${normalizedPullRequestNumber}.`,
        },
        { status: 404 },
      ),
    };
  }

  return {
    ok: false,
    response: githubRepositoryAccessErrorResponse({
      repository: normalizedRepository,
      response,
      payload,
      returnTo,
      defaultErrorPrefix: "Unable to read GitHub pull request",
    }),
  };
}

export async function fetchGitHubIssueMetadata({
  repository,
  issueNumber,
  githubAccessToken,
  githubLogin = "",
  returnTo = "/",
  rememberRepositoryAccessImpl,
}) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedIssueNumber = readPositiveInteger(issueNumber);
  if (!normalizedRepository || !normalizedIssueNumber) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: "workspace_repository and issue_number are required." },
        { status: 400 },
      ),
    };
  }

  const response = await fetch(
    `https://api.github.com/repos/${encodeRepositoryPath(normalizedRepository)}/issues/${encodeURIComponent(String(normalizedIssueNumber))}`,
    {
      method: "GET",
      headers: buildGitHubApiHeaders(githubAccessToken),
      cache: "no-store",
    },
  );
  const payload = await toApiErrorPayload(response);
  if (response.ok) {
    const normalizedIssue = normalizeGitHubIssueMetadataRecord(
      payload,
      normalizedIssueNumber,
    );
    if (!normalizedIssue.ok) {
      return normalizedIssue;
    }
    await persistRepositoryAccess({
      githubLogin,
      repository: normalizedRepository,
      rememberRepositoryAccessImpl,
    });
    return normalizedIssue;
  }
  if (response.status === 404) {
    return {
      ok: false,
      response: Response.json(
        {
          ok: false,
          error: `Issue not found: ${normalizedRepository}#${normalizedIssueNumber}.`,
        },
        { status: 404 },
      ),
    };
  }

  return {
    ok: false,
    response: githubRepositoryAccessErrorResponse({
      repository: normalizedRepository,
      response,
      payload,
      returnTo,
      defaultErrorPrefix: "Unable to read GitHub issue",
    }),
  };
}

async function fetchGitHubIssueCommentsByNumber({
  repository,
  issueNumber,
  githubAccessToken,
  githubLogin = "",
  returnTo = "/",
  notFoundLabel = "Issue",
  rememberRepositoryAccessImpl,
}) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedIssueNumber = readPositiveInteger(issueNumber);
  if (!normalizedRepository || !normalizedIssueNumber) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: "workspace_repository and issue_number are required." },
        { status: 400 },
      ),
    };
  }

  const response = await fetch(
    `https://api.github.com/repos/${encodeRepositoryPath(normalizedRepository)}/issues/${encodeURIComponent(String(normalizedIssueNumber))}/comments?per_page=100`,
    {
      method: "GET",
      headers: buildGitHubApiHeaders(githubAccessToken),
      cache: "no-store",
    },
  );
  if (response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = [];
    }
    const comments = Array.isArray(payload)
      ? payload.map((entry) => normalizeGitHubIssueCommentRecord(entry)).filter(Boolean)
      : [];
    await persistRepositoryAccess({
      githubLogin,
      repository: normalizedRepository,
      rememberRepositoryAccessImpl,
    });
    return {
      ok: true,
      comments,
    };
  }

  const payload = await toApiErrorPayload(response);
  if (response.status === 404) {
    return {
      ok: false,
      response: Response.json(
        {
          ok: false,
          error: `${notFoundLabel} not found: ${normalizedRepository}#${normalizedIssueNumber}.`,
        },
        { status: 404 },
      ),
    };
  }

  return {
    ok: false,
    response: githubRepositoryAccessErrorResponse({
      repository: normalizedRepository,
      response,
      payload,
      returnTo,
      defaultErrorPrefix: `Unable to read GitHub ${notFoundLabel.toLowerCase()} comments`,
    }),
  };
}

export async function fetchGitHubIssueDetail({
  repository,
  issueNumber,
  githubAccessToken,
  githubLogin = "",
  returnTo = "/",
  rememberRepositoryAccessImpl,
}) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedIssueNumber = readPositiveInteger(issueNumber);
  if (!normalizedRepository || !normalizedIssueNumber) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: "workspace_repository and issue_number are required." },
        { status: 400 },
      ),
    };
  }

  const response = await fetch(
    `https://api.github.com/repos/${encodeRepositoryPath(normalizedRepository)}/issues/${encodeURIComponent(String(normalizedIssueNumber))}`,
    {
      method: "GET",
      headers: buildGitHubApiHeaders(githubAccessToken),
      cache: "no-store",
    },
  );
  const payload = await toApiErrorPayload(response);
  if (response.ok) {
    const issue = normalizeGitHubIssueDetailRecord(payload, normalizedRepository);
    if (!issue) {
      return {
        ok: false,
        response: Response.json(
          {
            ok: false,
            error: `Issue reference must point to an issue, not pull request #${normalizedIssueNumber}.`,
          },
          { status: 400 },
        ),
      };
    }
    await persistRepositoryAccess({
      githubLogin,
      repository: normalizedRepository,
      rememberRepositoryAccessImpl,
    });
    return {
      ok: true,
      issue,
    };
  }
  if (response.status === 404) {
    return {
      ok: false,
      response: Response.json(
        {
          ok: false,
          error: `Issue not found: ${normalizedRepository}#${normalizedIssueNumber}.`,
        },
        { status: 404 },
      ),
    };
  }

  return {
    ok: false,
    response: githubRepositoryAccessErrorResponse({
      repository: normalizedRepository,
      response,
      payload,
      returnTo,
      defaultErrorPrefix: "Unable to read GitHub issue",
    }),
  };
}

export async function fetchGitHubIssueComments({
  repository,
  issueNumber,
  githubAccessToken,
  githubLogin = "",
  returnTo = "/",
  rememberRepositoryAccessImpl,
}) {
  return await fetchGitHubIssueCommentsByNumber({
    repository,
    issueNumber,
    githubAccessToken,
    githubLogin,
    returnTo,
    rememberRepositoryAccessImpl,
  });
}

export async function fetchGitHubPullRequestDetail({
  repository,
  pullRequestNumber,
  githubAccessToken,
  githubLogin = "",
  returnTo = "/",
  rememberRepositoryAccessImpl,
}) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedPullRequestNumber = readPositiveInteger(pullRequestNumber);
  if (!normalizedRepository || !normalizedPullRequestNumber) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: "workspace_repository and pull_request_number are required." },
        { status: 400 },
      ),
    };
  }

  const response = await fetch(
    `https://api.github.com/repos/${encodeRepositoryPath(normalizedRepository)}/pulls/${encodeURIComponent(String(normalizedPullRequestNumber))}`,
    {
      method: "GET",
      headers: buildGitHubApiHeaders(githubAccessToken),
      cache: "no-store",
    },
  );
  const payload = await toApiErrorPayload(response);
  if (response.ok) {
    const pullRequest = normalizeGitHubPullRequestDetailRecord(payload, normalizedRepository);
    if (!pullRequest) {
      return {
        ok: false,
        response: Response.json(
          { ok: false, error: "GitHub pull request payload is invalid." },
          { status: 502 },
        ),
      };
    }
    await persistRepositoryAccess({
      githubLogin,
      repository: normalizedRepository,
      rememberRepositoryAccessImpl,
    });
    return {
      ok: true,
      pullRequest,
    };
  }
  if (response.status === 404) {
    return {
      ok: false,
      response: Response.json(
        {
          ok: false,
          error: `Pull request not found: ${normalizedRepository}#${normalizedPullRequestNumber}.`,
        },
        { status: 404 },
      ),
    };
  }

  return {
    ok: false,
    response: githubRepositoryAccessErrorResponse({
      repository: normalizedRepository,
      response,
      payload,
      returnTo,
      defaultErrorPrefix: "Unable to read GitHub pull request",
    }),
  };
}

export async function fetchGitHubPullRequestComments({
  repository,
  pullRequestNumber,
  githubAccessToken,
  githubLogin = "",
  returnTo = "/",
  rememberRepositoryAccessImpl,
}) {
  return await fetchGitHubIssueCommentsByNumber({
    repository,
    issueNumber: pullRequestNumber,
    githubAccessToken,
    githubLogin,
    returnTo,
    notFoundLabel: "Pull request",
    rememberRepositoryAccessImpl,
  });
}

export function readGitHubLastPageNumber(response) {
  const linkHeader = normalizeText(response.headers.get("link"));
  if (!linkHeader) {
    return 0;
  }
  const segments = linkHeader.split(",");
  for (const segment of segments) {
    if (!segment.includes('rel="last"')) {
      continue;
    }
    const match = segment.match(/<([^>]+)>/);
    if (!match?.[1]) {
      continue;
    }
    try {
      const url = new URL(match[1]);
      const page = readPositiveInteger(url.searchParams.get("page") || "");
      if (page > 0) {
        return page;
      }
    } catch {
      continue;
    }
  }
  return 0;
}

export function normalizeGitHubPullRequestCommit(value) {
  const normalized = normalizeObject(value);
  const commit = normalizeObject(normalized.commit);
  const commitAuthor = normalizeObject(commit.author);
  const commitCommitter = normalizeObject(commit.committer);
  const author = normalizeObject(normalized.author);
  const committer = normalizeObject(normalized.committer);
  const sha = normalizeText(normalized.sha).toLowerCase();
  const message = normalizeText(commit.message);
  if (!sha || !message) {
    return null;
  }

  const messageHeadline = normalizeText(message.split(/\r?\n/, 1)[0] || message);
  const authorLogin =
    normalizeText(author.login) || normalizeText(committer.login);
  const authorDisplayName =
    normalizeText(commitAuthor.name) || authorLogin || "Unknown author";
  const authorAvatarUrl =
    normalizeText(author.avatar_url) || normalizeText(committer.avatar_url);
  const authorProfileUrl =
    normalizeText(author.html_url || author.url) ||
    normalizeText(committer.html_url || committer.url);
  const committedAt = Date.parse(
    normalizeText(commitAuthor.date) || normalizeText(commitCommitter.date),
  );

  return {
    sha,
    messageHeadline: messageHeadline || sha.slice(0, 7),
    url: normalizeText(normalized.html_url || normalized.url),
    committedAt: Number.isFinite(committedAt) && committedAt > 0 ? committedAt : 0,
    authorLogin,
    authorDisplayName,
    authorAvatarUrl,
    authorProfileUrl,
  };
}

export async function fetchGitHubPullRequestCommitMetadata({
  repository,
  pullRequestNumber,
  githubAccessToken,
  githubLogin = "",
  returnTo = "/",
  limit = 250,
  rememberRepositoryAccessImpl,
}) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedPullRequestNumber = readPositiveInteger(pullRequestNumber);
  const normalizedLimit = Math.max(1, Math.min(250, readPositiveInteger(limit) || 250));
  if (!normalizedRepository || !normalizedPullRequestNumber) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: "workspace_repository and pull_request_number are required." },
        { status: 400 },
      ),
    };
  }

  const baseUrl = `https://api.github.com/repos/${encodeRepositoryPath(normalizedRepository)}/pulls/${encodeURIComponent(String(normalizedPullRequestNumber))}/commits`;
  const headers = buildGitHubApiHeaders(githubAccessToken);
  const probeResponse = await fetch(
    `${baseUrl}?per_page=1&page=1`,
    {
      method: "GET",
      headers,
      cache: "no-store",
    },
  );
  if (!probeResponse.ok) {
    const payload = await toApiErrorPayload(probeResponse);
    if (probeResponse.status === 404) {
      return {
        ok: false,
        response: Response.json(
          {
            ok: false,
            error: `Pull request not found: ${normalizedRepository}#${normalizedPullRequestNumber}.`,
          },
          { status: 404 },
        ),
      };
    }
    return {
      ok: false,
      response: githubRepositoryAccessErrorResponse({
        repository: normalizedRepository,
        response: probeResponse,
        payload,
        returnTo,
        defaultErrorPrefix: "Unable to read GitHub pull request commits",
      }),
    };
  }

  const lastPage = readGitHubLastPageNumber(probeResponse) || 1;
  const pagesToFetch = Math.max(1, Math.ceil(normalizedLimit / 100));
  const startPage = Math.max(1, lastPage - pagesToFetch + 1);
  const commits = [];

  for (let page = startPage; page <= lastPage; page += 1) {
    const response = await fetch(
      `${baseUrl}?per_page=100&page=${encodeURIComponent(String(page))}`,
      {
        method: "GET",
        headers,
        cache: "no-store",
      },
    );

    if (!response.ok) {
      const payload = await toApiErrorPayload(response);
      if (response.status === 404) {
        return {
          ok: false,
          response: Response.json(
            {
              ok: false,
              error: `Pull request not found: ${normalizedRepository}#${normalizedPullRequestNumber}.`,
            },
            { status: 404 },
          ),
        };
      }
      return {
        ok: false,
        response: githubRepositoryAccessErrorResponse({
          repository: normalizedRepository,
          response,
          payload,
          returnTo,
          defaultErrorPrefix: "Unable to read GitHub pull request commits",
        }),
      };
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = [];
    }
    if (!Array.isArray(payload)) {
      return {
        ok: false,
        response: Response.json(
          { ok: false, error: "GitHub pull request commits payload is invalid." },
          { status: 502 },
        ),
      };
    }

    const parsedCommits = payload
      .map((entry) => normalizeGitHubPullRequestCommit(entry))
      .filter(Boolean);
    commits.push(...parsedCommits);
  }

  await persistRepositoryAccess({
    githubLogin,
    repository: normalizedRepository,
    rememberRepositoryAccessImpl,
  });
  return {
    ok: true,
    commits: commits.slice(-normalizedLimit),
  };
}

export async function fetchGitHubRepositoryAssignees({
  repository,
  githubAccessToken,
  githubLogin = "",
  returnTo = "/",
  rememberRepositoryAccessImpl,
}) {
  const normalizedRepository = normalizeRepository(repository);
  if (!normalizedRepository) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: "workspace_repository is invalid." },
        { status: 400 },
      ),
    };
  }

  const response = await fetch(
    `https://api.github.com/repos/${encodeRepositoryPath(normalizedRepository)}/assignees?per_page=100`,
    {
      method: "GET",
      headers: buildGitHubApiHeaders(githubAccessToken),
      cache: "no-store",
    },
  );
  if (response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = [];
    }
    await persistRepositoryAccess({
      githubLogin,
      repository: normalizedRepository,
      rememberRepositoryAccessImpl,
    });
    const assignees = Array.isArray(payload)
      ? payload.map((entry) => normalizeAssignableUserRecord(entry)).filter(Boolean)
      : [];
    return {
      ok: true,
      assignees,
    };
  }

  const payload = await toApiErrorPayload(response);

  return {
    ok: false,
    response: githubRepositoryAccessErrorResponse({
      repository: normalizedRepository,
      response,
      payload,
      returnTo,
      defaultErrorPrefix: "Unable to load assignable GitHub users",
    }),
  };
}
