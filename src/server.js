'use strict';

const path = require('path');
const { Hono } = require('hono');
const { serve } = require('@hono/node-server');
const { serveStatic } = require('@hono/node-server/serve-static');

const app = new Hono();

app.use('*', serveStatic({ root: path.join(__dirname, '../public') }));

module.exports = serve({ fetch: app.fetch, port: 8642, hostname: '0.0.0.0' });
