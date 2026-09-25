import { BlockList, isIP } from 'node:net';
import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';

const v4Blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) v4Blocked.addSubnet(address, prefix, 'ipv4');

const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const v6Blocked = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['3fff::', 20],
]) v6Blocked.addSubnet(address, prefix, 'ipv6');

const codes = new Set([
  'INVALID_URL', 'DNS_REJECTED', 'TIMEOUT', 'ABORTED', 'NETWORK_ERROR',
  'REDIRECT_LIMIT', 'BAD_STATUS', 'BAD_CONTENT_TYPE', 'SOURCE_TOO_LARGE',
]);
const acceptedTypes = new Set(['text/html', 'application/xhtml+xml', 'text/plain', 'application/pdf']);

function problem(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function publicHostName(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host && host.includes('.') && host !== 'localhost' &&
    !host.endsWith('.local') && !host.endsWith('.internal');
}

function bareAddress(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1) : hostname;
}

/** Return true only for addresses that are suitable public Internet targets. */
export function isPublicAddress(ip) {
  const family = isIP(ip);
  if (family === 4) return !v4Blocked.check(ip, 'ipv4');
  if (family !== 6) return false;
  // Restricting to 2000::/3 rejects mapped IPv4, loopback, ULA and link-local.
  return globalV6.check(ip, 'ipv6') && !v6Blocked.check(ip, 'ipv6');
}

/** Parse and apply URL policy.  The returned URL is normalized by WHATWG URL. */
export function validateSourceUrl(input) {
  if (typeof input !== 'string' || input.length > 2000) throw problem('INVALID_URL');
  let url;
  try { url = new URL(input); } catch { throw problem('INVALID_URL'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username || url.password || url.port || url.href.length > 2000) {
    throw problem('INVALID_URL');
  }
  const address = bareAddress(url.hostname);
  if (isIP(address)) {
    if (!isPublicAddress(address)) throw problem('INVALID_URL');
  } else if (!publicHostName(url.hostname)) {
    throw problem('INVALID_URL');
  }
  return url;
}

function abortable(value, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || problem('ABORTED'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || problem('ABORTED'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() =>
      signal.removeEventListener('abort', onAbort));
  });
}

async function resolvePublic(url, lookup, signal) {
  const literal = bareAddress(url.hostname);
  if (isIP(literal)) return [{ address: literal, family: isIP(literal) }];
  let records;
  try {
    records = await abortable(lookup(url.hostname, { all: true, verbatim: true }), signal);
  } catch {
    if (signal.aborted) throw signal.reason || problem('ABORTED');
    throw problem('DNS_REJECTED');
  }
  if (!Array.isArray(records) || !records.length ||
      records.some(({ address }) => !isPublicAddress(address))) throw problem('DNS_REJECTED');
  return records.map(({ address, family }) => ({ address, family: family || isIP(address) }));
}

function contentType(headers) {
  const value = headers?.['content-type'];
  const type = Array.isArray(value) ? value[0] : value;
  return typeof type === 'string' ? type.split(';', 1)[0].trim().toLowerCase() : '';
}

