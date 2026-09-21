'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const config = require('../config.js');

const MAX_BUFFERED_LINES = 500; // per-script scrollback replayed to new clients
const UPDATE_STEPS = ['git pull', 'npm i'];

// Owns the child processes for every configured script: spawning, killing,
// status tracking and log scrollback. Transport-agnostic — it emits 'log' and
// 'status' events and lets the caller decide how they reach a client.
class ProcessManager extends EventEmitter {
  constructor(scripts) {
    super();
    this.scripts = scripts;
    this.configById = new Map(scripts.map((s) => [s.id, s]));

    // Runtime state per script id: { proc, status, buffer, pendingRestart, pendingUpdate }
    this.state = new Map();
    for (const s of scripts) {
      this.state.set(s.id, {
        proc: null,
        status: 'stopped',
        buffer: [],
        pendingRestart: false,
        pendingUpdate: false,
      });
    }
  }

  registrySnapshot() {
    return this.scripts.map((s) => ({ id: s.id, status: this.state.get(s.id).status }));
  }

  // [id, lines] for every script, for replaying scrollback to a new client.
  buffers() {
    return [...this.state].map(([id, st]) => [id, st.buffer]);
  }

  start(id, { keepLog = false } = {}) {
    const cfg = this.configById.get(id);
    const st = this.state.get(id);
    if (!cfg || (st.proc && st.status === 'running')) return;

    const proc = spawn('npm start', [], { cwd: cfg.cwd, env: process.env, shell: true });

    st.proc = proc;
    if (!keepLog) st.buffer = [];
    this.#setStatus(id, 'running');

    const onData = (data) => this.#log(id, data.toString());

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('error', (err) => {
      this.#log(id, `[server] failed to start: ${err.message}\n`);
      this.#setStatus(id, 'error');
    });

    proc.on('exit', (code, signal) => {
      this.#log(id, `[server] process exited (code=${code}, signal=${signal})\n`);
      st.proc = null;

      if (st.pendingUpdate) {
        st.pendingUpdate = false;
        this.#updateAndStart(id);
        return;
      }

      this.#setStatus(id, 'stopped');

      if (st.pendingRestart) {
        st.pendingRestart = false;
        this.start(id);
      }
    });
  }

  stop(id) {
    const st = this.state.get(id);
    if (!st || !st.proc) return;

    killTree(st.proc);
  }

  restart(id) {
    const st = this.state.get(id);
    if (!st) return;

    if (st.proc) {
      st.pendingRestart = true;
      this.stop(id);
      this.#setStatus(id, 'restarting');
    } else {
      this.start(id);
    }
  }

  // stop -> git pull -> npm i -> npm start
  update(id) {
    const st = this.state.get(id);
    if (!st || st.status === 'updating' || st.status === 'restarting') return;

    this.#setStatus(id, 'updating');

    if (st.proc) {
      st.pendingUpdate = true;
      this.stop(id);
    } else {
      this.#updateAndStart(id);
    }
  }

  startAll() {
    for (const s of this.scripts) this.start(s.id);
  }

  stopAll() {
    for (const [id] of this.state) this.stop(id);
  }

  // git pull -> npm i -> npm start. Any failing step aborts and leaves the script
  // stopped rather than starting something half-updated.
  async #updateAndStart(id) {
    for (const cmd of UPDATE_STEPS) {
      if (!(await this.#runStep(id, cmd))) {
        this.#setStatus(id, 'error');
        return;
      }
    }

    this.start(id, { keepLog: true });
  }

  // Runs one shell command in the script's cwd, streaming output to its log.
  // Resolves true on exit code 0.
  #runStep(id, cmd) {
    const cfg = this.configById.get(id);

    this.#log(id, `[server] ${cmd}\n`);

    return new Promise((resolve) => {
      const proc = spawn(cmd, [], { cwd: cfg.cwd, env: process.env, shell: true });
      const onData = (data) => this.#log(id, data.toString());

      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);

      proc.on('error', (err) => {
        this.#log(id, `[server] ${cmd} failed to run: ${err.message}\n`);
        resolve(false);
      });

      proc.on('close', (code) => {
        if (code !== 0) this.#log(id, `[server] ${cmd} failed (code=${code}), not starting\n`);
        resolve(code === 0);
      });
    });
  }

  #log(id, line) {
    const st = this.state.get(id);
    st.buffer.push(line);
    if (st.buffer.length > MAX_BUFFERED_LINES) st.buffer.shift();
    this.emit('log', { id, data: line });
  }

  #setStatus(id, status) {
    this.state.get(id).status = status;
    this.emit('status', { id, status });
  }
}

// Signal the whole process tree, not just the immediate child — npm (and the
// shell wrapping it) otherwise survive and leave the real server holding the
// port. taskkill /T walks the tree itself.
function killTree(proc) {
  spawn('taskkill', ['/pid', String(proc.pid), '/T', '/f']);
}

module.exports = new ProcessManager(config.scripts);
