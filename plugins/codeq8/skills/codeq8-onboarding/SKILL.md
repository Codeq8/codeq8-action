---
name: codeq8-onboarding
description: Use at the start of a Codeq8 run or when Codex needs first-pass Codeq8 run orientation, assignment/write-mode interpretation, skill routing, evidence-focused final reporting, or migration from harness-heavy behavior into plugin-owned Codeq8 guidance.
---

# Codeq8 Onboarding

Use this skill as the first-pass router for Codeq8-owned behavior. The runner
prompt owns runtime facts and safety policy; this skill explains how to read
those facts and choose the right next skill or repo boundary.

## Core Rule

Read the current runner-provided facts before acting, then route to the smallest
owner that can make the user request true. Keep branch policy, auth/session
rules, linked repository paths, helper commands, validation commands, and
staging mutation guards harness-owned.

## Workflow

1. Read the current task facts from the prompt: workspace repository, branch,
   write mode, assignment mode, linked repositories, validation requirements,
   available helper commands, thread goal, attachments, and newest user message.
2. Respect assignment mode. A person-owned thread is a direct work request; do
   not manage lifecycle state unless the user asks for a supported operation.
3. Route by owner:
   - Use `codeq8-plugin` for plugin capability, install, manifest, Playwright
     MCP, public action pin, or rollout boundary work.
   - Use `codeq8-coordinator` when the user asks Codex to coordinate separate
     Codeq8 workstreams or other normal managed threads.
   - Use workspace repo skills and `AGENTS.md` for repository-specific
     implementation, validation, production, staging, and release rules.
4. Maintain durable thread goals. When the conversation establishes, changes,
   or completes a broader project, problem, or desired outcome, set, update, or
   clear the thread goal through the runner-supported goal surface. Do not turn
   individual commands, checklists, PR mechanics, or transient status into the
   goal. If the durable goal depends on a Codeq8 skill or repo skill, include
   the relevant skill name or path so future runs inherit both the outcome and
   the operating context.
5. Manage repo skills like goals. Treat repo-owned `.codex/skills` as durable
   operating context that Codex owns for the repository, not as a user-facing
   feature the user must ask about. During normal repo work, create, update,
   split, retire, or validate skills in the same branch when the current work
   reveals a reusable project procedure, stale guidance, user correction,
   repeated failure, CI/staging/runtime lesson, or recurring workflow. Prefer
   updating an existing owner skill before creating a new one; create or split
   a skill only when future runs need an executable checklist, routing rule,
   validation pattern, or reusable boundary. Pair skill edits with the smallest
   deterministic validator, test, source contract, operator guard, or docs
   update that proves the invariant. If the skill change would materially
   expand scope or cross an unrelated rollout boundary, report the exact skill
   candidate, blocker, and validation instead of creating a hidden branch or
   standalone skill-management PR.
6. Keep user-message precedence. If newer user instructions conflict with an
   older plan, follow the newer request within the current safety and repo
   policy.
7. Finish with evidence: changed files or PR, validation, staging or runtime
   evidence when required, remaining blockers, and explicit rollout boundaries.

## Guardrails

- Do not turn onboarding into a second harness. Refer to current prompt facts
  instead of restating branch, auth, linked-repo, helper, or validation rules.
- Do not treat a private workspace skill as a shipped Codeq8 runtime capability
  for other repositories. Product-wide Codeq8 behavior must ship through the
  Codeq8 plugin/public action path.
- Do not use goals or skills as blind memory. Goals preserve the durable
  project outcome; repo skills preserve reusable operating procedures and
  validation patterns. Do not store private transcript summaries, incidental
  preferences, or one-off implementation notes as skills.
- Do not move or thin harness wording until the pinned public runtime actually
  bundles the skill that the harness points to.
- Do not imply a plugin capability grants live mutation rights, browser auth, or
  repository access. Those permissions come from the runner prompt and scoped
  Codeq8 backend contracts.
