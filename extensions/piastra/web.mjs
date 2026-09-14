/**
 * Robust native web helpers for PiAstra custom tools.
 *
 * fetchPage({ url }, signal) and searchWeb({ query, max_results }, signal)
 * both return { text, details } and share a hardened HTTP(S) transport:
 *
 *  - native http/https requests (no browser rendering);
 *  - DNS resolution is performed once per hop, every resolved address is
 *    validated as public unicast (ipaddr.js, including IPv4-mapped IPv6
 *    forms), and the TCP/TLS connection is pinned to the validated IP so a
 *    later lookup cannot be rebinding to a private address;
 *  - every redirect is re-validated and bounded by MAX_REDIRECTS;
 *  - credentials and non-http(s) schemes are rejected;
 *  - 30s total timeout (combined with the caller signal);
 *  - response body is bounded to FETCH_READ_CAP bytes and the returned text
 *    is capped at FETCH_OUTPUT_CAP with explicit truncation markers;
 *  - content types are filtered to HTML/text/JSON/XML; HTML is extracted
 *    with html-to-text (readable blocks/code/links, scripts/styles/
 *    navigation omitted); clearly binary bodies are rejected;
 *
 * The network and DNS layers are injectable through createWebClient so unit
 * tests stay deterministic and require no API credentials.
 */
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { htmlToText as convertHtmlToText } from 'html-to-text';

export const FETCH_READ_CAP = 2 * 1024 * 1024; // ~2MB raw body cap
export const FETCH_OUTPUT_CAP = 40000; // returned text cap
export const MAX_REDIRECTS = 5;
export const SEARCH_TITLE_CAP = 200; // per-result title cap
export const SEARCH_URL_CAP = 2048; // per-result URL cap
export const SEARCH_CONTENT_CAP = 500; // per-result content cap
export const REQUEST_TIMEOUT_MS = 30000;
export const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

const HTML_TO_TEXT_OPTIONS = {
  wordwrap: false,
  baseElements: { selectors: ['body'] },
  selectors: [
    { selector: 'script', format: 'skip' },
    { selector: 'style', format: 'skip' },
    { selector: 'noscript', format: 'skip' },
    { selector: 'nav', format: 'skip' },
    { selector: 'header', format: 'skip' },
    { selector: 'footer', format: 'skip' },
    { selector: 'aside', format: 'skip' },
    { selector: 'img', format: 'skip' },
    { selector: 'h1', options: { uppercase: false } },
    { selector: 'h2', options: { uppercase: false } },
    { selector: 'h3', options: { uppercase: false } },
    { selector: 'h4', options: { uppercase: false } },
    { selector: 'h5', options: { uppercase: false } },
    { selector: 'h6', options: { uppercase: false } },
  ],
};

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/** Combine the caller signal with the 30s total timeout. */
function withTimeout(signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function hostnameForLookup(hostname) {
  const host = String(hostname || '');
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function getHeader(headers, name) {
  const source = headers || {};
  const lower = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(source, lower)) return source[lower];
  for (const key of Object.keys(source)) {
    if (key.toLowerCase() === lower) return source[key];
  }
  return undefined;
}

/** Resolve a hostname to all of its addresses (system getaddrinfo order). */
function dnsLookupAll(hostname, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(addresses || []);
    });
  });
}

/** True only for public unicast IPs. Mapped IPv6 (::ffff:a.b.c.d) is checked
 *  as its embedded IPv4 address so private mapped forms stay rejected. */
export function isPublicIp(address) {
  if (typeof address !== 'string' || !address.trim()) return false;
  let addr;
  try {
    addr = ipaddr.parse(address.trim());
  } catch {
    return false;
  }
  if (addr.kind() === 'ipv6' && typeof addr.isIPv4MappedAddress === 'function' && addr.isIPv4MappedAddress()) {
    addr = addr.toIPv4Address();
  }
  return addr.range() === 'unicast';
}

/** Parse and validate a fetch URL: http(s) only, no embedded credentials.
 *  Returns the URL object; host reachability is validated at DNS time. */
export function validateFetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('Provide a valid HTTP(S) URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Use an HTTP(S) URL.');
  }
  if (url.username || url.password) {
    throw new Error('URLs with credentials are not allowed.');
  }
  return url;
}

