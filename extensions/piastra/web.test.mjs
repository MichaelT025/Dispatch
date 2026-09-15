import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequestOptions,
  contentTypeKind,
  createWebClient,
  formatSearchResults,
  htmlToText,
  isBinaryBody,
  isPublicIp,
  looksLikeHtml,
  resolvePublicAddresses,
  validateFetchUrl,
  validateMaxResults,
  validateSearchQuery,
} from './web.mjs';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function textResponse(body, statusCode = 200, headers = { 'content-type': 'text/plain' }) {
  return { statusCode, headers, body: Buffer.from(body), truncated: false };
}

function htmlResponse(body, statusCode = 200) {
  return textResponse(body, statusCode, { 'content-type': 'text/html; charset=utf-8' });
}

function makeRequest(handler) {
  const calls = [];
  const request = async (target, options) => {
    calls.push({ target, options });
    return handler(target, options, calls.length - 1);
  };
  return { request, calls };
}

test('validateFetchUrl accepts http(s) and rejects credentials, wrong schemes and bad input', () => {
  assert.equal(validateFetchUrl('https://example.com/docs?q=1').href, 'https://example.com/docs?q=1');
  assert.equal(validateFetchUrl('http://example.com/').protocol, 'http:');
  assert.throws(() => validateFetchUrl('ftp://example.com/'), /HTTP\(S\)/);
  assert.throws(() => validateFetchUrl('javascript:alert(1)'), /HTTP\(S\)/);
  assert.throws(() => validateFetchUrl('file:///etc/passwd'), /HTTP\(S\)/);
  assert.throws(() => validateFetchUrl('http://user:pass@example.com/'), /credentials/);
  assert.throws(() => validateFetchUrl('https://user@example.com/'), /credentials/);
  assert.throws(() => validateFetchUrl('not a url'), /valid HTTP\(S\)/);
});

test('isPublicIp accepts public unicast and rejects private/reserved/mapped forms', () => {
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('1.1.1.1'), true);
  assert.equal(isPublicIp('2001:4860:4860::8888'), true);
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);
  assert.equal(isPublicIp('127.0.0.1'), false);
  assert.equal(isPublicIp('10.0.0.1'), false);
  assert.equal(isPublicIp('172.16.0.1'), false);
  assert.equal(isPublicIp('172.31.255.255'), false);
  assert.equal(isPublicIp('192.168.1.1'), false);
  assert.equal(isPublicIp('169.254.169.254'), false);
  assert.equal(isPublicIp('100.64.0.1'), false);
  assert.equal(isPublicIp('0.0.0.0'), false);
  assert.equal(isPublicIp('255.255.255.255'), false);
  assert.equal(isPublicIp('224.0.0.1'), false);
  assert.equal(isPublicIp('::1'), false);
  assert.equal(isPublicIp('::'), false);
  assert.equal(isPublicIp('fe80::1'), false);
  assert.equal(isPublicIp('fc00::1'), false);
  assert.equal(isPublicIp('2001:db8::1'), false);
  assert.equal(isPublicIp('ff02::1'), false);
  assert.equal(isPublicIp('::ffff:8.8.8.8'), true);
  assert.equal(isPublicIp('::ffff:10.0.0.1'), false);
  assert.equal(isPublicIp('::ffff:192.168.1.1'), false);
  assert.equal(isPublicIp('2002::1'), false);
  assert.equal(isPublicIp('64:ff9b::8.8.8.8'), false);
  assert.equal(isPublicIp('not-an-ip'), false);
  assert.equal(isPublicIp(''), false);
  assert.equal(isPublicIp(null), false);
});

test('resolvePublicAddresses pins public addresses and rejects any non-public entry', async () => {
  const resolved = await resolvePublicAddresses('example.com', undefined, async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]);
  assert.deepEqual(resolved.map(a => a.address), ['8.8.8.8', '2606:4700:4700::1111']);
  await assert.rejects(
    () => resolvePublicAddresses('example.com', undefined, async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '192.168.1.1', family: 4 },
    ]),
    /non-public/,
  );
  await assert.rejects(
    () => resolvePublicAddresses('example.com', undefined, async () => []),
    /Could not resolve/,
  );
});

