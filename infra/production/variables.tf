variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the Metis production resources."
  type        = string
  default     = "125d8016e23830dcaf86de127ce90576"
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token. Supply with TF_VAR_cloudflare_api_token; never commit it."
  type        = string
  sensitive   = true
}

variable "allowed_repositories" {
  description = "Comma-separated repositories accepted by the production webhook. Empty keeps production inert."
  type        = string
  default     = ""
}

variable "metis_policy_json" {
  description = "Fail-closed production provider-gate and pacing policy."
  type        = string
  default     = "{\"global\":{\"maxConcurrentTasks\":2,\"maxEstimatedWorkloadUnitsPerWindow\":20,\"maxTasksPerWindow\":4,\"maxRetries\":2},\"providers\":{\"codex_included\":{\"enabled\":false},\"paid_api\":{\"enabled\":false},\"perplexity\":{\"enabled\":false}}}"
}

variable "metis_lifecycle_policy_json" {
  description = "Fail-closed repository merge, deployment, and recovery policy. Repositories must explicitly opt in."
  type        = string
  default     = "{\"defaults\":{\"requiredApprovals\":1,\"requiredChecks\":true,\"maxRevisionAttempts\":2,\"deploymentWorkflows\":[],\"maxRecoveryAttempts\":2},\"repositories\":{}}"
}

variable "codex_dispatch_mode" {
  description = "Codex launch driver. Keep disabled until the GitHub Codex integration is connected and tested."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "github_integration"], var.codex_dispatch_mode)
    error_message = "codex_dispatch_mode must be disabled or github_integration."
  }
}

variable "codex_github_integration_enabled" {
  description = "Explicit kill switch for included-capacity Codex cloud dispatch through GitHub."
  type        = bool
  default     = false
}

variable "github_app_id" {
  description = "GitHub App ID used for short-lived installation authentication."
  type        = string
  default     = ""
}

variable "github_app_installation_id" {
  description = "GitHub App installation ID scoped to the production repositories."
  type        = string
  default     = ""
}
