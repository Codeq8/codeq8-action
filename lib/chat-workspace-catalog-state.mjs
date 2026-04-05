const WORKSPACE_CATALOG_KIND_FULL = "full";
const WORKSPACE_CATALOG_KIND_SELECTION_ONLY = "selection_only";
const WORKSPACE_CATALOG_KIND_NONE = "none";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function payloadObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function hasSelectionSnapshot({
  repositories = [],
  repositoryRecords = [],
  selectedRepository = "",
  selectedRepositoryRecord = null,
  selectedWorkspace = "",
  workspaces = [],
} = {}) {
  return Boolean(
    normalizeText(selectedWorkspace) ||
      normalizeText(selectedRepository) ||
      selectedRepositoryRecord ||
      (Array.isArray(workspaces) ? workspaces.length : 0) > 0 ||
      (Array.isArray(repositoryRecords) ? repositoryRecords.length : 0) > 0 ||
      (Array.isArray(repositories) ? repositories.length : 0) > 0,
  );
}

function resolveLegacyWorkspacePayloadCatalogKind({
  repositories = [],
  repositoryRecords = [],
  selectedRepository = "",
  selectedRepositoryRecord = null,
  selectedWorkspace = "",
  workspaces = [],
} = {}) {
  return hasSelectionSnapshot({
    repositories,
    repositoryRecords,
    selectedRepository,
    selectedRepositoryRecord,
    selectedWorkspace,
    workspaces,
  })
    ? WORKSPACE_CATALOG_KIND_SELECTION_ONLY
    : WORKSPACE_CATALOG_KIND_NONE;
}

export function normalizeWorkspaceCatalogKind(value) {
  const normalizedValue = normalizeText(value).toLowerCase();
  if (normalizedValue === WORKSPACE_CATALOG_KIND_FULL) {
    return WORKSPACE_CATALOG_KIND_FULL;
  }
  if (normalizedValue === WORKSPACE_CATALOG_KIND_SELECTION_ONLY) {
    return WORKSPACE_CATALOG_KIND_SELECTION_ONLY;
  }
  return WORKSPACE_CATALOG_KIND_NONE;
}

export function requireWorkspaceCatalogKind(
  value,
  label = "workspace catalog kind",
) {
  const normalizedValue = normalizeText(value).toLowerCase();
  if (
    normalizedValue === WORKSPACE_CATALOG_KIND_FULL ||
    normalizedValue === WORKSPACE_CATALOG_KIND_SELECTION_ONLY ||
    normalizedValue === WORKSPACE_CATALOG_KIND_NONE
  ) {
    return normalizedValue;
  }
  throw new Error(
    `${String(label || "workspace catalog kind").trim() || "workspace catalog kind"} must be explicit and one of: full, selection_only, none.`,
  );
}

export function workspaceCatalogKindHasFullCatalog(value) {
  return normalizeWorkspaceCatalogKind(value) === WORKSPACE_CATALOG_KIND_FULL;
}

export function workspacePayloadHasExplicitCatalogBoundary(payload) {
  return Boolean(
    "repository_catalog_kind" in payloadObject(payload),
  );
}

export function resolveWorkspacePayloadCatalogKind(
  payload,
  {
    fallbackRepositoryCatalogKind = "",
  } = {},
) {
  const normalizedPayload = payloadObject(payload);
  const hasExplicitRepositoryCatalogKind =
    Object.prototype.hasOwnProperty.call(normalizedPayload, "repository_catalog_kind");
  if (hasExplicitRepositoryCatalogKind) {
    return requireWorkspaceCatalogKind(
      normalizedPayload.repository_catalog_kind,
      "workspace payload repository_catalog_kind",
    );
  }
  const explicitFallbackRepositoryCatalogKind = normalizeText(fallbackRepositoryCatalogKind);
  if (explicitFallbackRepositoryCatalogKind) {
    return requireWorkspaceCatalogKind(
      fallbackRepositoryCatalogKind,
      "workspace payload fallbackRepositoryCatalogKind",
    );
  }

  return resolveLegacyWorkspacePayloadCatalogKind({
    repositories: Array.isArray(normalizedPayload.repositories)
      ? normalizedPayload.repositories
      : [],
    repositoryRecords: Array.isArray(normalizedPayload.repository_records)
      ? normalizedPayload.repository_records
      : [],
    selectedRepository: normalizeText(normalizedPayload.selected_repository),
    selectedRepositoryRecord: normalizedPayload.selected_repository_record || null,
    selectedWorkspace: normalizeText(normalizedPayload.selected_workspace),
    workspaces: Array.isArray(normalizedPayload.workspaces)
      ? normalizedPayload.workspaces
      : [],
  });
}

function workspacePayloadHasCatalogArrays(payload) {
  const normalizedPayload = payloadObject(payload);
  return (
    Array.isArray(normalizedPayload.workspaces) &&
    Array.isArray(normalizedPayload.repository_records) &&
    (!Object.prototype.hasOwnProperty.call(normalizedPayload, "repositories") ||
      Array.isArray(normalizedPayload.repositories))
  );
}

export function workspacePayloadHasUsableFullCatalog(
  payload,
  {
    fallbackRepositoryCatalogKind = "",
  } = {},
) {
  const repositoryCatalogKind = resolveWorkspacePayloadCatalogKind(payload, {
    fallbackRepositoryCatalogKind,
  });
  if (!workspaceCatalogKindHasFullCatalog(repositoryCatalogKind)) {
    return false;
  }
  if (!workspacePayloadHasExplicitCatalogBoundary(payload)) {
    return true;
  }
  return workspacePayloadHasCatalogArrays(payload);
}

export function serializeWorkspaceCatalogKind({
  repositoryCatalogKind,
  includeRepositoryCatalog = true,
  repositories = [],
  repositoryRecords = [],
  selectedRepository = "",
  selectedRepositoryRecord = null,
  selectedWorkspace = "",
  workspaces = [],
} = {}) {
  const normalizedRepositoryCatalogKind = requireWorkspaceCatalogKind(
    repositoryCatalogKind,
    "workspace state repositoryCatalogKind",
  );
  if (
    normalizedRepositoryCatalogKind !== WORKSPACE_CATALOG_KIND_FULL ||
    Boolean(includeRepositoryCatalog)
  ) {
    return normalizedRepositoryCatalogKind;
  }

  return hasSelectionSnapshot({
    repositories,
    repositoryRecords,
    selectedRepository,
    selectedRepositoryRecord,
    selectedWorkspace,
    workspaces,
  })
    ? WORKSPACE_CATALOG_KIND_SELECTION_ONLY
    : WORKSPACE_CATALOG_KIND_NONE;
}

export {
  WORKSPACE_CATALOG_KIND_FULL,
  WORKSPACE_CATALOG_KIND_NONE,
  WORKSPACE_CATALOG_KIND_SELECTION_ONLY,
};
