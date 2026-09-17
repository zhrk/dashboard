'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const config = require('../config.js');

const { scripts } = config;

const PORT = 8642;
const HOST = '0.0.0.0';
const SCRIPTS_BY_ID = new Map(scripts.map((s) => [s.id, s]));
const MAX_BUFFERED_LINES = 500; // per-script scrollback replayed to new clients

// Runtime state per script id: { proc, status, buffer, pendingRestart }
const state = new Map();
for (const s of scripts) {
  state.set(s.id, {
    proc: null,
    status: 'stopped',
    buffer: [],
    pendingRestart: false,
  });
}

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'));
const FAVICON_SVG = fs.readFileSync(path.join(__dirname, 'favicon.svg'));

const server = http.createServer((req, res) => {
  if (req.url === '/favicon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(FAVICON_SVG);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(INDEX_HTML);
});

const wss = new WebSocketServer({ server });

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

function pushToBuffer(id, line) {
  const st = state.get(id);
  st.buffer.push(line);
  if (st.buffer.length > MAX_BUFFERED_LINES) st.buffer.shift();
}

function setStatus(id, status) {
  state.get(id).status = status;
  broadcast({ type: 'status', id, status });
}

function startScript(id) {
  const cfg = SCRIPTS_BY_ID.get(id);
  const st = state.get(id);
  if (!cfg || (st.proc && st.status === 'running')) return;

  const proc = spawn('npm start', [], { cwd: cfg.cwd, env: process.env, shell: true });

  st.proc = proc;
  st.buffer = [];
  setStatus(id, 'running');

  const onData = (data) => {
    const line = data.toString();
    pushToBuffer(id, line);
    broadcast({ type: 'log', id, data: line });
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('error', (err) => {
    pushToBuffer(id, `[server] failed to start: ${err.message}\n`);
    broadcast({ type: 'log', id, data: `[server] failed to start: ${err.message}\n` });
    setStatus(id, 'error');
  });

  proc.on('exit', (code, signal) => {
    const msg = `[server] process exited (code=${code}, signal=${signal})\n`;
    pushToBuffer(id, msg);
    broadcast({ type: 'log', id, data: msg });
    st.proc = null;
    setStatus(id, 'stopped');

    if (st.pendingRestart) {
      st.pendingRestart = false;
      startScript(id);
    }
  });
}

// Signal the whole process tree, not just the immediate child — npm (and the
// shell wrapping it) otherwise survive and leave the real server holding the
// port. taskkill /T walks the tree itself.
function killTree(proc) {
  spawn('taskkill', ['/pid', String(proc.pid), '/T', '/f']);
}

function stopScript(id) {
  const st = state.get(id);
  if (!st.proc) return;

  killTree(st.proc);
}

function restartScript(id) {
  const st = state.get(id);
  if (st.proc) {
    st.pendingRestart = true;
    stopScript(id);
    setStatus(id, 'restarting');
  } else {
    startScript(id);
  }
}

function registrySnapshot() {
  return scripts.map((s) => ({ id: s.id, status: state.get(s.id).status }));
}

wss.on('connection', (ws) => {
  // Sync new client: registry + replay of buffered logs for running/finished scripts
  ws.send(JSON.stringify({ type: 'registry', scripts: registrySnapshot() }));
  for (const [id, st] of state) {
    for (const line of st.buffer) {
      ws.send(JSON.stringify({ type: 'log', id, data: line }));
    }
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || !SCRIPTS_BY_ID.has(msg.id)) return;

    if (msg.action === 'start') startScript(msg.id);
    else if (msg.action === 'stop') stopScript(msg.id);
    else if (msg.action === 'restart') restartScript(msg.id);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`http://${HOST}:${PORT}`);
});

// Auto-start every registered script as soon as the dashboard boots.
for (const s of scripts) startScript(s.id);

// Make sure managed process trees don't survive the dashboard itself.
function shutdown() {
  for (const [id] of state) stopScript(id);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
