# Metis agent instructions

- Keep this orchestrator small and provider-light. Do not introduce a multi-agent framework.
- GitHub Issues and pull requests are the durable source of truth.
- Preserve the first-class blocked state. A blocker is not a failed run.
- Never merge pull requests or deploy target repositories.
- Never mutate production data or infrastructure.
- Prefer explicit state transitions and idempotent GitHub operations.
- Never log secrets, tokens, or full model prompts containing secrets.
- Run `npm run verify` before proposing a change.

