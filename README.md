# Codeq8 Action

Public GitHub Action runtime shell for Codeq8 self-hosted runner workflows.

The public action owns transport/bootstrap concerns such as:
- runner bootstrap
- repository auth handoff
- workspace persistence
- callback delivery

Prompt construction, runner policy, and pull-request presentation are server-owned by Codeq8 and are fetched at run time through the signed web-chat runner contract. Public action version bumps should only be needed for runtime/protocol changes, not for prompt or product-policy tweaks.

Root action: web chat run.

Example usage:

```yml
- uses: Codeq8/codeq8-action@main
  with:
    github_token: ${{ github.token }}
```
