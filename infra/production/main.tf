# Cloudflare's identity provider supplies verified claims. No signing key or
# user credential is managed by Terraform or stored in its state.
resource "cloudflare_zero_trust_access_application" "metis_ui" {
  account_id       = var.cloudflare_account_id
  name             = "Metis administration"
  domain           = "metis.from-trees.com/*"
  type             = "self_hosted"
  session_duration = "8h"
  policies = [{
    name       = "Verified from-trees.com identities"
    precedence = 1
    decision   = "allow"
    include = [{
      email_domain = { domain = "from-trees.com" }
    }]
  }]

  destinations = [{
    type = "public"
    uri  = "metis.from-trees.com/*"
  }]
}
