allowed_repositories             = "noahpeters/metis-sandbox,noahpeters/metis,noahpeters/from-trees-studio,noahpeters/H2"
codex_dispatch_mode              = "github_integration"
codex_github_integration_enabled = true
github_app_id                    = "4772921"
github_app_installation_id       = "157788676"

metis_policy_json = "{\"global\":{\"maxConcurrentTasks\":1,\"maxEstimatedWorkloadUnitsPerWindow\":96,\"maxTasksPerWindow\":24,\"maxRetries\":2},\"providers\":{\"codex_included\":{\"enabled\":true},\"paid_api\":{\"enabled\":false},\"perplexity\":{\"enabled\":false}}}"

metis_lifecycle_policy_json = "{\"defaults\":{\"requiredApprovals\":1,\"requiredChecks\":true,\"maxRevisionAttempts\":2,\"deploymentWorkflows\":[],\"maxRecoveryAttempts\":2},\"repositories\":{\"noahpeters/metis-sandbox\":{\"requiredChecks\":false,\"deploymentWorkflows\":[\"Sandbox Deployment\"]},\"noahpeters/metis\":{\"requiredChecks\":true,\"deploymentWorkflows\":[\"CI\"]},\"noahpeters/from-trees-studio\":{\"requiredChecks\":true,\"deploymentWorkflows\":[\"CI\"]},\"noahpeters/H2\":{\"requiredChecks\":true,\"deploymentWorkflows\":[\"Storefront 1000078196\"]}}}"
