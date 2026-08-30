# Event model

The target adapter translates a GitHub issue label event into a versioned dispatch envelope:

```json
{
  "version": 1,
  "event": "issue.ready",
  "delivery_id": "github-run-id-attempt",
  "source": {
    "repository": "noahpeters/ftops",
    "issue_number": 123,
    "issue_node_id": "I_...",
    "actor": "noahpeters",
    "head_sha": "abc123"
  }
}
```

Required validation:

- `version` is supported;
- `event` is `issue.ready`;
- repository is allowlisted;
- issue number is a positive integer;
- the live issue is open and still has `metis:ready`;
- delivery is processed under a concurrency key for repository + issue.

Future events may include `issue.unblocked`, `pull_request.feedback`, and `run.cancelled`. Adding them requires a versioned schema and explicit transition rules.

