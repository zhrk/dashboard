'use strict';

const http = require('http');

// Small HTTP server that logs each request. Holds a port, so it also shows
// that stop/restart really kills the whole process tree.
const PORT = 8700;

http
  .createServer((req, res) => {
    console.log(`[http-server] ${req.method} ${req.url}`);
    res.end('hello from demo http-server\n');
  })
  .listen(PORT, () => console.log(`[http-server] listening on http://localhost:${PORT}`));