test('contentTypeKind classifies html/text/json/xml and filters everything else', () => {
  assert.equal(contentTypeKind('text/html; charset=utf-8'), 'html');
  assert.equal(contentTypeKind('application/xhtml+xml'), 'html');
  assert.equal(contentTypeKind('text/plain'), 'text');
  assert.equal(contentTypeKind('text/markdown'), 'text');
  assert.equal(contentTypeKind('text/xml'), 'text');
  assert.equal(contentTypeKind('application/json'), 'text');
  assert.equal(contentTypeKind('application/json; charset=utf-8'), 'text');
  assert.equal(contentTypeKind('application/xml'), 'text');
  assert.equal(contentTypeKind('image/png'), null);
  assert.equal(contentTypeKind('application/octet-stream'), null);
  assert.equal(contentTypeKind(''), null);
});

test('looksLikeHtml sniffs markup without a content type', () => {
  assert.ok(looksLikeHtml('<!DOCTYPE html><html><body>x</body></html>'));
  assert.ok(looksLikeHtml('<html><body>x</body></html>'));
  assert.ok(looksLikeHtml('<body>x</body>'));
  assert.ok(!looksLikeHtml('plain text'));
});

test('isBinaryBody detects NUL bytes and replacement-heavy text', () => {
  assert.equal(isBinaryBody(Buffer.from([0x00, 0x01, 0x02]), ''), true);
  assert.equal(isBinaryBody(Buffer.from('plain text'), 'plain text'), false);
  assert.equal(isBinaryBody(Buffer.alloc(0), 'plain text'), false);
  assert.equal(isBinaryBody(Buffer.from([0x1f, 0x8b]), '\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD'), true);
  assert.equal(isBinaryBody(undefined, 'ok'), false);
  assert.equal(isBinaryBody(Buffer.from('x'), 'a \uFFFD b'), false);
});

test('htmlToText keeps blocks/code/links and drops scripts/styles/navigation', () => {
  const out = htmlToText(
    '<html><head><style>.x{color:red}</style><script>evil()</script></head>' +
    '<body><nav>Menu Home</nav><header>Site header</header>' +
    '<h1>Title</h1><p>Hello &amp; world</p>' +
    '<pre><code>const a = 1;</code></pre>' +
    '<a href="/docs">Read docs</a><footer>Footer</footer></body></html>',
  );
  assert.ok(!out.includes('evil'));
  assert.ok(!out.includes('Menu'));
  assert.ok(!out.includes('Site header'));
  assert.ok(!out.includes('Footer'));
  assert.ok(!out.includes('.x{color:red}'));
  assert.ok(out.includes('Title'));
  assert.ok(out.includes('Hello & world'));
  assert.ok(out.includes('const a = 1;'));
  assert.ok(out.includes('Read docs [/docs]'));
  assert.ok(!out.includes('<'));
});

test('validateSearchQuery and validateMaxResults enforce the Tavily contract', () => {
  assert.equal(validateSearchQuery('  hello world  '), 'hello world');
  assert.throws(() => validateSearchQuery(''), /query/);
  assert.throws(() => validateSearchQuery('   '), /query/);
  assert.throws(() => validateSearchQuery(42), /query/);
  assert.throws(() => validateSearchQuery('a'.repeat(401)), /too long/);
  assert.equal(validateMaxResults(undefined), 5);
  assert.equal(validateMaxResults(1), 1);
  assert.equal(validateMaxResults(10), 10);
  for (const bad of [0, 11, 1.5, '5', -1, NaN]) {
    assert.throws(() => validateMaxResults(bad), /integer between 1 and 10/);
  }
});

test('fetchPage resolves public DNS, extracts HTML and returns {text, details}', async () => {
  const { request, calls } = makeRequest((target) => {
    assert.equal(target.url.href, 'https://example.com/page');
    assert.ok(target.addresses.length > 0);
    return htmlResponse('<html><body><h1>Hello</h1><p>World</p></body></html>');
  });
  const client = createWebClient({ lookup: publicLookup, request });
  const { text, details } = await client.fetchPage({ url: 'https://example.com/page' });
  assert.ok(text.includes('Source: https://example.com/page'));
  assert.ok(text.includes('Hello'));
  assert.ok(text.includes('World'));
  assert.equal(details.url, 'https://example.com/page');
  assert.equal(details.contentType, 'text/html');
  assert.equal(details.redirects, 0);
  assert.equal(calls.length, 1);
});

test('fetchPage rejects a host resolving to a private address before any request', async () => {
  let requested = false;
  const client = createWebClient({
    lookup: async () => [{ address: '10.0.0.1', family: 4 }],
    request: async () => { requested = true; return htmlResponse('x'); },
  });
  await assert.rejects(() => client.fetchPage({ url: 'https://example.com/' }), /non-public/);
  assert.equal(requested, false);
});

