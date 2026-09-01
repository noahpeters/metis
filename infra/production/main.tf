locals {
  worker_name = "metis-control-plane"
  worker_url  = "https://${local.worker_name}.gr4gwzrfq2.workers.dev"
}

resource "cloudflare_d1_database" "metis" {
  account_id = var.cloudflare_account_id
  name       = "metis-production"
  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_queue" "dispatch" {
  account_id = var.cloudflare_account_id
  queue_name = "metis-dispatch"
}

resource "cloudflare_queue" "dead_letter" {
  account_id = var.cloudflare_account_id
  queue_name = "metis-dead-letter"
}

resource "cloudflare_queue_consumer" "dispatch" {
  account_id        = var.cloudflare_account_id
  queue_id          = cloudflare_queue.dispatch.id
  type              = "worker"
  script_name       = local.worker_name
  dead_letter_queue = cloudflare_queue.dead_letter.queue_name
  settings = {
    batch_size       = 5
    max_retries      = 3
    max_wait_time_ms = 5000
  }
}

resource "cloudflare_workers_cron_trigger" "lease_recovery" {
  account_id  = var.cloudflare_account_id
  script_name = local.worker_name
  schedules   = [{ cron = "*/10 * * * *" }]
}

resource "cloudflare_workers_script_subdomain" "metis" {
  account_id       = var.cloudflare_account_id
  script_name      = local.worker_name
  enabled          = true
  previews_enabled = false
}

resource "cloudflare_dns_record" "metis_ui" {
  zone_id = var.cloudflare_zone_id
  name    = var.metis_ui_hostname
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
}

resource "cloudflare_workers_route" "metis_ui" {
  zone_id = var.cloudflare_zone_id
  pattern = "${var.metis_ui_hostname}/*"
  script  = "metis-ui"
}

# Cloudflare's identity provider supplies verified claims. No signing key or
# user credential is managed by Terraform or stored in its state.
resource "cloudflare_zero_trust_access_application" "metis_ui" {
  account_id       = var.cloudflare_account_id
  name             = "Metis administration"
  domain           = var.metis_ui_hostname
  type             = "self_hosted"
  session_duration = "8h"
}

resource "cloudflare_zero_trust_access_policy" "metis_ui_verified_domain" {
  account_id     = var.cloudflare_account_id
  application_id = cloudflare_zero_trust_access_application.metis_ui.id
  name           = "Verified from-trees.com identities"
  precedence     = 1
  decision       = "allow"
  include = [{
    email_domain = { domain = "from-trees.com" }
  }]
}
