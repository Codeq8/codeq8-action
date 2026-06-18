import {
  consumeAllOptions,
  consumeGithubBodyOption,
  consumeRepeatedOptions,
  consumeRepoOption,
  extractError,
  normalize,
  parseFlag,
  print,
  printError,
  readOptionalMilestone,
  resolveWorkspaceRepository,
} from "./cli-command-utils.js";
import { renderGitHubHelp, renderGitHubIssueHelp, renderGitHubPrHelp } from "./cli-help.js";
import {
  printGitHubIssueCommentResult,
  printGitHubIssueText,
  printGitHubPullRequestCommentResult,
  printGitHubPullRequestText,
} from "./cli-renderers.js";
import type { CommandContext } from "./cli-types.js";

export async function handleGitHubIssue(
  args: string[],
  { baseUrl, authedApiJsonRequest }: CommandContext,
): Promise<number> {
  const [subcommand = "", ...rest] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    print(renderGitHubIssueHelp());
    return 0;
  }

  if (subcommand === "view") {
    let options = rest.slice();
    const issueReference = normalize(options.shift());
    const repoConsumed = consumeRepoOption(options);
    const repository = resolveWorkspaceRepository(repoConsumed.repository);
    options = repoConsumed.args;
    const comments = parseFlag(options, ["--comments"]);
    options = options.filter((arg) => arg !== "--comments");
    const json = parseFlag(options, ["--json"]);
    options = options.filter((arg) => arg !== "--json");

    if (!issueReference) {
      throw new Error("github issue view requires <url|number>.");
    }
    if (options.length > 0) {
      throw new Error(`Unknown github issue view option: ${options[0]}`);
    }

    const response = await authedApiJsonRequest({
      baseUrl,
      path: "/api/cli/github/issues",
      method: "GET",
      query: {
        issue: issueReference,
        repository,
        comments: comments ? "1" : "",
      },
      autoLogin: !json,
    });
    if (!response.ok) {
      printError(extractError(response.payload, `Unable to load GitHub issue (${response.status}).`));
      return 1;
    }

    if (json) {
      print(JSON.stringify(response.payload, null, 2));
      return 0;
    }

    printGitHubIssueText(response.payload);
    return 0;
  }

  if (subcommand === "comment") {
    let options = rest.slice();
    const issueReference = normalize(options.shift());
    const repoConsumed = consumeRepoOption(options);
    const repository = resolveWorkspaceRepository(repoConsumed.repository);
    options = repoConsumed.args;
    const bodyConsumed = consumeGithubBodyOption(options);
    const body = bodyConsumed.body;
    options = bodyConsumed.args;
    const json = parseFlag(options, ["--json"]);
    options = options.filter((arg) => arg !== "--json");

    if (!issueReference || !body) {
      throw new Error("github issue comment requires <url|number> --body <text>.");
    }
    if (options.length > 0) {
      throw new Error(`Unknown github issue comment option: ${options[0]}`);
    }

    const response = await authedApiJsonRequest({
      baseUrl,
      path: "/api/cli/github/issues/comments",
      method: "POST",
      body: {
        issue: issueReference,
        repository,
        body,
      },
      autoLogin: !json,
    });
    if (!response.ok) {
      printError(
        extractError(response.payload, `Unable to create GitHub issue comment (${response.status}).`),
      );
      return 1;
    }

    if (json) {
      print(JSON.stringify(response.payload, null, 2));
      return 0;
    }

    printGitHubIssueCommentResult(response.payload);
    return 0;
  }

  if (subcommand === "create") {
    let options = rest.slice();
    const repoConsumed = consumeRepoOption(options);
    const repository = resolveWorkspaceRepository(repoConsumed.repository);
    options = repoConsumed.args;
    const titleConsumed = consumeAllOptions(options, "--title");
    const title = normalize(titleConsumed.value);
    options = titleConsumed.args;
    const bodyConsumed = consumeGithubBodyOption(options);
    const body = bodyConsumed.body;
    options = bodyConsumed.args;
    const assigneeConsumed = consumeRepeatedOptions(options, ["--assignee"]);
    const assignees = assigneeConsumed.values;
    options = assigneeConsumed.args;
    const labelConsumed = consumeRepeatedOptions(options, ["--label"]);
    const labels = labelConsumed.values;
    options = labelConsumed.args;
    const milestoneConsumed = consumeAllOptions(options, "--milestone");
    const milestone = readOptionalMilestone(milestoneConsumed.value);
    options = milestoneConsumed.args;
    const json = parseFlag(options, ["--json"]);
    options = options.filter((arg) => arg !== "--json");

    if (!repository || !title) {
      throw new Error("github issue create requires --repo <owner/repo> --title <text>.");
    }
    if (options.length > 0) {
      throw new Error(`Unknown github issue create option: ${options[0]}`);
    }

    const bodyPayload = {
      repository,
      title,
      ...(body ? { body } : {}),
      ...(assignees.length > 0 ? { assignees } : {}),
      ...(labels.length > 0 ? { labels } : {}),
      ...(milestone !== undefined ? { milestone } : {}),
    };
    const response = await authedApiJsonRequest({
      baseUrl,
      path: "/api/cli/github/issues",
      method: "POST",
      body: bodyPayload,
      autoLogin: !json,
    });
    if (!response.ok) {
      printError(extractError(response.payload, `Unable to create GitHub issue (${response.status}).`));
      return 1;
    }

    if (json) {
      print(JSON.stringify(response.payload, null, 2));
      return 0;
    }

    printGitHubIssueText(response.payload);
    return 0;
  }

  if (subcommand === "update") {
    let options = rest.slice();
    const issueReference = normalize(options.shift());
    const repoConsumed = consumeRepoOption(options);
    const repository = resolveWorkspaceRepository(repoConsumed.repository);
    options = repoConsumed.args;
    const titleConsumed = consumeAllOptions(options, "--title");
    const title = titleConsumed.value;
    options = titleConsumed.args;
    const bodyConsumed = consumeGithubBodyOption(options);
    const body = bodyConsumed.body;
    options = bodyConsumed.args;
    const stateConsumed = consumeAllOptions(options, "--state");
    const state = normalize(stateConsumed.value);
    options = stateConsumed.args;
    const hadAssigneeOption = options.includes("--assignee");
    const assigneeConsumed = consumeRepeatedOptions(options, ["--assignee"]);
    const assignees = assigneeConsumed.values;
    options = assigneeConsumed.args;
    const hadLabelOption = options.includes("--label");
    const labelConsumed = consumeRepeatedOptions(options, ["--label"]);
    const labels = labelConsumed.values;
    options = labelConsumed.args;
    const hadMilestoneOption = options.includes("--milestone");
    const milestoneConsumed = consumeAllOptions(options, "--milestone");
    const milestone = readOptionalMilestone(milestoneConsumed.value);
    options = milestoneConsumed.args;
    const json = parseFlag(options, ["--json"]);
    options = options.filter((arg) => arg !== "--json");

    if (!issueReference) {
      throw new Error("github issue update requires <url|number>.");
    }
    if (options.length > 0) {
      throw new Error(`Unknown github issue update option: ${options[0]}`);
    }

    const updatePayload = {
      issue: issueReference,
      repository,
      ...(titleConsumed.value !== "" ? { title } : {}),
      ...(bodyConsumed.hasBody ? { body } : {}),
      ...(state ? { state } : {}),
      ...(hadAssigneeOption ? { assignees } : {}),
      ...(hadLabelOption ? { labels } : {}),
      ...(hadMilestoneOption ? { milestone } : {}),
    };
    const response = await authedApiJsonRequest({
      baseUrl,
      path: "/api/cli/github/issues",
      method: "PATCH",
      body: updatePayload,
      autoLogin: !json,
    });
    if (!response.ok) {
      printError(extractError(response.payload, `Unable to update GitHub issue (${response.status}).`));
      return 1;
    }

    if (json) {
      print(JSON.stringify(response.payload, null, 2));
      return 0;
    }

    printGitHubIssueText(response.payload);
    return 0;
  }

  throw new Error(`Unknown github issue subcommand: ${subcommand}`);
}

