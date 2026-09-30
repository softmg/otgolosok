// Reverse proxy to the ElevenLabs API for a backend whose own address ElevenLabs does not serve.
// Only /v1/* is forwarded, only from ALLOWED_IPS and only with the shared PROXY_TOKEN; nothing is cached or logged.
const UPSTREAM = "https://api.elevenlabs.io";
const FORWARDED = ["xi-api-key", "content-type", "accept"];

async function sameToken(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([given, expected].map(value => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  return crypto.subtle.timingSafeEqual(a, b);
}

// A leaked token alone is useless: requests are accepted only from the listed backend addresses.
const allowedIp = (request, env) => String(env.ALLOWED_IPS ?? "").split(",").map(value => value.trim()).filter(Boolean)
  .includes(request.headers.get("cf-connecting-ip") ?? "");

const proxy = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v1/")) return new Response("Not found", { status: 404 });
    if (!allowedIp(request, env) || !(await sameToken(request.headers.get("x-proxy-token"), env.PROXY_TOKEN))) return new Response("Forbidden", { status: 403 });
    if (!["GET", "POST"].includes(request.method)) return new Response("Method not allowed", { status: 405 });
    const headers = new Headers();
    for (const name of FORWARDED) { const value = request.headers.get(name); if (value) headers.set(name, value); }
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: request.method, headers, body: request.method === "POST" ? request.body : undefined, redirect: "manual",
    });
    const response = new Response(upstream.body, upstream);
    response.headers.set("cache-control", "no-store");
    return response;
  },
};

export default proxy;
