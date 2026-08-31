# States and labels

GitHub labels are visible task state; D1 stores finer runtime state.

| State | Label | Meaning |
|---|---|---|
| Draft | none | Human is defining work |
| Ready | `metis:ready` | Human attested that the plan, prerequisites, decisions, and bounded scope are authorized |
| Planning | `metis:planning` | Workers AI is deriving orchestration metadata |
| Implementing | `metis:implementing` | A leased Codex/cloud execution is active |
| Revising | `metis:revising` | Codex is addressing requested review changes on the existing PR branch |
| Awaiting PR | `metis:awaiting-pr` | Codex prepared a verified change; a human must click Create PR |
| Blocked | `metis:blocked` | Missing information or decision; not failure |
| Budget blocked | `metis:budget-blocked` | A task-specific approval or hard envelope stopped work |
| PR ready | `metis:pr-ready` | A PR awaits human review and target CI |
| Reviewing | `metis:reviewing` | Required reviews, checks, or mergeability are pending |
| Merge ready | `metis:merge-ready` | Configured merge gates passed |
| Deploying | `metis:deploying` | Required workflows are running for the exact merge SHA |
| Complete | `metis:complete` | Every required deployment workflow succeeded |
| Recovery | `metis:recovery` | Normal work is frozen while a corrective PR is prepared |
| Recovery blocked | `metis:recovery-blocked` | Recovery cannot continue safely or exhausted its retry limit |
| Failed | `metis:failed` | An operational failure requires diagnosis |

Applying `metis:ready` is a human authority boundary: it supersedes stale planning gates, prose-only dependencies, previous human-resolvable questions, and model uncertainty. Planning models may summarize, size, prioritize, and suggest dependencies, but may not reverse that decision. Reapplying Ready clears the recorded blocker. Metis may demote a task only for current authoritative evidence of a task-specific hard contradiction, and that evidence must identify its source, observation time, failed invariant, safety impact, minimum resolution, and fingerprint.

`awaiting-pr` is a non-blocked human checkpoint. Metis releases the coding lease before asking for the Create PR click, and the subsequent pull-request webhook advances the task to `pr-ready`. `blocked` records known facts, exact missing information, one question, and why proceeding is unsafe. `budget-blocked` is reserved for a task-specific approval or hard envelope. Operator pacing, concurrency, and the provider gate are scheduler deferrals: the issue remains Ready, retains its queue position, creates no lease or attempt, and emits one scheduler signal per window and cause. Estimated workload never produces a provider-capacity blocker.

GitHub's structured **Blocked by** relationships are the only enforced task dependencies. Add every child issue to the Project as Ready, then use the issue sidebar to make later work blocked by its prerequisites. Metis reads every page of those relationships before admission. Open issues and issues closed as **not planned** remain unsatisfied; only **closed as completed** is sufficient. Waiting is a neutral scheduler deferral: Ready intent, Project position, approval, and ownership remain unchanged, and no attempt, lease, reservation, provider capacity, or pacing allowance is consumed. Prose and model-suggested dependencies remain advisory. Cross-repository prerequisites must belong to an allowlisted repository. Self-dependencies, cycles, inaccessible issues, and reconciliation failures fail closed and produce one deduplicated operator event rather than blocker labels or questions.

A `CHANGES_REQUESTED` review creates a bounded revision lease against the exact PR head and sends the current inline review feedback to Codex from the original issue. The included GitHub connector prepares a replacement PR through the normal human Create PR handoff. Metis closes the superseded PR, binds the replacement, and returns the task to `reviewing`; renewed human approval, resolution of every review thread, and a human merge remain mandatory. Stale results, expired leases, exhausted revision attempts, and missing decisions fail closed.

Metis marks an open, non-draft PR to the default branch `merge-ready` only after configured human approvals, mergeability, repository health, and any configured pre-merge checks pass. It never enables auto-merge or invokes a merge endpoint. Only a human may merge. A signed merged webhook moves the repository into an exact-SHA deployment lock. Any required workflow failure freezes normal dispatch, opens one idempotent recovery task for that SHA, and uses the same human-merged PR path. Recovery attempts are bounded; Metis never pushes directly to the default branch or performs a manual deployment.
