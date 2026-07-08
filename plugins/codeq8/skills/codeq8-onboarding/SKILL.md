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
   - Use `codeq8-mcp` when the user asks to add, use, configure, install,
     expose, or automate an MCP server or MCP-backed tool, or points to a
     third-party MCP document. Classify the owner path before proposing setup
     commands.
   - Use `codeq8-plugin` for plugin capability, install, manifest, Playwright
     MCP, public action pin, or rollout boundary work.
   - Use explicit strategy or workspace guidance for multi-thread coordination
     only when the user asks for visible coordination or the runner prompt gives
     a bounded workstream instruction. Do not create separate managed threads
     as hidden delegation; keep the current thread informed with the plan,
     thread ids, decisive results, blockers, and cleanup status.
   - Use workspace repo skills and `AGENTS.md` for repository-specific
     implementation, validation, production, staging, and release rules.
4. Maintain durable thread goals. When the conversation establishes, changes,
   or completes a broader project, problem, or desired outcome, set, update, or
   clear the thread goal through the runner-supported goal surface. Do not turn
   individual commands, checklists, PR mechanics, or transient status into the
   goal.
5. Carry a goal-linked owner skill. For durable repo projects, recurring
   subsystems, repeated failures, specialized investigations, or project
   procedures, identify the repo skill that should guide future runs before
   implementing durable repo work or relying on a reusable repo procedure. If it
   exists, read and use it. If it does not exist and write mode allows repo
   changes, create a focused owner skill only when future runs need a durable
   owner boundary, checklist, validation pattern, or reusable debugging
   procedure. Anchor the durable goal to the relevant skill name or path so
   future runs inherit both the outcome and the operating context. If write
   mode, scope, or explicit user instructions block a skill update that meets
   that durable threshold, report the owner-skill candidate and blocker instead
   of treating skills as optional.
6. Keep owner skills current. Treat repo-owned `.codex/skills` as durable
   operating context that Codex owns for the repository, not as a user-facing
   feature the user must ask about. During analysis, implementation,
   validation, and handoff, update, split, retire, or validate skills when the
   current work reveals durable reusable guidance: reusable debugging fields,
   project procedures, stale or wrong guidance, user corrections that change
   future behavior, repeated failures, CI/staging/runtime lessons, or recurring
   workflows. A question-only, clarification, or answer-only turn does not
   justify skill edits by itself; if nothing durable was learned for future
   runs, answer without skill changes or skill-only PRs. A request to diagnose,
   explain, or avoid product code does not by itself forbid skill upkeep, but
   only when the durable-update threshold is met; respect explicit instructions
   that forbid all file changes, PRs, or skill updates. Prefer updating an
   existing owner skill before creating one. Pair skill edits with the smallest
   deterministic validator, test, source contract, operator guard, or docs
   update that proves the invariant. If the skill change would materially
   expand scope or cross an unrelated rollout boundary, report the exact skill
   candidate, blocker, and validation instead of creating a hidden branch or
   standalone skill-management PR.
7. Keep user-message precedence. If newer user instructions conflict with an
   older plan, follow the newer request within the current safety and repo
   policy.
8. Finish with evidence: changed files or PR, validation, staging or runtime
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
- Do not create low-quality skills for one-off facts. Create or update skills
  when they give future runs an owner boundary, checklist, validation pattern,
  or reusable debugging procedure.
- Do not treat every user correction or follow-up question as skill-worthy.
  Update a skill only when the correction changes durable future procedure,
  exposes stale guidance, or proves a repeated failure class.
- Do not move or thin harness wording until the pinned public runtime actually
  bundles the skill that the harness points to.
- Do not imply a plugin capability grants live mutation rights, browser auth, or
  repository access. Those permissions come from the runner prompt and scoped
  Codeq8 backend contracts.
