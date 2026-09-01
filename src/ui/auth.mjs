const encoder = new TextEncoder();

function decode(value) {
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0))));
}

export function emailAllowed(email, domain = "from-trees.com") {
  const normalized = String(email || "").trim().toLowerCase();
  return normalized.endsWith(`@${domain}`) && normalized.slice(0, -(domain.length + 1)).length > 0;
}

export async function verifyAccessJwt(token, config, fetcher = fetch, now = Date.now()) {
  if (!token || !config.teamDomain || !config.audience) throw new Error("Access authentication is not configured");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed Access assertion");
  const header = decode(parts[0]);
  const claims = decode(parts[1]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported Access assertion");
  const issuer = `https://${config.teamDomain}.cloudflareaccess.com`;
  if (claims.iss !== issuer || claims.aud !== config.audience || !claims.exp || claims.exp * 1000 <= now) throw new Error("Invalid Access claims");
  if (!emailAllowed(claims.email, config.emailDomain)) throw new Error("Identity is not authorized");
  const response = await fetcher(`${issuer}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error("Unable to load Access signing keys");
  const jwk = (await response.json()).keys?.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) throw new Error("Unknown Access signing key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signature = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, encoder.encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error("Invalid Access signature");
  return { email: claims.email.toLowerCase(), subject: claims.sub };
}

export async function authenticate(request, env) {
  if (env.ENVIRONMENT === "local" && env.LOCAL_AUTH_ENABLED === "true") {
    if (!env.LOCAL_AUTH_EMAIL || !emailAllowed(env.LOCAL_AUTH_EMAIL)) throw new Error("Invalid local identity configuration");
    return { email: env.LOCAL_AUTH_EMAIL.toLowerCase(), subject: "local-development" };
  }
  if (env.LOCAL_AUTH_ENABLED === "true") throw new Error("Local authentication is forbidden outside local development");
  return verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), {
    teamDomain: env.CLOUDFLARE_ACCESS_TEAM_DOMAIN,
    audience: env.CLOUDFLARE_ACCESS_AUDIENCE,
    emailDomain: "from-trees.com",
  });
}
