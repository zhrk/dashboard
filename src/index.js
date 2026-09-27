import { Hono } from 'hono';
import { proxy } from 'hono/proxy';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';

const API_URL = 'http://127.0.0.1:11379';

const app = new Hono();

app.all('/apps/*', (c) => proxy(API_URL + c.req.path + new URL(c.req.url).search, c.req.raw));
app.get('/events', (c) => proxy(API_URL + '/events', { raw: c.req.raw, signal: null }));

const onFound = (_, c) => c.header('Cache-Control', 'no-cache');

app.get('/alpine.js', serveStatic({ path: 'node_modules/alpinejs/dist/cdn.min.js', onFound }));
app.use('*', serveStatic({ root: 'public', onFound }));

serve({ fetch: app.fetch, port: 8642, hostname: '0.0.0.0' });
