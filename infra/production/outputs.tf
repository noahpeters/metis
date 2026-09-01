output "d1_database_id" {
  description = "Metis production D1 database ID used by Wrangler migrations."
  value       = cloudflare_d1_database.metis.id
}

output "worker_url" {
  description = "Inert Metis production health and webhook base URL."
  value       = local.worker_url
}

output "access_audience" {
  description = "Access application audience to configure as the UI Worker variable."
  value       = cloudflare_zero_trust_access_application.metis_ui.aud
}
