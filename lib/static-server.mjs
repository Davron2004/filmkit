// ─────────────────────────────────────────────────────────────────────────────
// lib/static-server.mjs — a loopback static file server, used only by `--browser ego`.
//
// The ego backend drives the user's real browser profile, so a filming run points it at
// http://127.0.0.1 rather than at file://. Three caps, all enforced HERE (this file owns the
// filesystem boundary; the ego backend re-checks the same root before it ever builds a URL,
// so a bad path fails with a flow-level message instead of a 403):
//
//   - bound to 127.0.0.1 on an ephemeral port — never reachable off this machine;
//   - rooted at ONE directory, with a resolve()+prefix traversal guard;
//   - every URL carries a per-run random token prefix, so another process on this machine that
//     guesses the port still cannot read the root;
//
// and it lives exactly as long as the run: film-web.mjs closes it in a finally.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, join, extname, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * @param {string} rootDir directory to serve (nothing outside it is reachable)
 * @returns {Promise<{origin: string, root: string, close: () => Promise<void>}>}
 *          `origin` already includes the token path prefix — append `/<relative-path>`.
 */
export async function startStaticServer(rootDir) {
  const root = resolve(rootDir);
  const token = randomBytes(12).toString('hex');
  const prefix = `/${token}/`;

  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!url.pathname.startsWith(prefix)) {
        res.writeHead(404).end('not found');
        return;
      }
      const rel = decodeURIComponent(url.pathname.slice(prefix.length));
      const target = resolve(join(root, rel));
      if (target !== root && !target.startsWith(root + sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const info = await stat(target);
      const file = info.isDirectory() ? join(target, 'index.html') : target;
      const size = info.isDirectory() ? (await stat(file)).size : info.size;
      res.writeHead(200, {
        'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
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
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    }
  });

  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', res);
  });
  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}${prefix.slice(0, -1)}`,
    root,
    close: () =>
      new Promise((res) => {
        server.closeAllConnections?.();
        server.close(() => res());
      }),
  };
}
