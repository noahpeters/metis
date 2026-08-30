# Metis agent instructions

- Keep this orchestrator small and provider-light. Do not introduce a multi-agent framework.
- GitHub Issues and pull requests are the durable source of truth.
- Preserve the first-class blocked state. A blocker is not a failed run.
- Never push directly to a target repository's default branch, merge a pull request, or deploy it manually. Pull-request merges are human-only. Metis monitors the exact human merge SHA and its required deployment workflows.
- Treat a merged change as incomplete until required deployment workflows succeed for the exact merge SHA. Freeze normal dispatch during recovery and use bounded corrective pull requests.
- Never mutate production data or infrastructure.
- Prefer explicit state transitions and idempotent GitHub operations.
- Never log secrets, tokens, or full model prompts containing secrets.
- Run `npm run verify` before proposing a change.
