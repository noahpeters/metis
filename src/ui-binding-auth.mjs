const UI_WORKER_ZONE = "from-trees.com";

export function authorizeUiBinding(request) {
  const email = request.headers.get("X-Metis-Verified-Email")?.toLowerCase();
  // Cloudflare attaches CF-Worker to Worker fetch subrequests. Request code
  // cannot synthesize CF-* headers, so this binds the forwarded Access identity
  // to the Worker running on the fixed From Trees zone.
  const callerZone = request.headers.get("CF-Worker")?.toLowerCase();
  return Boolean(callerZone === UI_WORKER_ZONE && email && /^[^@]+@from-trees\.com$/.test(email));
}
