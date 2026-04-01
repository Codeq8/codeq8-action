# Codeq8 Action

Public GitHub Action runtime for Codeq8 self-hosted runner workflows.

- Root action: web chat run
- Sub-action: `chatgpt-account-auth`

Example usage:

```yml
- uses: Codeq8/codeq8-action@main
  with:
    github_token: ${{ github.token }}

- uses: Codeq8/codeq8-action/chatgpt-account-auth@main
```
