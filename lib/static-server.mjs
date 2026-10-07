// ─────────────────────────────────────────────────────────────────────────────
// lib/static-server.mjs — a loopback static file server, used only by `--browser ego`.
//
// The ego backend drives the user's real browser profile, so a filming run points it at a
// loopback http origin rather than at file://. It serves at the ORIGIN ROOT, like the Playwright
// camera and test mode (http://filmkit.localhost/<path>, lib/scenario/filmkit-stage.mjs), so a
// root-absolute reference in a served page (`<script src="/app.js">`, `fetch('/data.json')`)
// resolves inside the serve root on every camera. Until 2026-09-29 the per-run token was a PATH
// prefix (`http://127.0.0.1:<port>/<token>/…`) and every root-absolute reference 404'd under ego.
//
// THE ORIGIN: `http://<token>.localhost:<port>`, token = 96 random bits, port ephemeral. MEASURED
// in ego-browser 0.5.1.13 (Chromium 152): `*.localhost` resolves to loopback without any DNS, and
// the origin is a secure context (isSecureContext true, crypto.subtle present), runs
// `<script type=module>`, and same-origin fetch/img work, exactly as on http://127.0.0.1. Node
// inside the ego runtime resolves it too (a HEAD answered 200). A fresh origin per run also means a
// fresh storage partition (localStorage, service workers, cache) in the user's profile, where a
// reused ephemeral port on 127.0.0.1 could inherit an earlier take's.
//
// THE GUARD, all enforced HERE (this file owns the filesystem boundary; the ego backend refuses a
// path outside the root before it builds a URL, so a bad path fails with a flow-level message
// instead of a 403). Every request must pass all of:
//
//   - bound to 127.0.0.1 — never reachable off this machine;
//   - GET/HEAD only (405);
//   - Host must be exactly `<token>.localhost:<port>` (404 otherwise). This is the token check: a
//     process that finds the port (a port scan is cheap) still cannot name the host, and a DNS-
//     rebound page arrives with its own hostname in Host;
//   - `Sec-Fetch-Site`, when present, must be `same-origin` or `none` (403 otherwise). `none` is a
//     browser-initiated navigation: MEASURED, ego's CDP Page.navigate arrives as `none`, and every
//     subresource/fetch of the served page as `same-origin`. A web page on another origin can never
//     produce either, so it is refused EVEN IF IT KNOWS THE TOKEN. That second layer is what makes a
//     hostname token safe: MEASURED, the served page's own cross-origin requests carry
//     `Origin`/`Referer: http://<token>.localhost:<port>/`, so the token reaches whatever third party
//     the page loads from, where the old path token was cut to the origin by the default referrer
//     policy. Also MEASURED, and why CORS alone is not a guard: with no Sec-Fetch-Site check, a tab
//     on http://127.0.0.1:<other port> or http://evil.localhost:<other port> that knew the URL
//     could not read a file with fetch() (CORS), but DID load it as `<img>` and ran it as
//     `<script src>` (a global it defined was readable). With the check both came back 403.
//     `evil.localhost` -> `<token>.localhost` is `cross-site` (each *.localhost is its own site);
//     `same-site` is refused anyway. A request with no Sec-Fetch-Site at all is a non-browser client
//     (curl, node) and passes on the Host check alone, as it passed on the path token before.
//   - the path, and the REAL path of the file it would serve, resolve inside the ONE root (403), the
//     root being a real path (see startStaticServer). A `..%2f` survives URL parsing, decodes to `../`
//     and lands in the first check (403); a literal `..` or `%2e%2e` segment is NORMALIZED AWAY by the
//     URL parser before any check runs, and leading slashes (`//real.txt`, `/\real.txt`, which the
//     parser turns into `//`) are collapsed by resolveServedFile, so the request names a path inside the
//     root and is served or 404s like any other. The request target is parsed under a FIXED origin,
//     never resolved against one: resolved, `//real.txt` was a scheme-relative URL with HOST `real.txt`
//     and path `/`, and 404'd (until 2026-10-06). Collapsing cannot open a traversal: what is left is
//     still decoded, resolved under the root and checked twice. MEASURED (the verifier's probe table):
//     `/%2e%2e/outside/secret.txt` 404, `/..%2foutside/secret.txt` 403, `/%2e%2e/real.txt` and
//     `//real.txt` serve root/real.txt, `//%2e%2e/x` is `/x`. A symlink inside the root that points
//     outside it lands in the second check (403). A malformed
//     %-escape is 400. A directory asked for without its trailing slash is a 301 to `<path>/`, with ONE
//     leading slash (`//sub` -> `/sub/`; `//sub/` as a Location would send the browser to host `sub`). All of
//     this is lib/scenario/filmkit-stage.mjs's resolveServedFile, the one the Playwright camera and
//     test mode serve by, so a local page loads the same files on every camera.
//
// RESIDUAL, accepted deliberately: a NON-browser process that learns the token can read the root
// during the run. It learns it only by receiving a request FROM the filmed page (the Origin/Referer
// above), i.e. by being a server the filmed app itself talks to; a remote one cannot reach
// 127.0.0.1, so only a local server qualifies, and a same-user process can read the files off disk
// anyway. Closing it needs a secret the browser sends and nothing else knows: a cookie. Rejected on
// measurement: a PWA manifest (`<link rel=manifest>`) and a `fetch(…, { credentials: 'omit' })` go
// out WITHOUT cookies, so they would 403 under ego and load under Playwright, and the cookie would
// be written into the user's real profile.
//
// It lives exactly as long as the run: film-web.mjs closes it in a finally.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { contentTypeOf, localRoot, resolveServedFile } from './scenario/filmkit-stage.mjs';