test('fetchPage follows bounded redirects and re-validates every hop', async () => {
  const { request, calls } = makeRequest((target) => {
    if (target.url.href === 'https://a.example/start') {
      return { statusCode: 302, headers: { location: 'https://b.example/final' }, body: Buffer.alloc(0), truncated: false };
    }
    if (target.url.href === 'https://b.example/final') {
      return htmlResponse('<html><body>final</body></html>');
    }
    throw new Error(`unexpected url ${target.url.href}`);
  });
  const client = createWebClient({ lookup: publicLookup, request });
  const { text, details } = await client.fetchPage({ url: 'https://a.example/start' });
  assert.ok(text.includes('final'));
  assert.equal(details.url, 'https://b.example/final');
  assert.equal(details.redirects, 1);
  assert.equal(calls.length, 2);
});

test('fetchPage rejects redirects to private hosts and credential URLs', async () => {
  const { request, calls } = makeRequest(() => ({
    statusCode: 302, headers: { location: 'https://b.example/final' }, body: Buffer.alloc(0), truncated: false,
  }));
  const privateClient = createWebClient({
    lookup: async (hostname) => (hostname === 'b.example'
      ? [{ address: '192.168.1.10', family: 4 }]
      : [{ address: '8.8.8.8', family: 4 }]),
    request,
  });
  await assert.rejects(() => privateClient.fetchPage({ url: 'https://a.example/start' }), /non-public/);
  assert.equal(calls.length, 1);

  const credentialClient = createWebClient({
    lookup: publicLookup,
    request: async () => ({ statusCode: 302, headers: { location: 'https://user:pass@b.example/final' }, body: Buffer.alloc(0), truncated: false }),
  });
  await assert.rejects(() => credentialClient.fetchPage({ url: 'https://a.example/start' }), /credentials/);
});

test('fetchPage bounds redirect count', async () => {
  let hop = 0;
  const { request, calls } = makeRequest(() => {
    hop += 1;
    return { statusCode: 302, headers: { location: `https://hop${hop}.example/x` }, body: Buffer.alloc(0), truncated: false };
  });
  const client = createWebClient({ lookup: publicLookup, request });
  await assert.rejects(() => client.fetchPage({ url: 'https://hop0.example/x' }), /Too many redirects/);
  // MAX_REDIRECTS=5: the 6th 3xx response is refused.
  assert.equal(calls.length, 6);
});

test('fetchPage filters content types', async () => {
  const client = createWebClient({
    lookup: publicLookup,
    request: async () => ({ statusCode: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from('not really a png'), truncated: false }),
  });
  await assert.rejects(() => client.fetchPage({ url: 'https://example.com/pic.png' }), /Unsupported content type/);
});

test('fetchPage supports application/json and application/xml as text', async () => {
  const jsonClient = createWebClient({
    lookup: publicLookup,
    request: async () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"answer": 42}'), truncated: false }),
  });
  const json = await jsonClient.fetchPage({ url: 'https://example.com/api.json' });
  assert.ok(json.text.includes('{"answer": 42}'));
  assert.equal(json.details.contentType, 'application/json');

  const xmlClient = createWebClient({
    lookup: publicLookup,
    request: async () => ({ statusCode: 200, headers: { 'content-type': 'application/xml' }, body: Buffer.from('<doc><a>1</a></doc>'), truncated: false }),
  });
  const xml = await xmlClient.fetchPage({ url: 'https://example.com/doc.xml' });
  assert.ok(xml.text.includes('<doc><a>1</a></doc>'));
  assert.equal(xml.details.contentType, 'application/xml');
});

