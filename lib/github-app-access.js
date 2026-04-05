import {
  requireWorkspaceCatalogKind,
  workspaceCatalogKindHasFullCatalog,
} from "./chat-workspace-catalog-state.mjs";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function repositoryOwner(repository) {
  const normalizedRepository = normalizeText(repository);
  if (!normalizedRepository) {
    return "";
  }
  const [owner] = normalizedRepository.split("/", 1);
  return normalizeText(owner);
}

function defaultGitHubAppActionLabel(organizationSlug) {
  const normalizedOrganizationSlug = normalizeText(organizationSlug);
  return normalizedOrganizationSlug
    ? `Grant ${normalizedOrganizationSlug} org access`
    : "Grant GitHub app access";
}

function defaultGitHubAppActionRequired({ repository = "", organizationSlug = "" } = {}) {
  const normalizedRepository = normalizeText(repository);
  const normalizedOrganizationSlug =
    normalizeText(organizationSlug) || repositoryOwner(normalizedRepository);
  if (normalizedRepository && normalizedOrganizationSlug) {
    return `Install the GitHub App on ${normalizedRepository} or grant ${normalizedOrganizationSlug} organization access, then retry.`;
  }
  if (normalizedRepository) {
    return `Install the GitHub App on ${normalizedRepository}, then retry.`;
  }
  if (normalizedOrganizationSlug) {
    return `Grant ${normalizedOrganizationSlug} organization access for the GitHub App, then retry.`;
  }
  return "Install the GitHub App on a configured repository, then retry.";
}

function inferSetupMode({ actionRequired = "", errorMessage = "" } = {}) {
  const combined = `${normalizeText(actionRequired)} ${normalizeText(errorMessage)}`.toLowerCase();
  return combined.includes("sso") ? "sso" : "install";
}

export const GITHUB_OAUTH_CLIENT_ID = "Iv23li5Seilv0LfMeooD";
export const GITHUB_OAUTH_APP_SETTINGS_URL =
  `https://github.com/settings/connections/applications/${GITHUB_OAUTH_CLIENT_ID}`;

export function resolveGitHubActionState(payload) {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const reloginUrl = normalizeText(record.link_url);
  if (reloginUrl) {
    return {
      actionKind: "login",
      actionUrl: reloginUrl,
      actionLabel: "Re-login with GitHub",
      actionRequired: "Reauthenticate with GitHub to refresh the session.",
      organizationSlug: "",
    };
  }

  if (normalizeText(record.error_code).toLowerCase() === "repository_missing") {
    return {
      actionKind: "repository_missing",
      actionUrl: "",
      actionLabel: "",
      actionRequired: "",
      organizationSlug: "",
    };
  }

  const appSettingsUrl = normalizeText(record.github_app_settings_url);
  const organizationSlug = normalizeText(record.organization_slug);
  if (appSettingsUrl) {
    return {
      actionKind: "github_app_access",
      actionUrl: appSettingsUrl,
      actionLabel: defaultGitHubAppActionLabel(organizationSlug),
      actionRequired:
        normalizeText(record.action_required) ||
        defaultGitHubAppActionRequired({ organizationSlug }),
      organizationSlug,
    };
  }

  return {
    actionKind: "none",
    actionUrl: "",
    actionLabel: "",
    actionRequired: "",
    organizationSlug: "",
  };
}

export function createGenericGitHubAppAccessState({ repository = "", organizationSlug = "" } = {}) {
  const normalizedRepository = normalizeText(repository);
  const normalizedOrganizationSlug =
    normalizeText(organizationSlug) || repositoryOwner(normalizedRepository);
  return {
    actionKind: "github_app_access",
    actionUrl: GITHUB_OAUTH_APP_SETTINGS_URL,
    actionLabel: defaultGitHubAppActionLabel(normalizedOrganizationSlug),
    actionRequired: defaultGitHubAppActionRequired({
      repository: normalizedRepository,
      organizationSlug: normalizedOrganizationSlug,
    }),
    organizationSlug: normalizedOrganizationSlug,
  };
}

