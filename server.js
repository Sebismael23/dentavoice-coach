// Custom server that adds a WebSocket proxy for Deepgram.
// Browser extensions can strip Sec-WebSocket-Protocol headers, breaking
// direct browser→Deepgram auth. This proxy handles auth server-side
// with the standard Authorization header (which always works).

const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer, WebSocket: NodeWS } = require('ws');
const { readFileSync } = require('fs');
const { resolve } = require('path');

// Load .env.local manually (Next.js loads it for its own routes but not for our custom server bootstrap)
try {
  const envPath = resolve(__dirname, '.env.local');
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* .env.local might not exist */ }

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const PORT = parseInt(process.env.PORT || '3000', 10);
const DG_KEY = process.env.DEEPGRAM_API_KEY;

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res, parse(req.url, true)));

  // Let Next.js handle its own upgrade events (HMR WebSocket)
  const nextUpgradeHandler = app.getUpgradeHandler();

  // WebSocket server on /api/deepgram-proxy
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname, query } = parse(req.url, true);

    if (pathname === '/api/deepgram-proxy') {
      wss.handleUpgrade(req, socket, head, (browserWs) => {
        // Build Deepgram URL from query params forwarded by the client.
        // Repeated params (e.g. multiple keyterm=...) arrive as arrays —
        // append each one so none are lost or comma-joined.
        const dgParams = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) {
          if (!k || v == null) continue;
          if (Array.isArray(v)) {
            for (const item of v) dgParams.append(k, String(item));
          } else {
            dgParams.append(k, String(v));
          }
        }
        const dgUrl = `wss://api.deepgram.com/v1/listen?${dgParams.toString()}`;

        console.log('[proxy] Connecting to Deepgram:', dgUrl);

        // Connect to Deepgram with server-side header auth
        const dgWs = new NodeWS(dgUrl, {
          headers: { Authorization: `Token ${DG_KEY}` },
        });

        dgWs.on('open', () => {
          console.log('[proxy] Deepgram connected');
          browserWs.send(JSON.stringify({ type: 'proxy_ready' }));
        });

        // Browser → Deepgram (audio data + keepalives)
        browserWs.on('message', (data, isBinary) => {
          if (dgWs.readyState === NodeWS.OPEN) {
            dgWs.send(data, { binary: isBinary });
          }
        });

        // Deepgram → Browser (transcript results — always text/JSON)
        dgWs.on('message', (data, isBinary) => {
          if (browserWs.readyState === 1 /* OPEN */) {
            // Deepgram sends JSON as text; ensure we forward as string
            const msg = isBinary ? data : data.toString();
            browserWs.send(msg);
          }
        });

        dgWs.on('error', (err) => {
          console.error('[proxy] Deepgram error:', err.message);
          browserWs.close(1011, 'Deepgram error');
        });

        dgWs.on('close', (code, reason) => {
          console.log('[proxy] Deepgram closed:', code, String(reason));
          if (browserWs.readyState === 1) browserWs.close(code, String(reason));
        });

        browserWs.on('close', () => {
          console.log('[proxy] Browser disconnected');
          if (dgWs.readyState === NodeWS.OPEN) {
            dgWs.send(JSON.stringify({ type: 'CloseStream' }));
            dgWs.close();
          }
        });

        browserWs.on('error', (err) => {
          console.error('[proxy] Browser WS error:', err.message);
          dgWs.close();
        });
      });
    } else {
      // Pass through to Next.js (handles HMR WebSocket)
      if (nextUpgradeHandler) {
        nextUpgradeHandler(req, socket, head);
      }
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`> Port ${server._port || PORT} in use, trying ${(server._port || PORT) + 1}...`);
      const next = (server._port || PORT) + 1;
      server._port = next;
      server.listen(next);
    } else {
      throw err;
    }
  });

  server._port = PORT;
  server.listen(PORT, () => {
    console.log(`> DentaVoice Coach ready on http://localhost:${server.address().port}`);
  });
});
