# Metis standalone dispatch proof artifact storage.
# Apply through the existing Terraform-managed Cloudflare deployment workflow.
# This resource must use the same Cloudflare provider/account configuration as Metis.
resource "cloudflare_r2_bucket" "metis_standalone_artifacts" {
  account_id = var.cloudflare_account_id
  name       = "metis-standalone-artifacts"
}
