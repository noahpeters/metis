# States and labels

GitHub labels are the visible state. Exactly one active Metis state label should be present.

| State | Label | Entered when | Exit |
|---|---|---|---|
| Draft | none | Issue is being designed | Human adds `metis:ready` |
| Ready | `metis:ready` | Human authorizes execution | Runner claims task |
| Planning | `metis:planning` | Planner is reading the issue and repo | Implementing, blocked, or failed |
| Implementing | `metis:implementing` | A bounded plan exists | Reviewing, blocked, or failed |
| Reviewing | `metis:reviewing` | Change and verification evidence exist | PR ready, implementing once more, blocked, or failed |
| Blocked | `metis:blocked` | A role needs information or a decision | Human comments and reapplies `metis:ready` |
| PR ready | `metis:pr-ready` | Metis opened or updated a PR | Human owns the PR lifecycle |
| Failed | `metis:failed` | Infrastructure or orchestration failed | Human diagnoses and reapplies `metis:ready` |

## Blocked contract

A blocker must include:

- the phase that stopped;
- what is known;
- exactly what is missing;
- one concrete question or decision request;
- why continuing would be unsafe or likely wrong;
- any partial evidence useful to the human.

Blocked is not used for ordinary uncertainty that can be resolved safely from the repository. Once blocked, the runner makes no further code changes and opens no pull request unless a pre-existing branch needs to be preserved.

## Idempotency

The issue number identifies the task. The branch is `metis/<issue-number>-<slug>`. Re-delivery finds and updates the same branch/PR rather than creating duplicates. The proof of concept serializes runs per target repository and issue.

