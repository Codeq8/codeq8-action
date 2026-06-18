export type ApiJsonResponse = {
  ok: boolean;
  status: number;
  payload: Record<string, unknown> | null;
};

export type ApiJsonRequestOptions = {
  baseUrl?: string;
  path: string;
  method?: string;
  token?: string;
  query?: Record<string, unknown> | null;
  body?: unknown;
};

export type AuthedApiJsonRequestOptions = Omit<ApiJsonRequestOptions, "token"> & {
  autoLogin?: boolean;
};

export type AuthedApiJsonRequest = (
  options: AuthedApiJsonRequestOptions,
) => Promise<ApiJsonResponse>;

export type CommandContext = {
  baseUrl?: string;
  authedApiJsonRequest: AuthedApiJsonRequest;
};

export type BaseCommandContext = {
  baseUrl?: string;
};

export type AuthState = {
  token: string;
  tokenType: string;
  baseUrl: string;
  createdAt: string;
  backend?: "file" | "keychain";
};

export type AuthWriteOptions = {
  token?: string;
  tokenType?: string;
  baseUrl?: string;
};