// Sec-Fetch-Site values a request may carry (absent is allowed too, see THE GUARD).
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

/**
 * @param {string} rootDir directory to serve (nothing outside it is reachable)
 * @returns {Promise<{origin: string, root: string, close: () => Promise<void>}>}
 *          `origin` is `http://<token>.localhost:<port>`, no trailing slash: append `/<relative-path>`.
 */
export async function startStaticServer(rootDir) {
  // A REAL path, by the same function the Playwright camera and test mode use (localRoot). The flow
  // file's own `new URL('./x.html', import.meta.url)` arrives realpath'd by Node's loader, so a root
  // kept in the spelling it was given (/tmp/demo, a symlinked checkout) put the flow's own sibling
  // file "outside the root". Requests are contained under this real root by resolveServedFile: a
  // symlink inside the root is followed only while its target stays inside it, on every camera.
  const root = localRoot(rootDir);
  const token = randomBytes(12).toString('hex');
  let expectedHost = null; // `<token>.localhost:<port>`, known once the port is bound

  const plain = (res, status, body) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(body);

  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'method not allowed');
      if ((req.headers.host || '').toLowerCase() !== expectedHost) return plain(res, 404, 'not found');
      const fetchSite = req.headers['sec-fetch-site'];
      if (fetchSite !== undefined && !ALLOWED_FETCH_SITES.has(fetchSite)) return plain(res, 403, 'forbidden');
      // The request target is a PATH (origin-form, always `/…` from a browser), so it is parsed under a
      // fixed origin, never resolved against one: `new URL('//real.txt', base)` reads `//real.txt` as a
      // scheme-relative URL whose HOST is `real.txt` and whose path is `/` (the old code, which 404'd it;
      // `/\real.txt` the same). An absolute-form target (`http://host/path`, proxy style) is parsed as
      // itself, as before: only its path is used, and the Host header was already checked.
      const url = req.url.startsWith('/') ? new URL(`http://x${req.url}`) : new URL(req.url, 'http://x');
      const served = await resolveServedFile(root, url.pathname, url.search);
      if (served.status === 301) return res.writeHead(301, { location: served.location, 'content-length': 0 }).end();
      if (served.status !== 200) return plain(res, served.status, { 400: 'bad path', 403: 'forbidden' }[served.status] ?? 'not found');
      const file = served.file;
      const { size } = await stat(file);
      res.writeHead(200, {
        'content-type': contentTypeOf(file),
        'content-length': size,
        'cache-control': 'no-store',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      // `.pipe()` does NOT forward read errors — a file that vanishes or turns unreadable
      // mid-stream would leave the response hanging open with the headers already sent and the
      // browser waiting forever, which in a filming run reads as "the app never loaded".
      // Nothing can be said at this point (the 200 is gone), so the only honest move is to
      // destroy the socket and let the client see a truncated response.
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) plain(res, 404, 'not found');
      else res.destroy();
    }
  });

  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', res);
  });
  const { port } = server.address();
  expectedHost = `${token}.localhost:${port}`;

  return {
    origin: `http://${expectedHost}`,
    root,
    close: () =>
      new Promise((res) => {
        server.closeAllConnections?.();
        server.close(() => res());
      }),
  };
}
