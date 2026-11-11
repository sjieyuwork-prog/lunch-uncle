/**
 * Helpers shared by the Worker's endpoints.
 */

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Count this request against its client's limit, set in wrangler.toml and
 * shared by /chat and /places. Without the CHAT_LIMITER binding, as in
 * tests, nothing is limited.
 */
export async function withinRateLimit(request, env) {
  if (!env.CHAT_LIMITER) {
    return true;
  }
  // The hostname keeps apart Workers that share a limiter namespace.
  const { hostname } = new URL(request.url);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.CHAT_LIMITER.limit({
    key: `${hostname} ${ip}`,
  });
  return success;
}
