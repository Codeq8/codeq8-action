import test from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, runCli, withMockServer, withTempConfig } from "./cli-test-helpers.mjs";

test("github issue view defaults the repository from runner env and prints comments", async () => {
  let requestedUrl = "";
  let requestedAuthorization = "";
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
      });
      return;
    }
    if (
      request.method === "GET" &&
      request.url?.startsWith("/api/cli/github/issues?")
    ) {
      requestedUrl = String(request.url || "");
      requestedAuthorization = String(request.headers.authorization || "");
      jsonResponse(response, 200, {
        ok: true,
        issue: {
          repository: "iScoot-LLC/Codeq8",
          number: 98,
          title: "CLI GitHub interface",
          url: "https://github.com/iScoot-LLC/Codeq8/issues/98",
          state: "open",
          body: "Implement Codeq8 GitHub CLI access.",
          author: {
            github_login: "aalzanki",
            display_name: "Abdul",
          },
          assignees: [],
          labels: [{ name: "cli" }],
          milestone: null,
          comment_count: 1,
          created_at: 1700000000000,
          updated_at: 1700000001000,
        },
        comments: [
          {
            id: "1",
            url: "https://github.com/iScoot-LLC/Codeq8/issues/98#issuecomment-1",
            body: "first comment",
            author: {
              github_login: "aalzanki",
              display_name: "Abdul",
            },
            created_at: 1700000002000,
            updated_at: 1700000002000,
          },
        ],
      });
      return;
    }
    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
      CODE_WORKSPACE_REPOSITORY: "iScoot-LLC/Codeq8",
    };
    await runCli(["login", "--with-token", "--token", "ghp_test"], { env });

    const viewed = await runCli(["github", "issue", "view", "98", "--comments"], { env });
    assert.equal(viewed.status, 0);
    assert.equal(requestedAuthorization, "Bearer session-token");
    assert.match(requestedUrl, /issue=98/);
    assert.match(requestedUrl, /repository=iScoot-LLC%2FCodeq8/);
    assert.match(requestedUrl, /comments=1/);
    assert.match(viewed.stdout, /Issue: #98/);
    assert.match(viewed.stdout, /Title: CLI GitHub interface/);
    assert.match(viewed.stdout, /Labels: cli/);
    assert.match(viewed.stdout, /Comments:/);
    assert.match(viewed.stdout, /first comment/);
  } finally {
    await mock.close();
  }
});

test("github issue create posts normalized payload", async () => {
  let requestBody = "";
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/cli/github/issues") {
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        requestBody += chunk;
      });
      request.on("end", () => {
        jsonResponse(response, 200, {
          ok: true,
          created: true,
          issue: {
            repository: "iScoot-LLC/Codeq8",
            number: 120,
            title: "Create GitHub interface",
            url: "https://github.com/iScoot-LLC/Codeq8/issues/120",
            state: "open",
            body: "Use Codeq8 backend instead of gh.",
            author: {
              github_login: "aalzanki",
              display_name: "Abdul",
            },
            assignees: [{ github_login: "aalzanki", display_name: "Abdul" }],
            labels: [{ name: "cli" }],
            milestone: { number: 2, title: "CLI" },
            comment_count: 0,
            created_at: 1700000000000,
            updated_at: 1700000000000,
          },
        });
      });
      return;
    }
    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
    };
    await runCli(["login", "--with-token", "--token", "ghp_test"], { env });

    const created = await runCli(
      [
        "github",
        "issue",
        "create",
        "--repo",
        "iScoot-LLC/Codeq8",
        "--title",
        "Create GitHub interface",
        "--body",
        "Use Codeq8 backend instead of gh.",
        "--assignee",
        "aalzanki",
        "--label",
        "cli",
        "--milestone",
        "2",
        "--json",
      ],
      { env },
    );
    assert.equal(created.status, 0);
    const payload = JSON.parse(requestBody);
    assert.deepEqual(payload, {
      repository: "iScoot-LLC/Codeq8",
      title: "Create GitHub interface",
      body: "Use Codeq8 backend instead of gh.",
      assignees: ["aalzanki"],
      labels: ["cli"],
      milestone: 2,
    });
    const responsePayload = JSON.parse(created.stdout);
    assert.equal(responsePayload.issue.number, 120);
  } finally {
    await mock.close();
  }
});

test("github issue update patches editable issue fields", async () => {
  let requestBody = "";
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
      });
      return;
    }
    if (request.method === "PATCH" && request.url === "/api/cli/github/issues") {
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        requestBody += chunk;
      });
      request.on("end", () => {
        jsonResponse(response, 200, {
          ok: true,
          updated: true,
          issue: {
            repository: "iScoot-LLC/Codeq8",
            number: 98,
            title: "CLI GitHub interface",
            url: "https://github.com/iScoot-LLC/Codeq8/issues/98",
            state: "closed",
            body: "Updated body.",
            author: {
              github_login: "aalzanki",
              display_name: "Abdul",
            },
            assignees: [{ github_login: "aalzanki", display_name: "Abdul" }],
            labels: [{ name: "cli" }],
            milestone: null,
            comment_count: 1,
            created_at: 1700000000000,
            updated_at: 1700000001000,
          },
        });
      });
      return;
    }
    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
      CODE_WORKSPACE_REPOSITORY: "iScoot-LLC/Codeq8",
    };
    await runCli(["login", "--with-token", "--token", "ghp_test"], { env });

    const updated = await runCli(
      [
        "github",
        "issue",
        "update",
        "98",
        "--body",
        "Updated body.",
        "--state",
        "closed",
        "--assignee",
        "aalzanki",
        "--label",
        "cli",
        "--milestone",
        "none",
        "--json",
      ],
      { env },
    );
    assert.equal(updated.status, 0);
    const payload = JSON.parse(requestBody);
    assert.deepEqual(payload, {
      issue: "98",
      repository: "iScoot-LLC/Codeq8",
      body: "Updated body.",
      state: "closed",
      assignees: ["aalzanki"],
      labels: ["cli"],
      milestone: null,
    });
    const responsePayload = JSON.parse(updated.stdout);
    assert.equal(responsePayload.issue.state, "closed");
  } finally {
    await mock.close();
  }
});

