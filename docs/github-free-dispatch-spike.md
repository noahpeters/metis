# Experiment: Invoke Codex Cloud without GitHub

## Decision to prove
Can Metis launch, monitor, and retrieve a **real Codex Cloud task** without a GitHub issue, project, repository, GitHub Actions, or GitHub integration, using the user's existing ChatGPT subscription authentication rather than metered OpenAI API billing?

**Stop condition:** If no supported, safe, unattended, subscription-authenticated invocation exists, stop the GitHub-free Metis dispatch redesign. Do not build generic task APIs, queues, or mock executors as substitutes for this proof.

## Minimal proof
1. Identify an officially supported Codex Cloud task creation interface (CLI or otherwise) and document its precise authentication requirements and limitations. Do not assume a CLI's interactive login works in an unattended service.
2. From an isolated non-GitHub execution host, authenticate through a supported mechanism without exporting/copying personal browser cookies, refresh tokens, or session credentials into CI or Cloudflare.
3. Launch one real, harmless Codex Cloud task in an environment that requires no GitHub repository. Record its provider task ID.
4. Poll status and retrieve actual output. Verify the task completed under subscription entitlements and not an API-billed key.
5. Repeat after process restart to assess unattended renewal and persistence. Check permissions, rate limits, and revocation.
6. Report PASS, BLOCKED, or FAIL with exact evidence. A task run manually in the UI does not satisfy unattended Metis dispatch.

## Candidate pathways to investigate
- Official Codex CLI cloud-task commands and their supported auth/session lifecycle.
- Official Codex Cloud task API, if exposed and supported for subscription accounts.
- Dedicated non-GitHub execution host running Codex CLI (distinguish local Codex execution from Codex **Cloud** dispatch).

## Explicit non-goals
No D1 schema changes, Cloudflare Queue work, mock text-file executor, GitHub task bridge, or production deployment until the actual Codex invocation question is answered.
