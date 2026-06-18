import {
  consumeAllOptions,
  consumeAllOptionsByNames,
  consumeRepoOption,
  extractError,
  normalize,
  parseFlag,
  parsePositiveInteger,
  print,
  printError,
  readStdinText,
  resolveWorkspaceRepository,
} from "./cli-command-utils.js";
import { renderChatHelp, renderChatThreadHelp } from "./cli-help.js";
import {
  printChatThreadCreateText,
  printChatThreadListText,
  printChatThreadMessagesText,
  printChatThreadSendText,
  printChatThreadText,
  printThreadMutationText,
} from "./cli-renderers.js";
import type { CommandContext } from "./cli-types.js";

export async function handleChat(
  args: string[],
  { baseUrl, authedApiJsonRequest }: CommandContext,
): Promise<number> {
  const [resource = "", ...rest] = args;
  if (!resource || resource === "--help" || resource === "-h") {
    print(renderChatHelp());
    return 0;
  }
  if (resource !== "thread") {
    throw new Error(renderChatHelp());
  }

  const [subcommand = "", ...subcommandArgs] = rest;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    print(renderChatThreadHelp());
    return 0;
  }

  if (subcommand === "list") {
    let options = subcommandArgs.slice();
    const repoConsumed = consumeRepoOption(options);
    const repository = resolveWorkspaceRepository(repoConsumed.repository);
    options = repoConsumed.args;
    const statusConsumed = consumeAllOptions(options, "--status");
    options = statusConsumed.args;
    const limitConsumed = consumeAllOptions(options, "--limit");
    options = limitConsumed.args;
    const beforeUpdatedAtConsumed = consumeAllOptions(options, "--before-updated-at");
    options = beforeUpdatedAtConsumed.args;
    const beforeThreadIdConsumed = consumeAllOptions(options, "--before-thread-id");
    options = beforeThreadIdConsumed.args;
    const json = parseFlag(options, ["--json"]);
    options = options.filter((arg) => arg !== "--json");

    if (!repository) {
      throw new Error("chat thread list requires --repo <owner/repo>.");
    }
    if (options.length > 0) {
      throw new Error(`Unknown chat thread list option: ${options[0]}`);
    }

    const response = await authedApiJsonRequest({
      baseUrl,
      path: "/api/cli/chat/threads",
      method: "GET",
      query: {
        workspace_repository: repository,
        status: normalize(statusConsumed.value).toLowerCase(),
        limit: parsePositiveInteger(limitConsumed.value, 50),
        before_updated_at: normalize(beforeUpdatedAtConsumed.value),
        before_thread_id: normalize(beforeThreadIdConsumed.value),
      },
      autoLogin: !json,
    });
    if (!response.ok) {
      printError(extractError(response.payload, `Unable to list threads (${response.status}).`));
      return 1;
    }

    if (json) {
      print(JSON.stringify(response.payload, null, 2));
      return 0;
    }

    printChatThreadListText(response.payload);
    return 0;
  }

  if (subcommand === "create") {
    let options = subcommandArgs.slice();
    const repoConsumed = consumeRepoOption(options);
    const repository = resolveWorkspaceRepository(repoConsumed.repository);
    options = repoConsumed.args;
    const titleConsumed = consumeAllOptions(options, "--title");
    options = titleConsumed.args;
    const sourceTypeConsumed = consumeAllOptionsByNames(options, ["--source-type", "--source_type"]);
    options = sourceTypeConsumed.args;
    const branchConsumed = consumeAllOptionsByNames(options, [
      "--branch",
      "--context-branch",
      "--context_branch",
    ]);
    options = branchConsumed.args;
    const pullRequestConsumed = consumeAllOptionsByNames(options, [
      "--pull-request",
      "--pull_request",
      "--pr",
    ]);
    options = pullRequestConsumed.args;
    const issueConsumed = consumeAllOptionsByNames(options, [
      "--issue",
      "--origin-issue",
      "--origin_issue",
    ]);
    options = issueConsumed.args;
    const json = parseFlag(options, ["--json"]);
    options = options.filter((arg) => arg !== "--json");

    const explicitSourceType = normalize(sourceTypeConsumed.value).toLowerCase().replace(/-/g, "_");
    const branch = normalize(branchConsumed.value);
    const pullRequest = normalize(pullRequestConsumed.value);
    const issue = normalize(issueConsumed.value);
    if (
      explicitSourceType &&
      !["default_branch", "branch", "pull_request"].includes(explicitSourceType)
    ) {
      throw new Error(
        "chat thread create --source-type must be default_branch, branch, or pull_request.",
      );
    }
    const sourceType =
      explicitSourceType ||
      (pullRequest ? "pull_request" : branch ? "branch" : "default_branch");
    const canInferRepositoryFromPullRequest =
      sourceType === "pull_request" && /^https?:\/\//i.test(pullRequest);

    if (!repository && !canInferRepositoryFromPullRequest) {
      throw new Error(
        "chat thread create requires --repo <owner/repo>, CODE_WORKSPACE_REPOSITORY, or a pull request URL.",
      );
    }
    if (sourceType === "branch" && !branch) {
      throw new Error("chat thread create requires --branch <name> for branch threads.");
    }
    if (sourceType === "pull_request" && !pullRequest) {
      throw new Error("chat thread create requires --pull-request <n|url> for pull request threads.");
    }
    if (options.length > 0) {
      throw new Error(`Unknown chat thread create option: ${options[0]}`);
    }

    const body = {
      ...(repository ? { repository } : {}),
      ...(normalize(titleConsumed.value) ? { title: normalize(titleConsumed.value) } : {}),
      source_type: sourceType,
      ...(branch ? { branch } : {}),
      ...(pullRequest ? { pull_request: pullRequest } : {}),
      ...(issue ? { issue_number: issue } : {}),
    };
    const response = await authedApiJsonRequest({
      baseUrl,
      path: "/api/cli/chat/threads",
      method: "POST",
      body,
      autoLogin: !json,
    });
    if (!response.ok) {
      printError(extractError(response.payload, `Unable to create thread (${response.status}).`));
      return 1;
    }

    if (json) {
      print(JSON.stringify(response.payload, null, 2));
      return 0;
    }

    printChatThreadCreateText(response.payload);
    return 0;
  }

  if (subcommand === "show") {
    let options = subcommandArgs.slice();
    const threadId = normalize(options.shift());
    const json = parseFlag(options, ["--json"]);
    options = options.filter((arg) => arg !== "--json");

    if (!threadId) {
      throw new Error("chat thread show requires <thread-id>.");
    }
    if (options.length > 0) {
      throw new Error(`Unknown chat thread show option: ${options[0]}`);
    }

    const response = await authedApiJsonRequest({
      baseUrl,
      path: `/api/cli/chat/threads/${encodeURIComponent(threadId)}`,
      method: "GET",
      autoLogin: !json,
    });
    if (!response.ok) {
      printError(extractError(response.payload, `Unable to load thread (${response.status}).`));
      return 1;
    }

    if (json) {
      print(JSON.stringify(response.payload, null, 2));
      return 0;
    }

    printChatThreadText(response.payload);
    return 0;
  }

  if (subcommand === "messages") {
    let options = subcommandArgs.slice();
    const threadId = normalize(options.shift());
    const json = parseFlag(options, ["--json"]);
    options = options.filter((arg) => arg !== "--json");
    const limitOption = consumeAllOptions(options, "--limit");
    options = limitOption.args;
    const beforeCreatedAtOption = consumeAllOptions(options, "--before-created-at");
    options = beforeCreatedAtOption.args;
    const beforeMessageIdOption = consumeAllOptions(options, "--before-message-id");
    options = beforeMessageIdOption.args;

    if (!threadId) {
      throw new Error("chat thread messages requires <thread-id>.");
    }
    if (options.length > 0) {
      throw new Error(`Unknown chat thread messages option: ${options[0]}`);
    }

    const limit = parsePositiveInteger(limitOption.value, 50);
    const beforeCreatedAt = normalize(beforeCreatedAtOption.value);
    const beforeMessageId = normalize(beforeMessageIdOption.value);
    const response = await authedApiJsonRequest({
      baseUrl,
      path: `/api/cli/chat/threads/${encodeURIComponent(threadId)}/messages`,
      method: "GET",
      query: {
        limit,
        before_created_at: beforeCreatedAt,
        before_message_id: beforeMessageId,
      },
      autoLogin: !json,
    });
    if (!response.ok) {
      printError(
        extractError(response.payload, `Unable to load thread messages (${response.status}).`),
      );
      return 1;
    }

    if (json) {
      print(JSON.stringify(response.payload, null, 2));
      return 0;
    }

    printChatThreadMessagesText(response.payload);
    return 0;
  }

  if (subcommand === "send") {
    let options = subcommandArgs.slice();
    const threadId = normalize(options.shift());
    const contentConsumed = consumeAllOptionsByNames(options, ["--content", "--message"]);
    options = contentConsumed.args;
    const roleConsumed = consumeAllOptions(options, "--role");
    options = roleConsumed.args;
    const noDispatch = parseFlag(options, ["--no-dispatch"]);
    options = options.filter((arg) => arg !== "--no-dispatch");
    const json = parseFlag(options, ["--json"]);
    options = options.filter((arg) => arg !== "--json");

    const unknownOption = options.find((arg) => arg.startsWith("-"));
    if (unknownOption) {
      throw new Error(`Unknown chat thread send option: ${unknownOption}`);
    }

    const role = normalize(roleConsumed.value).toLowerCase();
    if (role && !["user", "system"].includes(role)) {
      throw new Error("chat thread send --role must be user or system.");
    }

    const positionalContent = normalize(options.join(" "));
    const stdinContent =
      normalize(contentConsumed.value) || positionalContent ? "" : normalize(await readStdinText());
    const content = normalize(contentConsumed.value) || positionalContent || stdinContent;

    if (!threadId || !content) {
      throw new Error("chat thread send requires <thread-id> and message content.");
    }

    const response = await authedApiJsonRequest({
      baseUrl,
      path: `/api/cli/chat/threads/${encodeURIComponent(threadId)}/messages`,
      method: "POST",
      body: {
        content,
        ...(role && role !== "user" ? { role } : {}),
        ...(noDispatch ? { metadata: { dispatch: false } } : {}),
      },
      autoLogin: !json,
    });
    if (!response.ok) {
      printError(extractError(response.payload, `Unable to send thread message (${response.status}).`));
      return 1;
    }

    if (json) {
      print(JSON.stringify(response.payload, null, 2));
      return 0;
    }

    printChatThreadSendText(response.payload);
    return 0;
  }

  if (subcommand === "set-title") {
    let options = subcommandArgs.slice();
    const threadId = normalize(options.shift());
    const json = parseFlag(options, ["--json"]);
    options = options.filter((arg) => arg !== "--json");
    const title = normalize(options.join(" "));

    if (!threadId || !title) {
      throw new Error("chat thread set-title requires <thread-id> <title>.");
    }

    const response = await authedApiJsonRequest({
      baseUrl,
      path: `/api/cli/chat/threads/${encodeURIComponent(threadId)}`,
      method: "POST",
      body: {
        action: "set_title",
        title,
      },
      autoLogin: !json,
    });
    if (!response.ok) {
      printError(extractError(response.payload, `Unable to update thread title (${response.status}).`));
      return 1;
    }

    if (json) {
      print(JSON.stringify(response.payload, null, 2));
      return 0;
    }

    printThreadMutationText(response.payload);
    return 0;
  }

  if (subcommand === "target-pr") {
    let options = subcommandArgs.slice();
    const threadId = normalize(options.shift());
    const pullRequestReference = normalize(options.shift());
    const json = parseFlag(options, ["--json"]);
    options = options.filter((arg) => arg !== "--json");

    if (!threadId || !pullRequestReference) {
      throw new Error("chat thread target-pr requires <thread-id> <pr-number-or-url>.");
    }
    if (options.length > 0) {
      throw new Error(`Unknown chat thread target-pr option: ${options[0]}`);
    }

    const response = await authedApiJsonRequest({
      baseUrl,
      path: `/api/cli/chat/threads/${encodeURIComponent(threadId)}`,
      method: "POST",
      body: {
        action: "target_pr",
        pull_request: pullRequestReference,
      },
      autoLogin: !json,
    });
    if (!response.ok) {
      printError(
        extractError(response.payload, `Unable to retarget thread PR (${response.status}).`),
      );
      return 1;
    }

    if (json) {
      print(JSON.stringify(response.payload, null, 2));
      return 0;
    }

    printThreadMutationText(response.payload);
    return 0;
  }

  if (subcommand === "target-branch") {
    let options = subcommandArgs.slice();
    const threadId = normalize(options.shift());
    const branch = normalize(options.shift());
    const json = parseFlag(options, ["--json"]);
    options = options.filter((arg) => arg !== "--json");

    if (!threadId || !branch) {
      throw new Error("chat thread target-branch requires <thread-id> <branch>.");
    }
    if (options.length > 0) {
      throw new Error(`Unknown chat thread target-branch option: ${options[0]}`);
    }

    const response = await authedApiJsonRequest({
      baseUrl,
      path: `/api/cli/chat/threads/${encodeURIComponent(threadId)}`,
      method: "POST",
      body: {
        action: "target_branch",
        branch,
      },
      autoLogin: !json,
    });
    if (!response.ok) {
      printError(
        extractError(
          response.payload,
          `Unable to retarget thread branch (${response.status}).`,
        ),
      );
      return 1;
    }

    if (json) {
      print(JSON.stringify(response.payload, null, 2));
      return 0;
    }

    printThreadMutationText(response.payload);
    return 0;
  }

  if (subcommand === "clear-target") {
    let options = subcommandArgs.slice();
    const threadId = normalize(options.shift());
    const json = parseFlag(options, ["--json"]);
    options = options.filter((arg) => arg !== "--json");

    if (!threadId) {
      throw new Error("chat thread clear-target requires <thread-id>.");
    }
    if (options.length > 0) {
      throw new Error(`Unknown chat thread clear-target option: ${options[0]}`);
    }

    const response = await authedApiJsonRequest({
      baseUrl,
      path: `/api/cli/chat/threads/${encodeURIComponent(threadId)}`,
      method: "POST",
      body: {
        action: "clear_target",
      },
      autoLogin: !json,
    });
    if (!response.ok) {
      printError(
        extractError(
          response.payload,
          `Unable to clear thread target (${response.status}).`,
        ),
      );
      return 1;
    }

    if (json) {
      print(JSON.stringify(response.payload, null, 2));
      return 0;
    }

    printThreadMutationText(response.payload);
    return 0;
  }

  throw new Error(`Unknown chat thread subcommand: ${subcommand}`);
}
