'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const config = require('../config.js');

const { scripts } = config;

const PORT = process.env.PORT || 8642;
const HOST = '0.0.0.0';
const SCRIPTS_BY_ID = new Map(scripts.map((s) => [s.id, s]));
const MAX_BUFFERED_LINES = 500; // per-script scrollback replayed to new clients
const KILL_ESCALATION_MS = 5000; // SIGTERM grace period before SIGKILL

// Runtime state per script id: { proc, status, buffer, pendingRestart, killTimer }
const state = new Map();
for (const s of scripts) {
  state.set(s.id, {
    proc: null,
    status: 'stopped',
    buffer: [],
    pendingRestart: false,
    killTimer: null,
  });
}

// ---- static file serving (index.html + assets) ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, path.normalize(filePath).replace(/^(\.\.[/\\])+/, ''));

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
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

// Node's DEP0190 fires when shell:true is combined with an args array.
// When shell is requested, fold command+args into one string ourselves
// (this is also what actually resolves `npm` -> `npm.cmd` on Windows) and
// pass spawn() an empty args array instead.
function buildInvocation(cfg) {
  const args = cfg.args || [];
  if (cfg.shell) return { command: [cfg.command, ...args].join(' '), args: [] };
  return { command: cfg.command, args };
}

function startScript(id) {
  const cfg = SCRIPTS_BY_ID.get(id);
  const st = state.get(id);
  if (!cfg || (st.proc && st.status === 'running')) return;

  const { command, args } = buildInvocation(cfg);
  const proc = spawn(command, args, {
    cwd: cfg.cwd || __dirname,
    env: { ...process.env, ...(cfg.env || {}) },
    shell: cfg.shell || false,
    // Make the child the leader of its own process group (POSIX) so that on
    // stop() we can signal the whole tree (shell -> npm -> actual server),
    // not just the immediate child. Without this, npm's grandchild keeps the
    // port bound after "stop" because only the outer process gets SIGTERM.
    detached: process.platform !== 'win32',
  });

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
    clearTimeout(st.killTimer);
    st.killTimer = null;
    setStatus(id, 'stopped');

    if (st.pendingRestart) {
      st.pendingRestart = false;
      startScript(id);
    }
  });
}

// Signal the whole process tree, not just the immediate child — npm (and the
// shell wrapping it) otherwise survive and leave the real server holding the
// port. POSIX: negative pid targets the whole process group created via
// `detached: true` above. Windows: taskkill /T walks the tree itself.
function killTree(proc, signal) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/f']);
    return;
  }
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {}
  }
}

function stopScript(id) {
  const st = state.get(id);
  if (!st.proc) return;

  killTree(st.proc, 'SIGTERM');
  clearTimeout(st.killTimer);
  st.killTimer = setTimeout(() => {
    if (st.proc) killTree(st.proc, 'SIGKILL');
  }, KILL_ESCALATION_MS);
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
  return scripts.map((s) => ({ id: s.id, label: s.label, status: state.get(s.id).status }));
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
