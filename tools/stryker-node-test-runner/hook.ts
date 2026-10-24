// Loaded into every Node.js process of a Stryker run through NODE_OPTIONS (`--import`).
import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { getCallSites } from 'node:util';
import { isMainThread, Worker } from 'node:worker_threads';

import { install, type HookDependencies, type NodeTestModule } from './hook-core.ts';

// A worker thread polls while the main thread is blocked. From a worker, process.exit and process.abort do not end a
// blocked process, and a signal does. An eval worker loads no `--import` preload, so the hook stays out of it, and it
// runs as an ES module under --input-type=module, which has no require. The first process over the limit writes the
// marker; another one at the same time leaves it whole.
const WATCHDOG = `
const { writeFileSync } = process.getBuiltinModule('node:fs');
const { workerData: { limitMB, markerPath } } = process.getBuiltinModule('node:worker_threads');
setInterval(() => {
  const rssMB = Math.round(process.memoryUsage.rss() / 1048576);
  if (rssMB > limitMB) {
    try {
      writeFileSync(markerPath, JSON.stringify({ rssMB, limitMB }), { flag: 'wx' });
    } catch {}
    process.kill(process.pid, 'SIGKILL');
  }
}, 50);
`;

install({
  env: process.env,
  mainFile: process.argv[1] ? resolve(process.argv[1]) : undefined,
  pid: process.pid,
  global: globalThis as HookDependencies['global'],
  nodeTest: () => process.getBuiltinModule('node:test') as NodeTestModule,
  registerHooks: registerHooks as HookDependencies['registerHooks'],
  onExit: (listener) => process.on('exit', listener),
  onBeforeExit: (listener) => process.on('beforeExit', listener),
  writeRecord: (path, record) => writeFileSync(path, JSON.stringify(record)),
  peakMemoryMB: () => Math.round(process.resourceUsage().maxRSS / 1024),
  canWatchMemory: isMainThread && process.permission?.has('worker') !== false,
  watchMemory: (workerData) => {
    const worker = new Worker(WATCHDOG, { eval: true, workerData });
    // A preload that cannot run in a worker, such as a --require one that calls process.chdir, stops the watchdog
    // alone, and the process runs as it would outside Stryker.
    worker.on('error', (error) => process.stderr.write(`Memory watchdog not running: ${error.message}\n`));
    worker.unref();

    return worker;
  },
  callSites: getCallSites,
});
