output "d1_database_id" {
  description = "Metis staging D1 database ID used by Wrangler migrations."
  value       = cloudflare_d1_database.metis.id
}

output "worker_url" {
  description = "Inert Metis staging health and webhook base URL."
  value       = local.worker_url
}
