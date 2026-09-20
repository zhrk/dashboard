'use strict';

const path = require('path');
const { Hono } = require('hono');
const { serve } = require('@hono/node-server');
const { serveStatic } = require('@hono/node-server/serve-static');
const pm = require('./pm.js');
const events = require('./events.js');

const app = new Hono();

app.get('/events', events);

for (const action of ['start', 'stop', 'restart']) {
  app.post(`/${action}/:id`, (c) => {
    pm[action](c.req.param('id'));

    return c.body(null, 204);
  });
}

app.use('*', serveStatic({ root: path.join(__dirname, '../public') }));

serve({ fetch: app.fetch, port: 8642, hostname: '0.0.0.0' });