test("github issue comment posts body text", async () => {
  let requestBody = "";
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/cli/github/issues/comments") {
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        requestBody += chunk;
      });
      request.on("end", () => {
        jsonResponse(response, 200, {
          ok: true,
          created: true,
          comment: {
            id: "10",
            url: "https://github.com/iScoot-LLC/Codeq8/issues/98#issuecomment-10",
            body: "Investigating this now.",
            author: {
              github_login: "aalzanki",
              display_name: "Abdul",
            },
            created_at: 1700000002000,
            updated_at: 1700000002000,
          },
        });
      });
      return;
    }
    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
    };
    await runCli(["login", "--with-token", "--token", "ghp_test"], { env });

    const commented = await runCli(
      [
        "github",
        "issue",
        "comment",
        "98",
        "--repo",
        "iScoot-LLC/Codeq8",
        "--body",
        "Investigating this now.",
      ],
      { env },
    );
    assert.equal(commented.status, 0);
    const payload = JSON.parse(requestBody);
    assert.deepEqual(payload, {
      issue: "98",
      repository: "iScoot-LLC/Codeq8",
      body: "Investigating this now.",
    });
    assert.match(commented.stdout, /Created issue comment\./);
  } finally {
    await mock.close();
  }
});

test("github pr view loads metadata and optional comments", async () => {
  let requestedUrl = "";
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
      });
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/api/cli/github/pulls?")) {
      requestedUrl = String(request.url || "");
      jsonResponse(response, 200, {
        ok: true,
        pull_request: {
          repository: "iScoot-LLC/Codeq8",
          number: 101,
          title: "Add Codeq8 GitHub CLI",
          url: "https://github.com/iScoot-LLC/Codeq8/pull/101",
          state: "open",
          body: "This adds the GitHub CLI bridge.",
          draft: false,
          author: {
            github_login: "aalzanki",
            display_name: "Abdul",
          },
          assignees: [],
          labels: [{ name: "cli" }],
          milestone: null,
          comment_count: 1,
          created_at: 1700000000000,
          updated_at: 1700000001000,
          head_ref: "feature/github-cli",
          head_sha: "abc123",
          head_repository: "iScoot-LLC/Codeq8",
          base_ref: "main",
          base_sha: "def456",
        },
        comments: [
          {
            id: "22",
            url: "https://github.com/iScoot-LLC/Codeq8/pull/101#issuecomment-22",
            body: "Looks good.",
            author: {
              github_login: "aalzanki",
              display_name: "Abdul",
            },
            created_at: 1700000002000,
            updated_at: 1700000002000,
          },
        ],
      });
      return;
    }
    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
    };
    await runCli(["login", "--with-token", "--token", "ghp_test"], { env });

    const viewed = await runCli(
      [
        "github",
        "pr",
        "view",
        "101",
        "--repo",
        "iScoot-LLC/Codeq8",
        "--comments",
      ],
      { env },
    );
    assert.equal(viewed.status, 0);
    assert.match(requestedUrl, /pull_request=101/);
    assert.match(requestedUrl, /comments=1/);
    assert.match(viewed.stdout, /Pull request: #101/);
    assert.match(viewed.stdout, /Head: iScoot-LLC\/Codeq8:feature\/github-cli/);
    assert.match(viewed.stdout, /Looks good\./);
  } finally {
    await mock.close();
  }
});

test("github pr comment posts body text", async () => {
  let requestBody = "";
  const mock = await withMockServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/cli/auth/exchange") {
      jsonResponse(response, 200, {
        ok: true,
        token_type: "bearer",
        token: "session-token",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/cli/github/pulls/comments") {
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        requestBody += chunk;
      });
      request.on("end", () => {
        jsonResponse(response, 200, {
          ok: true,
          created: true,
          comment: {
            id: "30",
            url: "https://github.com/iScoot-LLC/Codeq8/pull/101#issuecomment-30",
            body: "Please review.",
            author: {
              github_login: "aalzanki",
              display_name: "Abdul",
            },
            created_at: 1700000002000,
            updated_at: 1700000002000,
          },
        });
      });
      return;
    }
    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  try {
    const env = {
      ...withTempConfig(),
      CODEQ8_BASE_URL: mock.baseUrl,
      CODE_WORKSPACE_REPOSITORY: "iScoot-LLC/Codeq8",
    };
    await runCli(["login", "--with-token", "--token", "ghp_test"], { env });

    const commented = await runCli(
      [
        "github",
        "pr",
        "comment",
        "101",
        "--body",
        "Please review.",
      ],
      { env },
    );
    assert.equal(commented.status, 0);
    const payload = JSON.parse(requestBody);
    assert.deepEqual(payload, {
      pull_request: "101",
      repository: "iScoot-LLC/Codeq8",
      body: "Please review.",
    });
    assert.match(commented.stdout, /Created pull request comment\./);
  } finally {
    await mock.close();
  }
});
