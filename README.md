# Codeq8 Action

Public GitHub Action runtime shell for Codeq8 self-hosted runner workflows.

The public action owns transport/bootstrap concerns such as:
- runner bootstrap
- repository auth handoff
- workspace persistence
- runner lifecycle diagnostics delivery
- callback delivery

Prompt construction, runner policy, and pull-request presentation are server-owned by Codeq8 and are fetched at run time through the signed web-chat runner contract. Public action version bumps should only be needed for runtime/protocol changes, not for prompt or product-policy tweaks.

## AppServer Live Transport

Codex AppServer live progress and control must use the Firestore bridge. The
runner performs one signed bootstrap request to
`/api/chat/runs/app-server/firebase-session`, signs in with the returned
Firebase custom token, writes a bounded number of progress events directly to
the scoped repository live-status document, and listens to that same document for
`turn/steer` and `turn/interrupt` requests.

Do not add timer-driven runner HTTP polling for AppServer control. In
particular, do not restore `/api/chat/runs/app-server/control` as a required
runner path, do not post progress through `/api/chat/runs/app-server/events`,
and do not introduce `setInterval` loops for live chat transport. Those patterns
can multiply into very large infrastructure bills even when each individual
request looks cheap.

The runner may use `/api/chat/runs/app-server/control` as a bounded final
checkpoint after Codex session/workspace persistence and before the terminal
callback. That one-shot check catches user follow-ups accepted while the GitHub
Actions job is still alive but the local AppServer turn has already completed.

Do not publish partial `item/agentMessage/delta` text as live progress. The
runner may receive deltas from Codex's local stdio AppServer stream, but
Firestore progress publication should happen on completed assistant message
events. Do not cap or truncate progress label text as a cost guardrail; cost is
controlled by event count and publish cadence, not by damaging the retained
event text.

Root action: web chat run.

Example usage:

```yml
- uses: Codeq8/codeq8-action@main
  with:
    github_token: ${{ github.token }}
```