/** Resolve and validate every address for a host. Rejects if any resolved
 *  address is not public unicast (this closes the rebinding window). */
export async function resolvePublicAddresses(hostname, signal, lookup = dnsLookupAll) {
  const host = hostnameForLookup(hostname);
  const addresses = await lookup(host, signal);
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`Could not resolve host: ${hostname}.`);
  }
  const resolved = [];
  for (const entry of addresses) {
    const address = typeof entry === 'string' ? entry : entry?.address;
    if (!address || !isPublicIp(address)) {
      throw new Error(`Host ${hostname} resolves to a non-public address.`);
    }
    resolved.push({ address, family: typeof entry === 'string' ? undefined : entry?.family });
  }
  return resolved;
}

/** Content type kind: 'html', 'text', or null (unsupported). JSON and XML
 *  documents are treated as text alongside text/* responses. */
export function contentTypeKind(contentType) {
  const base = (contentType || '').split(';')[0].trim().toLowerCase();
  if (base === 'text/html' || base === 'application/xhtml+xml') return 'html';
  if (base.startsWith('text/')) return 'text';
  if (base === 'application/json' || base === 'application/xml') return 'text';
  return null;
}

/** Loose HTML sniff for responses without a content-type header. */
export function looksLikeHtml(text) {
  const head = String(text || '').slice(0, 2000);
  return /^\s*<!doctype\s+html/i.test(head)
    || /<html[\s>]/i.test(head)
    || /<head[\s>]/i.test(head)
    || /<body[\s>]/i.test(head);
}

/** True when a body is clearly binary rather than text: NUL bytes, or a
 *  replacement-character-heavy decode (invalid UTF-8 sequences). */
export function isBinaryBody(buffer, text) {
  if (buffer && typeof buffer.includes === 'function' && buffer.includes(0)) {
    return true;
  }
  const decoded = String(text ?? '');
  if (!decoded) return false;
  let replacements = 0;
  for (const char of decoded) {
    if (char === '\uFFFD') replacements += 1;
  }
  return replacements > 0 && replacements >= Math.max(4, Math.ceil(decoded.length * 0.01));
}

/** HTML -> readable text using html-to-text (blocks/code/links; omits
 *  scripts, styles and navigation), then normalizes whitespace. */
export function htmlToText(html) {
  const text = convertHtmlToText(String(html ?? ''), HTML_TO_TEXT_OPTIONS);
  return text
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function validateSearchQuery(query) {
  if (typeof query !== 'string') throw new Error('Supply a search query.');
  const trimmed = query.trim();
  if (!trimmed) throw new Error('Supply a search query.');
  if (trimmed.length > 400) throw new Error('Search query is too long (max 400 characters).');
  return trimmed;
}

export function validateMaxResults(maxResults) {
  if (maxResults === undefined || maxResults === null) return 5;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
    throw new Error('max_results must be an integer between 1 and 10.');
  }
  return maxResults;
}

function capField(value, cap) {
  const str = typeof value === 'string' ? value : '';
  return str.length > cap ? str.slice(0, cap) : str;
}

/** Render capped search results to text plus details, marking output
 *  truncation when the rendered text exceeds the output cap. Exported so the
 *  truncation marker is unit-testable without a live Tavily account. */
export function formatSearchResults(query, results, outputCap = FETCH_OUTPUT_CAP) {
  const rendered = results
    .map((entry, index) => {
      const title = capField(typeof entry?.title === 'string' && entry.title ? entry.title : '(untitled)', SEARCH_TITLE_CAP);
      const href = capField(typeof entry?.url === 'string' ? entry.url : '', SEARCH_URL_CAP);
      const content = capField(typeof entry?.content === 'string' ? entry.content : '', SEARCH_CONTENT_CAP);
      return `${index + 1}. ${title}\n   ${href}\n   ${content}`;
    })
    .join('\n');
  const baseText = rendered ? `Untrusted search results for: ${query}\n${rendered}` : `(no results for: ${query})`;
  const outputTruncated = baseText.length > outputCap;
  const text = outputTruncated
    ? `${baseText.slice(0, outputCap)}\n[Output truncated at ${outputCap} characters; retry with fewer or narrower results.]`
    : baseText;
  const details = results.map((entry) => ({
    title: capField(typeof entry?.title === 'string' ? entry.title : '', SEARCH_TITLE_CAP),
    url: capField(typeof entry?.url === 'string' ? entry.url : '', SEARCH_URL_CAP),
    content: capField(typeof entry?.content === 'string' ? entry.content : '', SEARCH_CONTENT_CAP),
  }));
  return { text, outputTruncated, details };
}

