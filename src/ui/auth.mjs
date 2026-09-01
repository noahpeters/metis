export function emailAllowed(email, domain = "from-trees.com") {
  const normalized = String(email || "").trim().toLowerCase();
  return normalized.endsWith(`@${domain}`) && normalized.slice(0, -(domain.length + 1)).length > 0;
}

export async function authenticate(request, env) {
  if (env.ENVIRONMENT === "local" && env.LOCAL_AUTH_ENABLED === "true") {
    if (!env.LOCAL_AUTH_EMAIL || !emailAllowed(env.LOCAL_AUTH_EMAIL)) throw new Error("Invalid local identity configuration");
    return { email: env.LOCAL_AUTH_EMAIL.toLowerCase(), subject: "local-development" };
  }
  if (env.LOCAL_AUTH_ENABLED === "true") throw new Error("Local authentication is forbidden outside local development");
  const email = request.headers.get("Cf-Access-Authenticated-User-Email");
  if (!emailAllowed(email)) throw new Error("Identity is not authorized");
  return { email: email.toLowerCase(), subject: "cloudflare-access" };
}