export async function handleGitHubPullRequest(
  args: string[],
  { baseUrl, authedApiJsonRequest }: CommandContext,
): Promise<number> {
  const [subcommand = "", ...rest] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    print(renderGitHubPrHelp());
    return 0;
  }

  if (subcommand === "view") {
    let options = rest.slice();
    const pullRequestReference = normalize(options.shift());
    const repoConsumed = consumeRepoOption(options);
    const repository = resolveWorkspaceRepository(repoConsumed.repository);
    options = repoConsumed.args;
    const comments = parseFlag(options, ["--comments"]);
    options = options.filter((arg) => arg !== "--comments");
    const json = parseFlag(options, ["--json"]);
    options = options.filter((arg) => arg !== "--json");

    if (!pullRequestReference) {
      throw new Error("github pr view requires <url|number>.");
    }
    if (options.length > 0) {
      throw new Error(`Unknown github pr view option: ${options[0]}`);
    }

    const response = await authedApiJsonRequest({
      baseUrl,
      path: "/api/cli/github/pulls",
      method: "GET",
      query: {
        pull_request: pullRequestReference,
        repository,
        comments: comments ? "1" : "",
      },
      autoLogin: !json,
    });
    if (!response.ok) {
      printError(
        extractError(response.payload, `Unable to load GitHub pull request (${response.status}).`),
      );
      return 1;
    }

    if (json) {
      print(JSON.stringify(response.payload, null, 2));
      return 0;
    }

    printGitHubPullRequestText(response.payload);
    return 0;
  }

  if (subcommand === "comment") {
    let options = rest.slice();
    const pullRequestReference = normalize(options.shift());
    const repoConsumed = consumeRepoOption(options);
    const repository = resolveWorkspaceRepository(repoConsumed.repository);
    options = repoConsumed.args;
    const bodyConsumed = consumeGithubBodyOption(options);
    const body = bodyConsumed.body;
    options = bodyConsumed.args;
    const json = parseFlag(options, ["--json"]);
    options = options.filter((arg) => arg !== "--json");

    if (!pullRequestReference || !body) {
      throw new Error("github pr comment requires <url|number> --body <text>.");
    }
    if (options.length > 0) {
      throw new Error(`Unknown github pr comment option: ${options[0]}`);
    }

    const response = await authedApiJsonRequest({
      baseUrl,
      path: "/api/cli/github/pulls/comments",
      method: "POST",
      body: {
        pull_request: pullRequestReference,
        repository,
        body,
      },
      autoLogin: !json,
    });
    if (!response.ok) {
      printError(
        extractError(
          response.payload,
          `Unable to create GitHub pull request comment (${response.status}).`,
        ),
      );
      return 1;
    }

    if (json) {
      print(JSON.stringify(response.payload, null, 2));
      return 0;
    }

    printGitHubPullRequestCommentResult(response.payload);
    return 0;
  }

  throw new Error(`Unknown github pr subcommand: ${subcommand}`);
}

export async function handleGitHub(
  args: string[],
  { baseUrl, authedApiJsonRequest }: CommandContext,
): Promise<number> {
  const [resource = "", ...rest] = args;
  if (!resource || resource === "--help" || resource === "-h") {
    print(renderGitHubHelp());
    return 0;
  }
  if (resource === "issue") {
    return await handleGitHubIssue(rest, { baseUrl, authedApiJsonRequest });
  }
  if (resource === "pr") {
    return await handleGitHubPullRequest(rest, { baseUrl, authedApiJsonRequest });
  }
  throw new Error(`Unknown github resource: ${resource}`);
}