function decodeBody(buffer, contentType) {
  const match = /charset\s*=\s*"?([\w.-]+)"?/i.exec(contentType || '');
  const label = match ? match[1] : 'utf-8';
  try {
    return new TextDecoder(label).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

function collectBody(stream, maxBytes, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (fn) => (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };
    const onAbort = () => {
      try { stream.destroy(); } catch { /* already destroyed */ }
      settle(reject)(abortError());
    };
    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        const keep = maxBytes - (size - chunk.length);
        if (keep > 0) chunks.push(chunk.subarray(0, keep));
        try { stream.destroy(); } catch { /* already destroyed */ }
        settle(resolve)({ body: Buffer.concat(chunks), truncated: true });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => settle(resolve)({ body: Buffer.concat(chunks), truncated: false });
    const onError = (error) => settle(reject)(error);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

/** Build the pinned connection options. `host` is the validated IP while the
 *  Host header keeps the original authority. SNI and certificate verification
 *  must use the original hostname (never the pinned IP), so servername is set
 *  only for non-IP hostnames; IP literal URLs verify against the IP itself. */
export function buildRequestOptions(url, address, options) {
  const { method = 'GET', headers = {}, signal } = options;
  const isHttps = url.protocol === 'https:';
  const hostname = hostnameForLookup(url.hostname);
  const port = url.port ? Number(url.port) : (isHttps ? 443 : 80);
  const requestOptions = {
    host: address.address,
    family: address.family,
    port,
    path: `${url.pathname}${url.search}`,
    method,
    headers: { ...headers, host: url.host },
    signal,
  };
  if (isHttps && !ipaddr.isValid(hostname)) {
    requestOptions.servername = hostname;
  }
  return requestOptions;
}

/** Perform one request pinned to a validated IP address. Host header and TLS
 *  SNI keep the original hostname so certificate checks and virtual hosting
 *  still work while the socket never re-resolves DNS. */
function requestToAddress(url, address, options) {
  const { body, signal, maxBytes = FETCH_READ_CAP } = options;
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const requestOptions = buildRequestOptions(url, address, options);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn) => (value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = lib.request(requestOptions, (res) => {
      collectBody(res, maxBytes, signal).then(
        (collected) => settle(resolve)({ statusCode: res.statusCode, headers: res.headers, ...collected }),
        (error) => settle(reject)(error),
      );
    });
    req.on('error', (error) => settle(reject)(error));
    if (body) req.write(body);
    req.end();
  });
}

const CONNECTION_ERRORS = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH',
  'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN',
]);

function isConnectionError(error) {
  return CONNECTION_ERRORS.has(error?.code);
}

/** Default transport: try validated addresses in order, failing over only for
 *  connection-level errors on idempotent (bodyless) requests. */