test('fetchPage rejects non-2xx responses before extraction', async () => {
  const notFound = createWebClient({
    lookup: publicLookup,
    request: async () => ({ statusCode: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>404</html>'), truncated: false }),
  });
  await assert.rejects(() => notFound.fetchPage({ url: 'https://example.com/missing' }), /Fetch failed: HTTP 404/);

  const serverError = createWebClient({
    lookup: publicLookup,
    request: async () => ({ statusCode: 503, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>down</html>'), truncated: false }),
  });
  await assert.rejects(() => serverError.fetchPage({ url: 'https://example.com/down' }), /Fetch failed: HTTP 503/);
});

test('fetchPage rejects binary bodies without a content type', async () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]);
  const client = createWebClient({
    lookup: publicLookup,
    request: async () => ({ statusCode: 200, headers: {}, body: pngBytes, truncated: false }),
  });
  await assert.rejects(() => client.fetchPage({ url: 'https://example.com/pic' }), /binary/);

  const textClient = createWebClient({
    lookup: publicLookup,
    request: async () => ({ statusCode: 200, headers: {}, body: Buffer.from('plain text without a content type'), truncated: false }),
  });
  const { text } = await textClient.fetchPage({ url: 'https://example.com/raw' });
  assert.ok(text.includes('plain text without a content type'));
});

test('buildRequestOptions pins to the IP and sets SNI only for hostnames', () => {
  const url = new URL('https://example.com/path?q=1');
  const opts = buildRequestOptions(url, { address: '93.184.216.34', family: 4 }, {});
  assert.equal(opts.host, '93.184.216.34');
  assert.equal(opts.servername, 'example.com');
  assert.equal(opts.headers.host, 'example.com');
  assert.equal(opts.path, '/path?q=1');

  const ipUrl = new URL('https://8.8.8.8/');
  const ipOpts = buildRequestOptions(ipUrl, { address: '8.8.8.8', family: 4 }, {});
  assert.equal(ipOpts.host, '8.8.8.8');
  assert.equal('servername' in ipOpts, false);
  assert.equal(ipOpts.headers.host, '8.8.8.8');

  const ipv6Url = new URL('https://[2001:4860:4860::8888]/');
  const ipv6Opts = buildRequestOptions(ipv6Url, { address: '2001:4860:4860::8888', family: 6 }, {});
  assert.equal('servername' in ipv6Opts, false);
  assert.equal(ipv6Opts.headers.host, '[2001:4860:4860::8888]');
});

test('fetchPage caps output at 40k and marks read/output truncation', async () => {
  const big = 'x'.repeat(50000);
  const bigClient = createWebClient({
    lookup: publicLookup,
    request: async () => textResponse(big),
  });
  const { text, details } = await bigClient.fetchPage({ url: 'https://example.com/big' });
  assert.equal(details.outputTruncated, true);
  assert.ok(text.includes('[Output truncated at 40000 characters'));

  const readTruncatedClient = createWebClient({
    lookup: publicLookup,
    request: async () => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<p>hi</p>'), truncated: true }),
  });
  const truncated = await readTruncatedClient.fetchPage({ url: 'https://example.com/t' });
  assert.equal(truncated.details.readTruncated, true);
  assert.ok(truncated.text.includes('[Read truncated at ~2MB'));
});

test('fetchPage honours an aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = createWebClient({
    lookup: publicLookup,
    request: async () => { throw new Error('request should not run'); },
  });
  await assert.rejects(() => client.fetchPage({ url: 'https://example.com/' }, controller.signal), /aborted/i);
});

