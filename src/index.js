'use strict';

const pm = require('./pm.js');
require('./server.js');

pm.startAll();

function shutdown() {
  pm.stopAll();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
