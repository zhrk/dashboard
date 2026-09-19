'use strict';

const { WebSocketServer } = require('ws');
const server = require('./server.js');
const pm = require('./pm.js');

const wss = new WebSocketServer({ server });

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

pm.on('log', ({ id, data }) => broadcast({ type: 'log', id, data }));
pm.on('status', ({ id, status }) => broadcast({ type: 'status', id, status }));

wss.on('connection', (ws) => {
  // Sync new client: registry + replay of buffered logs for running/finished scripts
  ws.send(JSON.stringify({ type: 'registry', scripts: pm.registrySnapshot() }));
  for (const [id, lines] of pm.buffers()) {
    for (const line of lines) {
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
    if (!msg || !pm.has(msg.id)) return;

    if (msg.action === 'start') pm.start(msg.id);
    else if (msg.action === 'stop') pm.stop(msg.id);
    else if (msg.action === 'restart') pm.restart(msg.id);
  });
});

module.exports = wss;
