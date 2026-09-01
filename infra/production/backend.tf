terraform {
  # This bucket is bootstrapped once outside this stack. R2 implements the S3
  # conditional writes Terraform uses for native lock files.
  backend "s3" {
    bucket = "metis-terraform-state"
    key    = "production/terraform.tfstate"
    region = "auto"

    endpoints = {
      s3 = "https://125d8016e23830dcaf86de127ce90576.r2.cloudflarestorage.com"
    }

    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }
}
