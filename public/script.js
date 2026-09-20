(function () {
  // Registry + per-script client-side log buffer (server replays on every connect).
  const scripts = new Map(); // id -> { status }
  const logs = new Map(); // id -> string[]
  let activeId = null;

  const listEl = document.getElementById('script-list');
  const logEl = document.getElementById('log');
  const activeLabelEl = document.getElementById('active-label');
  const connEl = document.getElementById('conn-status');

  function connect() {
    const es = new EventSource('/events');
    const on = (type, fn) => es.addEventListener(type, (e) => fn(JSON.parse(e.data)));

    es.onopen = () => {
      connEl.textContent = 'connected';
      connEl.className = 'conn up';
    };

    es.onerror = () => {
      connEl.textContent = 'disconnected — retrying...';
      connEl.className = 'conn down';
    };

    on('registry', handleRegistry);
    on('status', ({ id, status }) => handleStatus(id, status));
    on('log', ({ id, data }) => handleLog(id, data));
  }

  function handleRegistry(list) {
    for (const s of list) {
      scripts.set(s.id, { status: s.status });
      logs.set(s.id, []);
    }
    logEl.textContent = '';
    renderList();
    if (!activeId && list.length) selectScript(list[0].id);
  }

  function handleStatus(id, status) {
    const s = scripts.get(id);
    if (!s) return;
    s.status = status;
    renderList();
  }

  function handleLog(id, data) {
    const buf = logs.get(id) || [];
    buf.push(data);
    if (buf.length > 2000) buf.shift(); // client-side scrollback cap
    logs.set(id, buf);
    if (id === activeId) appendLog(data);
  }

  function renderList() {
    listEl.innerHTML = '';
    for (const [id, s] of scripts) {
      const item = document.createElement('div');
      item.className = 'script-item' + (id === activeId ? ' active' : '');
      item.onclick = (e) => {
        if (e.target.tagName !== 'BUTTON') selectScript(id);
      };

      const row1 = document.createElement('div');
      row1.className = 'row1';
      row1.innerHTML = `<span class="dot ${s.status}"></span><span class="label">${escapeHtml(id)}</span>`;

      const actions = document.createElement('div');
      actions.className = 'actions';

      if (s.status === 'running') {
        const stopBtn = document.createElement('button');
        stopBtn.textContent = 'Stop';
        stopBtn.className = 'stop';
        stopBtn.onclick = () => send('stop', id);
        const restartBtn = document.createElement('button');
        restartBtn.textContent = 'Restart';
        restartBtn.onclick = () => send('restart', id);
        actions.append(stopBtn, restartBtn);
      } else if (s.status === 'restarting') {
        const pendingBtn = document.createElement('button');
        pendingBtn.textContent = 'Restarting…';
        pendingBtn.disabled = true;
        actions.append(pendingBtn);
      } else {
        const startBtn = document.createElement('button');
        startBtn.textContent = 'Start';
        startBtn.onclick = () => send('start', id);
        actions.append(startBtn);
      }

      item.append(row1, actions);
      listEl.appendChild(item);
    }
  }

  function selectScript(id) {
    activeId = id;
    activeLabelEl.textContent = id;
    logEl.textContent = (logs.get(id) || []).join('');
    logEl.scrollTop = logEl.scrollHeight;
    renderList();
  }

  function appendLog(data) {
    const nearBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 40;
    logEl.textContent += data;
    if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
  }

  function send(action, id) {
    fetch(`/${action}/${id}`, { method: 'POST' });
  }

  function escapeHtml(str) {
    return str.replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c]
    );
  }

  connect();
})();
