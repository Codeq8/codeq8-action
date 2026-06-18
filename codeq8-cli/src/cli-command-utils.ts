import process from "node:process";

export type ConsumedOption = {
  value: string;
  args: string[];
};

export type ConsumedRepeatedOptions = {
  values: string[];
  args: string[];
};

export type ConsumedBodyOption = {
  body: string;
  hasBody: boolean;
  args: string[];
};

export type ConsumedRepoOption = {
  repository: string;
  args: string[];
};

export function normalize(value: unknown): string {
  return String(value ?? "").trim();
}

export function print(message = ""): void {
  process.stdout.write(`${message}\n`);
}

export function printError(message: unknown): void {
  process.stderr.write(`codeq8: ${message}\n`);
}

export function parseFlag(args: readonly string[], names: readonly string[]): boolean {
  return args.some((arg) => names.includes(arg));
}

export function consumeOption(args: readonly string[], name: string): ConsumedOption {
  const index = args.indexOf(name);
  if (index < 0) {
    return { value: "", args: [...args] };
  }
  if (index + 1 >= args.length) {
    throw new Error(`${name} requires a value.`);
  }
  const value = normalize(args[index + 1]);
  const next = args.slice(0, index).concat(args.slice(index + 2));
  return { value, args: next };
}

export function consumeAllOptions(args: readonly string[], name: string): ConsumedOption {
  let nextArgs = args.slice();
  let lastValue = "";
  while (nextArgs.includes(name)) {
    const consumed = consumeOption(nextArgs, name);
    lastValue = consumed.value;
    nextArgs = consumed.args;
  }
  return { value: lastValue, args: nextArgs };
}

export function consumeAllOptionsByNames(
  args: readonly string[],
  names: readonly string[],
): ConsumedOption {
  let nextArgs = args.slice();
  let lastValue = "";
  for (const name of names) {
    const consumed = consumeAllOptions(nextArgs, name);
    if (consumed.value !== "") {
      lastValue = consumed.value;
    }
    nextArgs = consumed.args;
  }
  return { value: lastValue, args: nextArgs };
}

export function consumeRepeatedOptions(
  args: readonly string[],
  names: readonly string[],
): ConsumedRepeatedOptions {
  let nextArgs = args.slice();
  const values: string[] = [];
  while (true) {
    let consumedAny = false;
    for (const name of names) {
      if (!nextArgs.includes(name)) {
        continue;
      }
      const consumed = consumeOption(nextArgs, name);
      if (normalize(consumed.value)) {
        values.push(normalize(consumed.value));
      }
      nextArgs = consumed.args;
      consumedAny = true;
      break;
    }
    if (!consumedAny) {
      break;
    }
  }
  return { values, args: nextArgs };
}

export function parsePositiveInteger(value: unknown, fallback = 0): number {
  const parsed = Number.parseInt(normalize(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
    });
    process.stdin.on("end", () => {
      resolve(buffer);
    });
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}

export function formatTimestamp(value: unknown): string {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }
  return new Date(numeric).toISOString();
}

export function extractError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    return normalize(record.error) || fallback;
  }
  return fallback;
}

export function resolveWorkspaceRepository(repository = ""): string {
  return normalize(repository) || normalize(process.env.CODE_WORKSPACE_REPOSITORY);
}

export function readOptionalMilestone(value: unknown): number | null | undefined {
  const normalized = normalize(value).toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "0" || normalized === "none" || normalized === "null") {
    return null;
  }
  const parsed = parsePositiveInteger(normalized, 0);
  return parsed > 0 ? parsed : undefined;
}

export function consumeRepoOption(
  args: readonly string[],
): ConsumedRepoOption {
  let nextArgs = args.slice();
  let repository = "";
  for (const flag of ["--repo", "--repository", "--workspace-repository", "--workspace_repository"]) {
    if (nextArgs.includes(flag)) {
      const consumed = consumeOption(nextArgs, flag);
      repository = consumed.value;
      nextArgs = consumed.args;
    }
  }
  return { repository: normalize(repository), args: nextArgs };
}

export function consumeGithubBodyOption(args: readonly string[]): ConsumedBodyOption {
  let nextArgs = args.slice();
  let body = "";
  let hasBody = false;
  for (const flag of ["--body"]) {
    if (nextArgs.includes(flag)) {
      const consumed = consumeOption(nextArgs, flag);
      body = consumed.value;
      nextArgs = consumed.args;
      hasBody = true;
    }
  }
  return { body: normalize(body), hasBody, args: nextArgs };
}
