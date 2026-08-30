locals {
  worker_name = "metis-control-plane-staging"
  worker_url  = "https://${local.worker_name}.gr4gwzrfq2.workers.dev"
}

resource "cloudflare_d1_database" "metis" {
  account_id = var.cloudflare_account_id
  name       = "metis-staging"
  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_queue" "dispatch" {
  account_id = var.cloudflare_account_id
  queue_name = "metis-dispatch-staging"
}

resource "cloudflare_queue" "dead_letter" {
  account_id = var.cloudflare_account_id
  queue_name = "metis-dead-letter-staging"
}

resource "cloudflare_workers_script" "metis" {
  account_id         = var.cloudflare_account_id
  script_name        = local.worker_name
  compatibility_date = "2026-08-30"
  content_file       = "${path.module}/../../.build/index.js"
  content_sha256     = filesha256("${path.module}/../../.build/index.js")
  content_type       = "application/javascript+module"
  main_module        = "index.js"

  bindings = [
    { name = "AI", type = "ai" },
    { name = "ALLOWED_REPOSITORIES", type = "plain_text", text = var.allowed_repositories },
    { name = "CODEX_DISPATCH_MODE", type = "plain_text", text = var.codex_dispatch_mode },
    { name = "CODEX_GITHUB_INTEGRATION_ENABLED", type = "plain_text", text = tostring(var.codex_github_integration_enabled) },
    { name = "GITHUB_APP_ID", type = "plain_text", text = var.github_app_id },
    { name = "GITHUB_APP_INSTALLATION_ID", type = "plain_text", text = var.github_app_installation_id },
    { name = "DB", type = "d1", database_id = cloudflare_d1_database.metis.id },
    { name = "DISPATCH_QUEUE", type = "queue", queue_name = cloudflare_queue.dispatch.queue_name },
    { name = "METIS_POLICY_JSON", type = "plain_text", text = var.metis_policy_json },
    { name = "PUBLIC_BASE_URL", type = "plain_text", text = local.worker_url },
  ]
}

resource "cloudflare_queue_consumer" "dispatch" {
  account_id        = var.cloudflare_account_id
  queue_id          = cloudflare_queue.dispatch.id
  type              = "worker"
  script_name       = cloudflare_workers_script.metis.script_name
  dead_letter_queue = cloudflare_queue.dead_letter.queue_name
  settings = {
    batch_size       = 5
    max_retries      = 3
    max_wait_time_ms = 5000
  }
}

resource "cloudflare_workers_cron_trigger" "lease_recovery" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.metis.script_name
  schedules   = [{ cron = "*/10 * * * *" }]
}

resource "cloudflare_workers_script_subdomain" "metis" {
  account_id       = var.cloudflare_account_id
  script_name      = cloudflare_workers_script.metis.script_name
  enabled          = true
  previews_enabled = false
}
