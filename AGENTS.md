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
- For any user-interface change, also run `npm run test:ui`. A build or unit test alone is not UI verification: Chromium must render the affected routes at desktop and mobile sizes, and the resulting Playwright screenshots must be attached as review evidence. A missing browser or missing screenshot is a verification failure to repair, never an acceptable warning.
- In a UI pull request, direct reviewers to the `playwright-ui-evidence` artifact in the PR's CI run; it contains the HTML report and desktop/mobile screenshots.
