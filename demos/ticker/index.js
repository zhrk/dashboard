'use strict';

// Long-running process that logs a line every second.
let n = 0;
console.log('[ticker] started');
setInterval(() => {
  n += 1;
  console.log(`[ticker] tick #${n} at ${new Date().toISOString()}`);
}, 1000);