export function resolveGitHubAppSetupState({
  authenticated = false,
  repositoryCatalogKind,
  repositories = [],
  selectedRepository = "",
  errorMessage = "",
  actionKind = "none",
  actionUrl = "",
  actionLabel = "",
  actionRequired = "",
  organizationSlug = "",
} = {}) {
  const normalizedRepositoryCatalogKind = requireWorkspaceCatalogKind(
    repositoryCatalogKind,
    "resolveGitHubAppSetupState repositoryCatalogKind",
  );
  if (actionKind === "repository_missing") {
    return null;
  }

  const normalizedRepository = normalizeText(selectedRepository);
  const normalizedRepositories = Array.isArray(repositories)
    ? repositories.map((entry) => normalizeText(entry)).filter(Boolean)
    : [];
  const normalizedOrganizationSlug =
    normalizeText(organizationSlug) || repositoryOwner(normalizedRepository);
  const hasFullCatalog = workspaceCatalogKindHasFullCatalog(normalizedRepositoryCatalogKind);
  const missingRepositories =
    Boolean(authenticated) && hasFullCatalog && normalizedRepositories.length === 0;
  if (actionKind !== "github_app_access" && !missingRepositories) {
    return null;
  }

  const fallbackAction = createGenericGitHubAppAccessState({
    repository: normalizedRepository,
    organizationSlug: normalizedOrganizationSlug,
  });
  const mode = inferSetupMode({
    actionRequired,
    errorMessage,
  });
  const detail =
    normalizeText(actionRequired) ||
    (missingRepositories && actionKind !== "github_app_access"
      ? "No writable repositories are available yet. Install the GitHub App on a configured repository or ask an admin to add one."
      : "") ||
    fallbackAction.actionRequired;
  const targetLabel = normalizedRepository || normalizedOrganizationSlug;

  if (mode === "sso") {
    return {
      title: normalizedRepository
        ? `Authorize GitHub access for ${normalizedRepository}`
        : "Authorize GitHub access",
      summary: normalizedRepository
        ? `GitHub requires SSO authorization before Codeq8 can open ${normalizedRepository}.`
        : "GitHub requires SSO authorization before Codeq8 can list repositories for this account.",
      detail,
      statusLabel: "SSO authorization required",
      targetLabel,
      primaryActionUrl: normalizeText(actionUrl) || fallbackAction.actionUrl,
      primaryActionLabel: normalizeText(actionLabel) || "Authorize in GitHub",
      steps: [
        normalizedOrganizationSlug
          ? `Open GitHub and authorize SSO for ${normalizedOrganizationSlug}.`
          : "Open GitHub and authorize SSO for this account.",
        normalizedRepository
          ? `Confirm ${normalizedRepository} is included in the app installation.`
          : "Confirm the required repositories are included in the app installation.",
        "Return to Codeq8 and retry loading repositories.",
      ],
    };
  }

  return {
    title: normalizedRepository
      ? `Finish GitHub setup for ${normalizedRepository}`
      : "Finish GitHub setup",
    summary: normalizedRepository
      ? `Codeq8 can't access ${normalizedRepository} until GitHub App access is configured.`
      : missingRepositories
        ? "Codeq8 couldn't find a writable repository for this GitHub account yet."
        : "Codeq8 needs GitHub App access before it can load a repository here.",
    detail,
    statusLabel: missingRepositories ? "No accessible repositories" : "Repository access required",
    targetLabel,
    primaryActionUrl: normalizeText(actionUrl) || fallbackAction.actionUrl,
    primaryActionLabel: normalizeText(actionLabel) || fallbackAction.actionLabel,
    steps: [
      "Open the GitHub App access settings.",
      normalizedRepository
        ? normalizedOrganizationSlug
          ? `Install the app on ${normalizedRepository} or grant ${normalizedOrganizationSlug} organization access.`
          : `Install the app on ${normalizedRepository}.`
        : normalizedOrganizationSlug
          ? `Grant ${normalizedOrganizationSlug} organization access or install the app on a configured repository.`
          : "Install the app on at least one repository that is configured in Codeq8.",
      "Return to Codeq8 and retry loading repositories.",
    ],
  };
}
