'use strict';

const pm = require('./pm.js');

const encoder = new TextEncoder();
const clients = new Set();

function format(event, data) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  const chunk = format(event, data);
  for (const client of clients) client.enqueue(chunk);
}

pm.on('log', (e) => broadcast('log', e));
pm.on('status', (e) => broadcast('status', e));

module.exports = () => {
  let client;

  const body = new ReadableStream({
    start(controller) {
      client = controller;
      controller.enqueue(encoder.encode('retry: 1500\n\n'));

      // Sync new client: registry + replay of buffered logs for running/finished scripts
      controller.enqueue(format('registry', pm.registrySnapshot()));
      for (const [id, lines] of pm.buffers()) {
        for (const data of lines) controller.enqueue(format('log', { id, data }));
      }

      clients.add(client);
    },
    cancel() {
      clients.delete(client);
    },
  });

  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
};
