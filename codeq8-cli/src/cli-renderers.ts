import { formatTimestamp, normalize, print } from "./cli-command-utils.js";

type CliRecord = Record<string, unknown>;

const EMPTY_RECORD: CliRecord = {};

function readRecord(value: unknown): CliRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as CliRecord;
}

function recordOrEmpty(value: unknown): CliRecord {
  return readRecord(value) ?? EMPTY_RECORD;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function printChatThreadText(payload: unknown): void {
  const payloadRecord = recordOrEmpty(payload);
  const thread = readRecord(payloadRecord.thread);
  if (!thread) {
    print("Thread not found.");
    return;
  }

  const branchContext = recordOrEmpty(thread.branch_context);
  const codexSessionState = recordOrEmpty(thread.codex_session_state);

  print(`Thread: ${normalize(thread.thread_id)}`);
  print(`Repository: ${normalize(thread.workspace_repository)}`);
  print(`Title: ${normalize(thread.title)}`);
  print(`Status: ${normalize(thread.status)}`);
  print(`Source: ${normalize(thread.source_type)}`);
  if (normalize(branchContext.context_branch)) {
    print(`Context branch: ${normalize(branchContext.context_branch)}`);
  }
  if (normalize(branchContext.base_branch)) {
    print(`Base branch: ${normalize(branchContext.base_branch)}`);
  }
  if (Number(branchContext.pull_request_number || 0) > 0) {
    print(`Pull request: #${Number(branchContext.pull_request_number || 0)}`);
  }
  if (normalize(branchContext.write_mode)) {
    print(`Write mode: ${normalize(branchContext.write_mode)}`);
  }
  if (normalize(codexSessionState.status)) {
    print(`Codex session: ${normalize(codexSessionState.status)}`);
  }
}

export function printChatThreadListText(payload: unknown): void {
  const payloadRecord = recordOrEmpty(payload);
  const repository = normalize(payloadRecord.repository);
  const threads = readArray(payloadRecord.threads);

  if (repository) {
    print(`Repository: ${repository}`);
    print("");
  }

  if (threads.length === 0) {
    print("No threads found.");
  } else {
    for (const threadValue of threads) {
      const thread = recordOrEmpty(threadValue);
      const branchContext = recordOrEmpty(thread.branch_context);
      const pullRequestNumber = Number(branchContext.pull_request_number || 0) || 0;
      const target =
        pullRequestNumber > 0
          ? `#${pullRequestNumber}`
          : normalize(branchContext.context_branch) || normalize(branchContext.base_branch);
      const title = normalize(thread.title) || "Untitled";
      const updatedAt = formatTimestamp(thread.updated_at);
      print(
        [
          normalize(thread.thread_id),
          normalize(thread.status) || "active",
          normalize(thread.source_type) || "default_branch",
          target,
          title,
          updatedAt,
        ]
          .filter(Boolean)
          .join("\t"),
      );
    }
  }

  print("");
  print(`Page count: ${Number(payloadRecord.page_count || threads.length || 0) || 0}`);
  print(`Has more: ${payloadRecord.has_more ? "yes" : "no"}`);
  if (payloadRecord.next_before_updated_at) {
    print(`Next before updated_at: ${payloadRecord.next_before_updated_at}`);
  }
  if (normalize(payloadRecord.next_before_thread_id)) {
    print(`Next before thread_id: ${normalize(payloadRecord.next_before_thread_id)}`);
  }
}

export function printChatThreadCreateText(payload: unknown): void {
  const payloadRecord = recordOrEmpty(payload);
  print(`${payloadRecord.created ? "Created" : "Resolved"} thread.`);
  print("");
  printChatThreadText(payload);
}

export function printThreadMutationText(payload: unknown): void {
  const payloadRecord = recordOrEmpty(payload);
  const action = normalize(payloadRecord.action).replace(/_/g, "-");
  const target = normalize(payloadRecord.target);
  if (action === "set-title") {
    print(`Updated thread title${target ? ` -> ${target}` : ""}.`);
    print("");
    printChatThreadText(payload);
    return;
  }
  if (action || target) {
    print(
      `Updated thread target${action ? ` via ${action}` : ""}${target ? ` -> ${target}` : ""}.`,
    );
    print("");
  }
  printChatThreadText(payload);
}

export function printChatThreadMessagesText(payload: unknown): void {
  const payloadRecord = recordOrEmpty(payload);
  const thread = readRecord(payloadRecord.thread);
  const messages = readArray(payloadRecord.messages);

  if (thread) {
    print(`Thread: ${normalize(thread.thread_id)}`);
    print(`Title: ${normalize(thread.title) || "Untitled"}`);
    print(`Repository: ${normalize(thread.workspace_repository)}`);
    print("");
  }

  if (messages.length === 0) {
    print("No messages found.");
  } else {
    for (const messageValue of messages) {
      const message = recordOrEmpty(messageValue);
      const metadata = recordOrEmpty(message.metadata);
      const attachments = readArray(metadata.attachments);
      const role = normalize(message.role) || "message";
      const githubLogin = normalize(message.github_login);
      const createdAt = Number(message.created_at || 0) || 0;
      const content = String(message.content || "").trim();

      print(
        `[${role}${githubLogin ? ` ${githubLogin}` : ""}${createdAt ? ` @ ${createdAt}` : ""}]`,
      );
      if (attachments.length > 0) {
        for (const attachmentValue of attachments) {
          const attachment = recordOrEmpty(attachmentValue);
          const name = normalize(attachment.name || attachment.file_name);
          if (name) {
            print(`attachment: ${name}`);
          }
        }
      }
      print(content || "(no text)");
      print("");
    }
  }

  print(`Page count: ${Number(payloadRecord.page_count || messages.length || 0) || 0}`);
  print(`Has more: ${payloadRecord.has_more ? "yes" : "no"}`);
  if (payloadRecord.next_before_created_at) {
    print(`Next before created_at: ${payloadRecord.next_before_created_at}`);
  }
  if (normalize(payloadRecord.next_before_message_id)) {
    print(`Next before message_id: ${normalize(payloadRecord.next_before_message_id)}`);
  }
}

export function printChatThreadSendText(payload: unknown): void {
  const payloadRecord = recordOrEmpty(payload);
  const message = recordOrEmpty(payloadRecord.message);
  const run = recordOrEmpty(payloadRecord.run);
  const messageId = normalize(message.message_id);
  print(`Sent thread message${messageId ? ` ${messageId}` : ""}.`);
  if (payloadRecord.dispatched && normalize(run.control_plane_run_id)) {
    print(`Run: ${normalize(run.control_plane_run_id)}`);
  }
  print("");
  printChatThreadText(payload);
}

export function formatGitHubUser(user: unknown): string {
  const record = readRecord(user);
  if (!record) {
    return "";
  }
  return normalize(record.display_name) || normalize(record.github_login);
}

export function formatGitHubLabels(labels: unknown): string {
  return readArray(labels)
    .map((label) => normalize(recordOrEmpty(label).name))
    .filter(Boolean)
    .join(", ");
}

export function printGitHubComments(comments: unknown): void {
  const commentRecords = readArray(comments);
  if (commentRecords.length === 0) {
    return;
  }
  print("");
  print("Comments:");
  for (const commentValue of commentRecords) {
    const comment = recordOrEmpty(commentValue);
    const author = formatGitHubUser(comment.author) || "Unknown author";
    const createdAt = formatTimestamp(comment.created_at);
    print(`- ${author}${createdAt ? ` @ ${createdAt}` : ""}`);
    print(String(comment.body || "").trim() || "(no text)");
    if (normalize(comment.url)) {
      print(`  ${normalize(comment.url)}`);
    }
    print("");
  }
}

export function printGitHubIssueText(payload: unknown): void {
  const payloadRecord = recordOrEmpty(payload);
  const issue = readRecord(payloadRecord.issue);
  if (!issue) {
    print("Issue not found.");
    return;
  }

  print(`Repository: ${normalize(issue.repository)}`);
  print(`Issue: #${Number(issue.number || 0) || 0}`);
  print(`Title: ${normalize(issue.title)}`);
  print(`State: ${normalize(issue.state) || "open"}`);
  if (formatGitHubUser(issue.author)) {
    print(`Author: ${formatGitHubUser(issue.author)}`);
  }
  const assignees = readArray(issue.assignees);
  if (assignees.length > 0) {
    print(
      `Assignees: ${assignees.map((entry) => formatGitHubUser(entry)).filter(Boolean).join(", ")}`,
    );
  }
  if (formatGitHubLabels(issue.labels)) {
    print(`Labels: ${formatGitHubLabels(issue.labels)}`);
  }
  const milestone = readRecord(issue.milestone);
  if (milestone) {
    print(`Milestone: ${normalize(milestone.title)}`);
  }
  if (normalize(issue.url)) {
    print(`URL: ${normalize(issue.url)}`);
  }
  if (formatTimestamp(issue.created_at)) {
    print(`Created: ${formatTimestamp(issue.created_at)}`);
  }
  if (formatTimestamp(issue.updated_at)) {
    print(`Updated: ${formatTimestamp(issue.updated_at)}`);
  }
  print(`Comments: ${Number(issue.comment_count || 0) || 0}`);

  print("");
  print("Body:");
  print(String(issue.body || "").trim() || "(no text)");

  printGitHubComments(payloadRecord.comments);
}

export function printGitHubIssueCommentResult(payload: unknown): void {
  const payloadRecord = recordOrEmpty(payload);
  const comment = readRecord(payloadRecord.comment);
  if (!comment) {
    print("Issue comment not found.");
    return;
  }

  print("Created issue comment.");
  if (normalize(comment.url)) {
    print(`URL: ${normalize(comment.url)}`);
  }
  print("");
  print(String(comment.body || "").trim() || "(no text)");
}

export function printGitHubPullRequestText(payload: unknown): void {
  const payloadRecord = recordOrEmpty(payload);
  const pullRequest = readRecord(payloadRecord.pull_request);
  if (!pullRequest) {
    print("Pull request not found.");
    return;
  }

  print(`Repository: ${normalize(pullRequest.repository)}`);
  print(`Pull request: #${Number(pullRequest.number || 0) || 0}`);
  print(`Title: ${normalize(pullRequest.title)}`);
  print(
    `State: ${normalize(pullRequest.state) || "open"}${pullRequest.draft ? " (draft)" : ""}`,
  );
  if (formatGitHubUser(pullRequest.author)) {
    print(`Author: ${formatGitHubUser(pullRequest.author)}`);
  }
  const assignees = readArray(pullRequest.assignees);
  if (assignees.length > 0) {
    print(
      `Assignees: ${assignees.map((entry) => formatGitHubUser(entry)).filter(Boolean).join(", ")}`,
    );
  }
  if (formatGitHubLabels(pullRequest.labels)) {
    print(`Labels: ${formatGitHubLabels(pullRequest.labels)}`);
  }
  print(`Head: ${normalize(pullRequest.head_repository)}:${normalize(pullRequest.head_ref)}`);
  print(`Base: ${normalize(pullRequest.base_ref)}`);
  if (normalize(pullRequest.url)) {
    print(`URL: ${normalize(pullRequest.url)}`);
  }
  if (formatTimestamp(pullRequest.created_at)) {
    print(`Created: ${formatTimestamp(pullRequest.created_at)}`);
  }
  if (formatTimestamp(pullRequest.updated_at)) {
    print(`Updated: ${formatTimestamp(pullRequest.updated_at)}`);
  }
  print(`Comments: ${Number(pullRequest.comment_count || 0) || 0}`);

  print("");
  print("Body:");
  print(String(pullRequest.body || "").trim() || "(no text)");

  printGitHubComments(payloadRecord.comments);
}

export function printGitHubPullRequestCommentResult(payload: unknown): void {
  const payloadRecord = recordOrEmpty(payload);
  const comment = readRecord(payloadRecord.comment);
  if (!comment) {
    print("Pull request comment not found.");
    return;
  }

  print("Created pull request comment.");
  if (normalize(comment.url)) {
    print(`URL: ${normalize(comment.url)}`);
  }
  print("");
  print(String(comment.body || "").trim() || "(no text)");
}