function requestOnce(url, addresses, request, signal, limits) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason || problem('ABORTED'));
    let done = false;
    let req;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => {
      finish(signal.reason || problem('ABORTED'));
      req?.destroy?.();
    };
    const lookup = (_host, options, callback) => {
      if (options?.all) return callback(null, addresses);
      const first = addresses[0];
      callback(null, first.address, first.family);
    };
    const addressHost = bareAddress(url.hostname);
    const options = {
      protocol: url.protocol, hostname: addressHost, port: url.port || undefined,
      path: `${url.pathname}${url.search}`, method: 'GET', lookup,
      headers: { Host: url.host, Accept: 'text/html,application/xhtml+xml,text/plain,application/pdf', 'Accept-Encoding': 'identity', 'User-Agent': 'Otgolosok/0.1 (+https://otgolosok.online)' },
      servername: isIP(addressHost) ? undefined : addressHost, rejectUnauthorized: true,
    };
    try {
      req = request(options, (response) => {
        response.once('error', () => finish(problem('NETWORK_ERROR')));
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          finish(null, { redirect: response.headers?.location });
          return response.destroy?.();
        }
        if (status !== 200) {
          finish(problem('BAD_STATUS',{status,retryable:status===429||status>=500}));
          return response.destroy?.();
        }
        const type = contentType(response.headers);
        if (!acceptedTypes.has(type)) {
          finish(problem('BAD_CONTENT_TYPE'));
          return response.destroy?.();
        }
        const maximum = type === 'application/pdf' ? limits.maxPdfBytes : limits.maxTextBytes;
        const length = Number(response.headers?.['content-length']);
        if (Number.isFinite(length) && length > maximum) {
          finish(problem('SOURCE_TOO_LARGE',{contentType:type,maximumBytes:maximum,declaredBytes:length}));
          return response.destroy?.();
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += Buffer.byteLength(chunk);
          if (size > maximum) {
            finish(problem('SOURCE_TOO_LARGE',{contentType:type,maximumBytes:maximum,receivedBytes:size}));
            response.destroy?.();
          } else chunks.push(Buffer.from(chunk));
        });
        response.once('end', () => {
          const bytes = Buffer.concat(chunks);
          const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(response.headers?.['content-type'] ?? '')?.[1] ?? 'utf-8';
          try { finish(null, type === 'application/pdf' ? { type, bytes } : { type, html: new TextDecoder(charset).decode(bytes) }); }
          catch { finish(problem('BAD_CONTENT_TYPE')); }
        });
      });
      signal.addEventListener('abort', onAbort, { once: true });
      req.once?.('error', () => finish(problem('NETWORK_ERROR')));
      if (signal.aborted) return onAbort();
      req.end();
    } catch { finish(problem('NETWORK_ERROR')); }
  });
}

/** Fetch one small, public text source, pinning each DNS resolution to a checked IP. */
export async function fetchSource(input, {
  signal, timeoutMs = 30000, maxBytes, maxTextBytes = 1200000, maxPdfBytes = 25 * 1024 * 1024,
  lookup = dns.promises.lookup, request,
} = {}) {
  if (maxBytes !== undefined) maxTextBytes = maxPdfBytes = maxBytes;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(maxTextBytes) || maxTextBytes < 0 || !Number.isFinite(maxPdfBytes) || maxPdfBytes < 0) {
    throw problem('INVALID_URL');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(problem('TIMEOUT')), timeoutMs);
  const relay = () => controller.abort(signal.reason || problem('ABORTED'));
  if (signal) {
    if (signal.aborted) relay(); else signal.addEventListener('abort', relay, { once: true });
  }
  try {
    let url = validateSourceUrl(input);
    for (let redirects = 0; ; redirects++) {
      const addresses = await resolvePublic(url, lookup, controller.signal);
      const transport = url.protocol === 'https:' ? https : http;
      const result = await requestOnce(url, addresses, request || transport.request.bind(transport), controller.signal, {maxTextBytes,maxPdfBytes});
      if (!('redirect' in result)) return result.type === 'application/pdf'
        ? { url: url.href, contentType: result.type, bytes: result.bytes }
        : { url: url.href, contentType: result.type, html: result.html };
      if (!result.redirect) throw problem('BAD_STATUS');
      if (redirects >= 3) throw problem('REDIRECT_LIMIT');
      try { url = validateSourceUrl(new URL(result.redirect, url).href); }
      catch (error) { throw codes.has(error?.code) ? error : problem('INVALID_URL'); }
    }
  } catch (error) {
    if (codes.has(error?.code)) throw error;
    throw problem(controller.signal.aborted ? (controller.signal.reason?.code || 'ABORTED') : 'NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relay);
  }
}
