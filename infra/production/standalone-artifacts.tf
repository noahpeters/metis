resource "cloudflare_r2_bucket" "metis_standalone_artifacts" {
  account_id = var.cloudflare_account_id
  name       = "metis-standalone-artifacts"
}