async function nativeRequest(target, options) {
  const { url, addresses } = target;
  const canRetry = !options.body;
  let lastError;
  for (const address of addresses) {
    try {
      return await requestToAddress(url, address, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!canRetry || !isConnectionError(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function fetchText({ url: rawUrl }, signal, lookup, request) {
  const finalSignal = withTimeout(signal);
  let current = validateFetchUrl(rawUrl);
  let redirects = 0;

  while (true) {
    finalSignal.throwIfAborted();
    if (redirects > MAX_REDIRECTS) {
      throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
    }
    const addresses = await resolvePublicAddresses(current.hostname, finalSignal, lookup);
    const { statusCode, headers, body, truncated } = await request(
      { url: current, addresses },
      {
        method: 'GET',
        headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
        signal: finalSignal,
        maxBytes: FETCH_READ_CAP,
      },
    );

    if (statusCode >= 300 && statusCode < 400) {
      redirects += 1;
      if (redirects > MAX_REDIRECTS) {
        throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
      }
      const location = getHeader(headers, 'location');
      if (!location) throw new Error(`HTTP ${statusCode} redirect without a Location header.`);
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error(`Invalid redirect Location: ${String(location).slice(0, 200)}.`);
      }
      current = validateFetchUrl(next);
      continue;
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Fetch failed: HTTP ${statusCode}.`);
    }

    const contentType = getHeader(headers, 'content-type') || '';
    const baseType = contentType.split(';')[0].trim().toLowerCase();
    const bodyText = decodeBody(body, contentType);
    let kind = contentTypeKind(baseType);
    if (!kind && !baseType) {
      if (isBinaryBody(body, bodyText)) {
        throw new Error('Fetch failed: response body looks binary (no content type).');
      }
      kind = looksLikeHtml(bodyText) ? 'html' : 'text';
    }
    if (!kind) throw new Error(`Unsupported content type: ${baseType || '(none)'}.`);

    const text = kind === 'html' ? htmlToText(bodyText) : bodyText;
    const outputTruncated = text.length > FETCH_OUTPUT_CAP;
    const capped = text.slice(0, FETCH_OUTPUT_CAP);
    const markers = [];
    if (truncated) markers.push('[Read truncated at ~2MB; fetch the page directly for the remainder.]');
    if (outputTruncated) markers.push(`[Output truncated at ${FETCH_OUTPUT_CAP} characters; fetch the page directly for the remainder.]`);
    const suffix = markers.length ? `\n${markers.join(' ')}` : '';
    return {
      text: `Source: ${current.href}\nUntrusted reference content:\n${capped}${suffix}`,
      details: {
        url: current.href,
        contentType: baseType || null,
        redirects,
        readBytes: body?.length || 0,
        readTruncated: !!truncated,
        outputTruncated,
      },
    };
  }
}

async function tavilySearch({ query, max_results }, signal, lookup, request, env) {
  const q = validateSearchQuery(query);
  const count = validateMaxResults(max_results);
  const apiKey = env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('Web search needs TAVILY_API_KEY in the environment.');
  const finalSignal = withTimeout(signal);
  const targetUrl = new URL(TAVILY_ENDPOINT);
  const addresses = await resolvePublicAddresses(targetUrl.hostname, finalSignal, lookup);
  const payload = JSON.stringify({
    api_key: apiKey,
    query: q,
    max_results: count,
    search_depth: 'basic',
    include_answer: false,
  });
  let response;
  try {
    response = await request(
      { url: targetUrl, addresses },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: payload,
        signal: finalSignal,
        maxBytes: 1024 * 1024,
      },
    );
  } catch (error) {
    // Never reflect the request body/headers (the API key) into diagnostics.
    throw new Error(`Search request failed${error?.code ? ` (${error.code})` : ''}.`);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Search failed: HTTP ${response.statusCode}.`);
  }
  if (response.truncated) {
    throw new Error('Search failed: response was truncated before completion.');
  }
  let parsed;
  try {
    parsed = JSON.parse(response.body?.toString('utf8') || '{}');
  } catch {
    throw new Error('Search failed: invalid JSON response.');
  }
  const results = Array.isArray(parsed?.results) ? parsed.results.slice(0, count) : [];
  const formatted = formatSearchResults(q, results);
  return {
    text: formatted.text,
    details: {
      provider: 'Tavily',
      query: q,
      max_results: count,
      outputTruncated: formatted.outputTruncated,
      results: formatted.details,
    },
  };
}

/** Build a web client with injectable request, DNS lookup and environment.
 *  Defaults use the native pinned transport above. */
export function createWebClient(deps = {}) {
  const lookup = deps.lookup || dnsLookupAll;
  const request = deps.request || nativeRequest;
  const env = deps.env || process.env;

  async function fetchPage({ url } = {}, signal) {
    return fetchText({ url }, signal, lookup, request);
  }

  async function searchWeb({ query, max_results } = {}, signal) {
    return tavilySearch({ query, max_results }, signal, lookup, request, env);
  }

  return { fetchPage, searchWeb };
}

const defaultClient = createWebClient();
export const fetchPage = defaultClient.fetchPage;
export const searchWeb = defaultClient.searchWeb;
