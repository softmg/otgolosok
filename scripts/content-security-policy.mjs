import { createHash } from "node:crypto";

// Static export has no request-time nonce, so inline bootstrap scripts are
// allowed by hash. frame-ancestors is ignored in <meta>; ingress sends it.
const directives = [
  ["default-src", "'self'"],
  ["style-src", "'self' 'unsafe-inline'"],
  ["img-src", "'self' data: blob: https://tile.openstreetmap.org"],
  ["font-src", "'self'"],
  ["connect-src", "'self'"],
  ["media-src", "'self'"],
  ["worker-src", "'self'"],
  ["manifest-src", "'self'"],
  ["object-src", "'none'"],
  ["base-uri", "'self'"],
  ["form-action", "'self'"],
];

const inlineScripts = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const existingPolicy = /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/gi;

export function inlineScriptHashes(html) {
  const hashes = new Set();
  for (const [, attributes, body] of html.matchAll(inlineScripts)) {
    if (/\ssrc\s*=/i.test(` ${attributes}`) || !body) continue;
    hashes.add(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
  return [...hashes].sort();
}

export function contentSecurityPolicy(scriptHashes) {
  const script = ["'self'", ...scriptHashes].join(" ");
  const [defaults, ...rest] = directives;
  return [defaults, ["script-src", script], ...rest]
    .map(([name, value]) => `${name} ${value}`)
    .join("; ");
}

/** Return the page with a policy meta tag that precedes every script. */
export function withContentSecurityPolicy(html) {
  const page = html.replace(existingPolicy, "");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(inlineScriptHashes(page))}"/>`;
  const anchor = /<meta\s+charset=["']?utf-8["']?\s*\/?>/i.exec(page) ?? /<head\b[^>]*>/i.exec(page);
  if (!anchor) throw new Error("Cannot place Content-Security-Policy: <head> is missing");
  const at = anchor.index + anchor[0].length;
  const result = page.slice(0, at) + meta + page.slice(at);
  const firstScript = result.search(/<script\b/i);
  if (firstScript !== -1 && firstScript < result.indexOf(meta)) {
    throw new Error("Cannot place Content-Security-Policy before the first script");
  }
  return result;
}
