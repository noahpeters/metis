# States and labels

GitHub labels are visible task state; D1 stores finer runtime state.

| State | Label | Meaning |
|---|---|---|
| Draft | none | Human is defining work |
| Ready | `metis:ready` | Human authorized scheduling |
| Planning | `metis:planning` | Workers AI is deriving orchestration metadata |
| Implementing | `metis:implementing` | A leased Codex/cloud execution is active |
| Revising | `metis:revising` | Codex is addressing requested review changes on the existing PR branch |
| Awaiting PR | `metis:awaiting-pr` | Codex prepared a verified change; a human must click Create PR |
| Blocked | `metis:blocked` | Missing information or decision; not failure |
| Budget blocked | `metis:budget-blocked` | A task/global/provider limit stopped work |
| PR ready | `metis:pr-ready` | A PR awaits human review and target CI |
| Reviewing | `metis:reviewing` | Required reviews, checks, or mergeability are pending |
| Merge ready | `metis:merge-ready` | Configured merge gates passed |
| Merging | `metis:merging` | GitHub native auto-merge owns the protected merge gate |
| Deploying | `metis:deploying` | Required workflows are running for the exact merge SHA |
| Complete | `metis:complete` | Every required deployment workflow succeeded |
| Recovery | `metis:recovery` | Normal work is frozen while a corrective PR is prepared |
| Recovery blocked | `metis:recovery-blocked` | Recovery cannot continue safely or exhausted its retry limit |
| Failed | `metis:failed` | An operational failure requires diagnosis |

`awaiting-pr` is a non-blocked human checkpoint. Metis releases the coding lease before asking for the Create PR click, and the subsequent pull-request webhook advances the task to `pr-ready`. `blocked` records known facts, exact missing information, one question, and why proceeding is unsafe. `budget-blocked` names the exhausted limit and stops before further capacity-consuming work. Both blocked states resume only after a human or capacity update and a new `metis:ready` event.

A `CHANGES_REQUESTED` review creates a bounded revision lease against the exact PR head and sends the current inline review feedback to Codex. Codex may update only the existing PR branch. A changed head returns the task to `reviewing`; renewed human approval and resolution of every review thread remain mandatory. Stale results, expired leases, exhausted revision attempts, and missing decisions fail closed.

Auto-merge is repository-scoped and disabled by default. Metis enables GitHub native auto-merge only for an open, non-draft PR to the default branch after configured human approvals, mergeability, repository health, and any configured pre-merge checks pass. Repositories with post-merge-only verification may explicitly disable the pre-merge check gate while retaining mandatory named deployment workflows. A merge moves the repository into an exact-SHA deployment lock. Any required workflow failure freezes normal dispatch, opens one idempotent recovery task for that SHA, and uses the same protected PR path. Recovery attempts are bounded; Metis never pushes directly to the default branch or performs a manual deployment.
