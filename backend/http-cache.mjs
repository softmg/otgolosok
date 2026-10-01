import { brotliCompressSync, gzipSync, constants } from "node:zlib";
import { etagOf } from "./map-cells.mjs";

const CACHE_CONTROL = "no-cache";
const VARY = "Accept-Encoding";
const COMPRESSED_LIMIT = 32;
/** @type {Map<string, Buffer>} */
const compressed = new Map();

/** Weak comparison per RFC 9110: `W/` is ignored, `*` matches any current representation. */
export function matchesIfNoneMatch(header, etag) {
  if (typeof header !== "string" || !header.trim()) return false;
  return header.split(",").some(value => {
    const tag = value.trim();
    return tag === "*" || tag.replace(/^W\//, "") === `"${etag}"`;
  });
}

/** Picks br, then gzip, then identity; an encoding listed with q=0 is refused. */
export function negotiateEncoding(header) {
  if (typeof header !== "string") return "identity";
  const weights = new Map();
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = params.map(param => /^\s*q=([0-9.]+)\s*$/.exec(param)).find(Boolean);
    weights.set(name.trim(), q ? Number(q[1]) : 1);
  }
  const accepts = name => {
    const weight = weights.get(name) ?? weights.get("*");
    return weight !== undefined && weight > 0;
  };
  return accepts("br") ? "br" : accepts("gzip") ? "gzip" : "identity";
}

function encode(body, etag, encoding) {
  const key = `${etag}:${encoding}`;
  const cached = compressed.get(key);
  if (cached) {
    compressed.delete(key);
    compressed.set(key, cached);
    return cached;
  }
  // Sync zlib keeps the code simple: bodies stay around 1 MB, compressing them costs tens of milliseconds
  // and happens only on a cache miss per ETag. Switch to async zlib if profiling shows event-loop stalls.
  const buffer = encoding === "br"
    ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(body) } })
    : gzipSync(body);
  compressed.set(key, buffer);
  if (compressed.size > COMPRESSED_LIMIT) compressed.delete(/** @type {string} */ (compressed.keys().next().value));
  return buffer;
}

/**
 * Public, revalidated JSON: strong content ETag, `no-cache` (always revalidate, 304 when unchanged) and br/gzip.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {string} body already serialized JSON
 */
export function sendCacheableJson(req, res, body) {
  const etag = etagOf(body);
  const common = { ETag: `"${etag}"`, "Cache-Control": CACHE_CONTROL, Vary: VARY, "X-Content-Type-Options": "nosniff" };
  if (matchesIfNoneMatch(req.headers["if-none-match"], etag)) {
    res.writeHead(304, common);
    res.end();
    return;
  }
  const encoding = negotiateEncoding(req.headers["accept-encoding"]);
  const payload = encoding === "identity" ? Buffer.from(body) : encode(body, etag, encoding);
  res.writeHead(200, {
    ...common,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    ...(encoding === "identity" ? {} : { "Content-Encoding": encoding }),
  });
  res.end(req.method === "HEAD" ? undefined : payload);
}
