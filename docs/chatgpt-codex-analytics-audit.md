# ChatGPT and Codex analytics signal audit

_Evidence reviewed 2026-08-31. This is a capability audit, not a record of workspace usage._

## Decision

Metis cannot safely automate ChatGPT or Codex subscription-capacity decisions from an officially supported machine interface today. The supported workspace analytics surfaces are retrospective, aggregate reporting surfaces. They do not publish included allowance, remaining allowance or credits, the next limit-reset time, or an overage-control state. Values that those surfaces do not return must remain `null`/unknown; local workload units, elapsed time, UI observations, and API token counts are not substitutes.

The repository proves only that the staging driver is configured for the GitHub Codex integration. It contains no workspace identifier, admin credential, Compliance API key, or evidence of the workspace's ChatGPT plan. Consequently, workspace eligibility is **unknown**, rather than assumed from a successful Codex invocation. Verification requires a workspace owner to inspect the workspace analytics controls; no credential should be added to this repository to perform that check.

## Official surfaces and authorization boundaries

| Surface | Eligibility and authentication | Window, pagination, freshness, and corrections | Safe interpretation |
| --- | --- | --- | --- |
| [Workspace analytics](https://help.openai.com/en/articles/10875114-user-analytics-for-chatgpt-enterprise-and-edu) | ChatGPT Enterprise and Edu; workspace owners and analytics viewers use the authenticated admin UI. This is not a service API and has no OAuth/API scopes for Metis. | The UI selects a reporting period and provides aggregate charts and CSV exports. OpenAI describes reporting as delayed rather than real time; regenerate an export for a later view. No API pagination or correction contract is published. | Human reporting only. An interactive page or downloaded CSV must not be scraped or treated as a capacity gate. Member-level visibility remains restricted to authorized workspace roles. |
| [Codex analytics for workspace administrators](https://developers.openai.com/codex/enterprise/analytics/) | Available through ChatGPT workspace administration for eligible managed workspaces. Access follows workspace-admin/analytics permissions; it does not establish an application credential for Metis. | Retrospective workspace/member aggregates over the dashboard's selected range. The documentation does not promise real-time delivery, cursor pagination, immutable rows, or a correction/finality cutoff. | Adoption and activity reporting only. Re-reading a range may change late data, so any future importer would upsert, not append blindly. |
| [Compliance API](https://help.openai.com/en/articles/9261474-compliance-api-for-enterprise-customers) | Enterprise-only, with a workspace-owner-created Compliance API key. It is a separate, highly privileged interface intended for compliance/eDiscovery integrations, not ordinary analytics. | Event retrieval is paginated and time-bounded according to the API documentation. It is an event feed, not an allowance ledger, and its retention/reporting behavior must be taken from the tenant's current API documentation before integration. | Out of scope for a capacity adapter. Do not create a key merely to obtain analytics, and never place such a key or event payloads in D1, issues, logs, or Terraform state. Compliance events can contain member and content metadata. |
| [OpenAI API organization usage and costs](https://platform.openai.com/docs/api-reference/usage) | OpenAI API organization owners can use an Admin API key with the organization usage endpoints. ChatGPT workspace membership and billing are separate from API-platform organization authorization. | Bucketed results accept time bounds, grouping dimensions, and page cursors; recent buckets can settle or be corrected. Endpoint-specific docs define available bucket widths and maximum ranges. | Authoritative only for separately metered **API-platform** activity. It does not report ChatGPT-plan Codex included usage and must never be joined into the included-capacity ledger as if it did. |
| [Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) | Plan and workspace policy determine access. A linked GitHub repository and a working Codex task demonstrate execution access, not analytics/admin eligibility. | Published plan limits vary with task size and other conditions; this product guidance is not a usage endpoint or a stable reset schedule. | Useful operator guidance only. It cannot supply a numeric scheduler input. |

The terms “admin,” “owner,” and “analytics viewer” are authorization boundaries, not merely display preferences. Metis must not broaden member-level access by copying analytics or compliance data into GitHub issues. Any future collection must minimize member identifiers, document retention, and expose aggregates only to an equivalently authorized audience.

## Signal matrix

Status meanings:

- **Supported**: an official surface reports the value authoritatively for its stated scope.
- **Delayed/aggregated**: officially reported, but unsuitable for real-time admission control.
- **Unsupported**: official documentation identifies no machine-readable ChatGPT-plan signal; do not derive it.
- **Unknown here**: product support may exist, but this repository cannot verify this workspace's entitlement or a stable field/semantic contract.

| Signal | Status for ChatGPT-plan Codex | Authoritative source, dimensions, and semantics |
| --- | --- | --- |
| Workspace/member adoption and activity | **Delayed/aggregated** | Workspace/Codex analytics UI and exports, for an authorized reporting window. Dimensions can include workspace members and product/activity groupings exposed by the current UI. They are not live scheduler inputs. |
| Codex activity counts/trends | **Delayed/aggregated** | Codex workspace analytics. Treat the selected date range and displayed aggregation as part of every observation; no finality promise is published. |
| Compliance events | **Supported, restricted** | Compliance API for eligible Enterprise workspaces and compliance purposes. Event identity is authoritative only within that feed; it is not usage, cost, or capacity. |
| OpenAI API requests, tokens, models, and spend | **Supported, separate scope** | API organization usage/cost endpoints, bucketed and cursor-paginated. These describe API-platform billing, not included ChatGPT/Codex allowance. |
| Included Codex allowance | **Unsupported** | No supported analytics/API field gives the workspace's numeric included allowance. Product-plan examples are not an account-specific entitlement API. |
| Included allowance remaining | **Unsupported** | No supported machine-readable balance. Never subtract observed activity from a plan example. |
| Purchased/shared credits or credit balance | **Unsupported for this ledger** | Billing UI observations are not a documented ChatGPT-plan analytics API. API-platform credit information, if visible to an owner, belongs to a different billing scope. |
| Limit/reset timestamp or rolling-window position | **Unsupported** | Product guidance about limit behavior is not an account-specific reset clock. Keep unknown. |
| Overage enabled, disabled, cap, or remaining overage | **Unsupported** | No supported workspace analytics field with a stable adapter contract was identified. Keep unknown and retain the explicit operator capacity gate. |
| Model per GitHub-dispatched task | **Unknown here** | A provider callback may explicitly report a model, but the GitHub connector and workspace aggregate analytics do not promise one. Do not infer it from defaults. |
| Input/output/cached tokens per GitHub-dispatched task | **Unknown here** | Preserve explicit callback values when a supported adapter supplies them. The GitHub connector does not, and API-platform token usage is a separate scope. |
| Execution surface (CLI, IDE, cloud/GitHub) | **Delayed/aggregated or unknown per task** | A workspace analytics UI may group activity by a documented surface. The GitHub issue/PR path is locally known as dispatch provenance, not provider-metering evidence. |
| Provider task/session identifier | **Unknown here** | Codex Cloud may expose a task link to the human handoff, but no documented analytics join key is promised across GitHub dispatch, workspace analytics, and compliance data. Store a provider ID only when a supported adapter returns one explicitly. |
| GitHub issue, pull request, repository, or Metis task ID | **Unsupported as provider analytics dimensions** | These are authoritative Metis/GitHub identifiers. No official workspace analytics contract promises them as dimensions. |
| Stable GitHub-to-provider correlation | **Unsupported** | The `Metis-Task` marker, lease marker, exact head SHA, and Codex task link reconcile Metis workflow events; they do not establish a supported provider-analytics join. Correlation must remain local/provenance-only. |
| Local estimated workload units | **Supported only as a Metis estimate** | The task ledger owns the estimate. It is never a provider usage, balance, or capacity signal. |

## Safe adapter and ledger boundary

1. Keep the current operator-controlled `available` gate authoritative for dispatch. Provider capacity remains unknown behind that gate.
2. Accept analytics only from a documented API or an explicit, authenticated adapter response. Do not scrape ChatGPT/Codex pages, automate CSV downloads, inspect browser traffic, or call undocumented endpoints.
3. Record provenance with every observation: provider and billing scope, official surface/endpoint and version, workspace or API organization (using a non-secret internal reference), requested source interval, bucket width, grouping dimensions, retrieval time, and page cursor/checkpoint.
4. Upsert delayed buckets by a deterministic key. Preserve `observed_at` and `retrieved_at`; permit later reads to replace corrected aggregates. Never convert absence, a partial page, or a delayed bucket to zero.
5. Keep three ledgers distinct: Metis estimates, ChatGPT-workspace aggregates, and OpenAI API-platform usage/cost. A query must never sum across those scopes without displaying the scopes separately.
6. Keep unavailable fields nullable and attach a reason such as `not_exposed`, `not_authorized`, `not_yet_reported`, or `different_billing_scope`. Do not synthesize provider task IDs, tokens, model, money, allowance, balance, reset time, or overage state.
7. Store no analytics or Compliance API credentials in source, Terraform state, D1, logs, model prompts, GitHub issues, or pull requests. If an approved future adapter needs a credential, use the platform secret store and return only minimized aggregates.
8. A reporting outage or late analytics is not a task failure and does not erase the first-class blocked state. It may make reporting stale, but it cannot by itself authorize metered fallback or additional dispatch.

## Verification required before any implementation

An authorized workspace owner must establish, outside this repository: the plan and analytics entitlement, permissible reporting roles, the exact current documentation for any chosen endpoint, retention/privacy approval, and a secret delivery path. Until all are established, the analytics adapter should have no ChatGPT-workspace network integration and should return capacity fields as unknown. This conclusion does not block the existing human-gated GitHub Codex driver.
