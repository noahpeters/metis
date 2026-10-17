# GitHub-free dispatch experiment

## Success criterion
Metis accepts a task, queues it, executes it, and returns an artifact and completion status without any GitHub API call, repository, issue, project, or Actions dependency.

## First executor
Use a bounded deterministic smoke-test executor. The task specifies text to write; the executor returns a text artifact and checksum. This tests Metis transport and lifecycle, not Codex Cloud.

## Work plan
1. Add Metis-owned task IDs, optional external references, idempotency keys, and generic task state in D1.
2. Add authenticated POST /v1/tasks and GET /v1/tasks/:id plus result endpoint.
3. Dispatch through existing Cloudflare Queue to a GitHub-independent smoke-test executor.
4. Test success, failure, retries, duplicate submissions, and operation with all GitHub secrets absent.
5. Once this works, separately investigate a non-GitHub Codex executor with supported unattended authentication.

## Constraints
Keep the current GitHub Codex adapter functioning. Do not require repository or issue_number for generic tasks. No production mutations or merges from smoke-test tasks. Preserve Terraform and GitHub Actions deployment practices for now; those are separate from runtime dispatch. Do not place personal ChatGPT credentials in automation.
