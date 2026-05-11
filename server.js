const http = require('http');
const fs   = require('fs');
const path = require('path');
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
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }]
});

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#000"/>
<text x="256" y="330" text-anchor="middle" font-size="240" font-weight="bold"
  font-family="'Courier New',monospace" fill="#00ff41">H</text>
<rect x="40" y="430" width="432" height="3" fill="#00ff41" opacity=".4"/>
</svg>`;

// ── HTTP ─────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
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
  if (url === '/icon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(ICON);
  }
  res.writeHead(404); res.end('Not Found');
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

const AGENTS = {
  hermes: CLAUDE_BIN,   // hermes binary (default)
  claude: 'claude',     // plain claude code
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

    const bin  = AGENTS[currentAgent];
    const args = ['-p', msg.content.trim()];
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
        ? `"${bin}" not found — check PATH or CLAUDE_BIN`
        : err.message;
      send({ type: 'error', message: hint });
    });
  });
});

server.listen(PORT, () => {
  console.log(`\x1b[32m▶ HERMES running → http://localhost:${PORT}\x1b[0m`);
  console.log(`  using claude binary: ${CLAUDE_BIN}`);
});
