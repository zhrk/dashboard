'use strict';

// Logs a few lines, then crashes — shows the "stopped" state and lets you
// try the start/restart buttons.
let n = 5;
console.log('[crasher] started, crashing in 5s');
const timer = setInterval(() => {
  n -= 1;
  console.log(`[crasher] ${n}...`);
  if (n === 0) {
    clearInterval(timer);
    console.error('[crasher] boom');
    process.exit(1);
  }
}, 1000);