test('fetchPage propagates a mid-request abort as AbortError', async () => {
  const controller = new AbortController();
  const client = createWebClient({
    lookup: publicLookup,
    request: async (_target, options) => {
      await new Promise((resolve, reject) => {
        if (options.signal.aborted) reject(new DOMException('aborted', 'AbortError'));
        else options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  const promise = client.fetchPage({ url: 'https://example.com/' }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(promise, (error) => error?.name === 'AbortError');
});

test('searchWeb requires TAVILY_API_KEY with a clear error', async () => {
  const client = createWebClient({ env: {} });
  await assert.rejects(() => client.searchWeb({ query: 'hello' }), /TAVILY_API_KEY/);
});

test('searchWeb validates query and integer result count before any request', async () => {
  const { request, calls } = makeRequest(() => textResponse('{}', 200, { 'content-type': 'application/json' }));
  const client = createWebClient({ lookup: publicLookup, request, env: { TAVILY_API_KEY: 'k' } });
  await assert.rejects(() => client.searchWeb({ query: '  ' }), /query/);
  await assert.rejects(() => client.searchWeb({ query: 'x', max_results: 0 }), /integer between 1 and 10/);
  await assert.rejects(() => client.searchWeb({ query: 'x', max_results: 2.5 }), /integer between 1 and 10/);
  assert.equal(calls.length, 0);
});

test('searchWeb posts to the fixed Tavily endpoint and returns {text, details}', async () => {
  const { request } = makeRequest((target, options) => {
    assert.equal(target.url.href, 'https://api.tavily.com/search');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['content-type'], 'application/json');
    const body = JSON.parse(options.body);
    assert.equal(body.api_key, 'test-key');
    assert.equal(body.query, 'hello world');
    assert.equal(body.max_results, 3);
    return textResponse(JSON.stringify({ results: [
      { title: 'T', url: 'https://a.example', content: 'snippet one' },
      { title: 'U', url: 'https://b.example', content: 'snippet two' },
    ] }), 200, { 'content-type': 'application/json' });
  });
  const client = createWebClient({ lookup: publicLookup, request, env: { TAVILY_API_KEY: 'test-key' } });
  const { text, details } = await client.searchWeb({ query: '  hello world  ', max_results: 3 });
  assert.ok(text.includes('Untrusted search results for: hello world'));
  assert.ok(text.includes('https://a.example'));
  assert.ok(text.includes('snippet one'));
  assert.equal(details.provider, 'Tavily');
  assert.equal(details.max_results, 3);
  assert.equal(details.results.length, 2);
});

test('searchWeb rejects a truncated response', async () => {
  const client = createWebClient({
    lookup: publicLookup,
    request: async () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"results":[]}'), truncated: true }),
    env: { TAVILY_API_KEY: 'k' },
  });
  await assert.rejects(() => client.searchWeb({ query: 'x' }), /truncated/);
});

test('searchWeb caps titles, URLs and details fields', async () => {
  const longTitle = 't'.repeat(500);
  const longUrl = 'https://example.com/' + 'u'.repeat(4000);
  const longContent = 'c'.repeat(5000);
  const client = createWebClient({
    lookup: publicLookup,
    request: async () => textResponse(JSON.stringify({ results: [
      { title: longTitle, url: longUrl, content: longContent },
    ] }), 200, { 'content-type': 'application/json' }),
    env: { TAVILY_API_KEY: 'k' },
  });
  const { text, details } = await client.searchWeb({ query: 'x' });
  assert.equal(details.results[0].title.length, 200);
  assert.equal(details.results[0].url.length, 2048);
  assert.equal(details.results[0].content.length, 500);
  assert.ok(!text.includes(longTitle));
  assert.ok(!text.includes(longUrl));
  assert.ok(!text.includes(longContent));
  assert.equal(details.outputTruncated, false);
});

test('formatSearchResults marks output truncation', () => {
  const capped = formatSearchResults('q', [
    { title: 't'.repeat(500), url: 'https://e.com/' + 'u'.repeat(3000), content: 'c'.repeat(1000) },
  ]);
  assert.equal(capped.outputTruncated, false);
  assert.equal(capped.details[0].title.length, 200);
  assert.equal(capped.details[0].url.length, 2048);
  assert.equal(capped.details[0].content.length, 500);

  const many = Array.from({ length: 200 }, (_, i) => ({
    title: `Result ${i}`,
    url: `https://example.com/${i}`,
    content: 'x'.repeat(300),
  }));
  const truncated = formatSearchResults('q', many, 1000);
  assert.equal(truncated.outputTruncated, true);
  assert.ok(truncated.text.includes('[Output truncated at 1000 characters'));
  assert.ok(truncated.text.length > 1000);
});

test('searchWeb never leaks the API key in diagnostics', async () => {
  const secret = 'sk-secret-123';
  const leakingFree = (error) => {
    const message = String(error?.message || error);
    assert.ok(!message.includes(secret), `leaked secret in: ${message}`);
    assert.ok(!message.includes('authorization'), `leaked header in: ${message}`);
    return true;
  };
  const networkClient = createWebClient({
    lookup: publicLookup,
    request: async () => { const e = new Error('connection reset'); e.code = 'ECONNRESET'; throw e; },
    env: { TAVILY_API_KEY: secret },
  });
  await assert.rejects(() => networkClient.searchWeb({ query: 'x' }), leakingFree);

  const httpClient = createWebClient({
    lookup: publicLookup,
    request: async () => ({ statusCode: 500, headers: {}, body: Buffer.from('boom'), truncated: false }),
    env: { TAVILY_API_KEY: secret },
  });
  await assert.rejects(() => httpClient.searchWeb({ query: 'x' }), /HTTP 500/);
  await assert.rejects(() => httpClient.searchWeb({ query: 'x' }), leakingFree);

  const jsonClient = createWebClient({
    lookup: publicLookup,
    request: async () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('not json'), truncated: false }),
    env: { TAVILY_API_KEY: secret },
  });
  await assert.rejects(() => jsonClient.searchWeb({ query: 'x' }), /invalid JSON/);
});
