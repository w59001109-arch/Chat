const http  = require('http');
const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

// Ensure ~/.local/bin and common brew paths are in PATH
process.env.PATH = [
  process.env.HOME + '/.local/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
  process.env.PATH,
].join(':');

const PORT       = parseInt(process.env.PORT || '3000', 10);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'hermes';
const TLS_CERT   = process.env.TLS_CERT || '';
const TLS_KEY    = process.env.TLS_KEY  || '';

// ── PNG icon generator — black bg + green "H" glyph ──────────────────────────
function makeIconPNG(size) {
  const G = [
    [1,0,0,0,1],
    [1,0,0,0,1],
    [1,0,0,0,1],
    [1,1,1,1,1],
    [1,0,0,0,1],
    [1,0,0,0,1],
    [1,0,0,0,1],
  ];
  const GW = 5, GH = 7;
  const sc = Math.floor(size * 0.55 / GW);
  const lw = GW * sc, lh = GH * sc;
  const ox = Math.floor((size - lw) / 2);
  const oy = Math.floor((size - lh) / 2);
  const T = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    T[i] = c;
  }
  function crc32(b) {
    let c = 0xFFFFFFFF;
    for (const x of b) c = T[(c ^ x) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, cb]);
  }
  const rowSize = 1 + size * 3;
  const raw = Buffer.alloc(size * rowSize);
  for (let y = 0; y < size; y++) {
    raw[y * rowSize] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * rowSize + 1 + x * 3;
      const lx = x - ox, ly = y - oy;
      const lit = lx >= 0 && lx < lw && ly >= 0 && ly < lh &&
                  G[Math.floor(ly / sc)][Math.floor(lx / sc)] === 1;
      raw[i] = 0; raw[i+1] = lit ? 255 : 0; raw[i+2] = lit ? 65 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const ICON_192 = makeIconPNG(192);
const ICON_512 = makeIconPNG(512);

// Strip ANSI escape codes from claude CLI output
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
          .replace(/\x1b[()][A-B0-9]/g, '')
          .replace(/\x1b[^[]/g, '');
}

// ── Static assets ────────────────────────────────────────────────────────────

const MANIFEST = JSON.stringify({
  name: 'HERMES', short_name: 'HERMES',
  description: 'Hermes AI Terminal',
  start_url: '/', display: 'standalone',
  background_color: '#000000', theme_color: '#000000',
  orientation: 'portrait',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    { src: '/icon.svg',     sizes: 'any',     type: 'image/svg+xml' },
  ]
});

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#000"/>
<text x="256" y="330" text-anchor="middle" font-size="240" font-weight="bold"
  font-family="'Courier New',monospace" fill="#00ff41">H</text>
<rect x="40" y="430" width="432" height="3" fill="#00ff41" opacity=".4"/>
</svg>`;

// ── HTTP(S) handler ───────────────────────────────────────────────────────────

function handler(req, res) {
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch { res.writeHead(500); return res.end('Server Error'); }
  }
  if (url === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(MANIFEST);
  }
  if (url === '/sw.js') {
    try {
      const sw = fs.readFileSync(path.join(__dirname, 'sw.js'));
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' });
      return res.end(sw);
    } catch { res.writeHead(404); return res.end('Not Found'); }
  }
  if (url === '/icon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(ICON);
  }
  if (url === '/icon-192.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(ICON_192);
  }
  if (url === '/icon-512.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(ICON_512);
  }
  res.writeHead(404); res.end('Not Found');
}

// Use HTTPS if cert/key provided, otherwise HTTP
let server;
if (TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
  server = https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, handler);
  console.log('\x1b[32m▶ HTTPS mode\x1b[0m');
} else {
  server = http.createServer(handler);
  console.log('\x1b[33m▶ HTTP mode (set TLS_CERT/TLS_KEY for HTTPS + PWA install)\x1b[0m');
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

const AGENTS = {
  hermes: { bin: CLAUDE_BIN, sub: 'chat', flag: '-q', extra: ['-Q'] }, // hermes chat -q PROMPT -Q
  claude: { bin: 'claude',   sub: null,   flag: '-p', extra: []      }, // claude -p PROMPT
};

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let currentAgent = 'hermes';
  let isFirst      = true;
  let busy         = false;
  let proc         = null;

  function send(obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  send({ type: 'system',       text: 'HERMES ONLINE — CLAUDE CODE CONNECTED' });
  send({ type: 'agent_status', agent: currentAgent });

  ws.on('close', () => { if (proc) proc.kill(); });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ── Switch agent ────────────────────────────────────────────────────────
    if (msg.type === 'switch') {
      if (busy) { send({ type: 'error', message: 'Cannot switch while processing' }); return; }
      if (!AGENTS[msg.agent]) return;
      currentAgent = msg.agent;
      isFirst = true; // reset conversation when switching
      send({ type: 'agent_status', agent: currentAgent });
      send({ type: 'system', text: `SWITCHED TO ${currentAgent.toUpperCase()}` });
      return;
    }

    if (busy) return;
    if (msg.type !== 'message' || !msg.content?.trim()) return;

    busy = true;
    send({ type: 'start' });

    const { bin, sub, flag, extra } = AGENTS[currentAgent];
    const args = [];
    if (sub) args.push(sub);
    args.push(flag, msg.content.trim());
    args.push(...extra);
    if (!isFirst) args.push('--continue');
    isFirst = false;

    proc = spawn(bin, args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (chunk) => {
      const text = stripAnsi(chunk.toString());
      if (text) send({ type: 'delta', text });
    });

    let stderrBuf = '';
    proc.stderr.on('data', (c) => { stderrBuf += c.toString(); });

    proc.on('close', (code) => {
      busy = false;
      proc = null;
      if (code === 0) {
        send({ type: 'done' });
      } else {
        const errMsg = stripAnsi(stderrBuf).trim() || `${bin} exited with code ${code}`;
        send({ type: 'error', message: errMsg });
      }
    });

    proc.on('error', (err) => {
      busy = false;
      proc = null;
      const hint = err.code === 'ENOENT'
        ? `"${bin}" not found — check PATH`
        : err.message;
      send({ type: 'error', message: hint });
    });
  });
});

server.listen(PORT, () => {
  console.log(`\x1b[32m▶ HERMES running → http://localhost:${PORT}\x1b[0m`);
  console.log(`  using claude binary: ${CLAUDE_BIN}`);
});
