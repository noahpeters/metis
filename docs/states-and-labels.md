# States and labels

GitHub labels are visible task state; D1 stores finer runtime state.

| State | Label | Meaning |
|---|---|---|
| Draft | none | Human is defining work |
| Ready | `metis:ready` | Human authorized scheduling |
| Planning | `metis:planning` | Workers AI is deriving orchestration metadata |
| Implementing | `metis:implementing` | A leased Codex/cloud execution is active |
| Reviewing | `metis:reviewing` | Coding runner is performing substantive review |
| Blocked | `metis:blocked` | Missing information or decision; not failure |
| Budget blocked | `metis:budget-blocked` | A task/global/provider limit stopped work |
| PR ready | `metis:pr-ready` | A PR awaits human review and target CI |
| Failed | `metis:failed` | An operational failure requires diagnosis |

`blocked` records known facts, exact missing information, one question, and why proceeding is unsafe. `budget-blocked` names the exhausted limit and stops before further capacity-consuming work. Both resume only after a human or capacity update and a new `metis:ready` event.
