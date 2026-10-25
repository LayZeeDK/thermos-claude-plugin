// Loaded into every Node.js process of a Stryker run through NODE_OPTIONS (`--import`).
import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { getCallSites } from 'node:util';
import { isMainThread, Worker } from 'node:worker_threads';

import { install, type HookDependencies, type NodeTestModule } from './hook-core.ts';
import { workersAllowed } from './watchdog.ts';

// The memory watchdog's thread runs this script, where Stryker sees no coverage, so it only starts watchdog.ts's watch,
// whose code this process's tests reach.
const WATCHDOG = `Promise.all([
  import('node:worker_threads'),
  import(${JSON.stringify(new URL('./watchdog.ts', import.meta.url).href)}),
]).then(([{ workerData }, { watch }]) => watch(workerData));`;

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
  canWatchMemory: isMainThread && workersAllowed(process.permission),
  watchMemory: (options) => {
    const worker = new Worker(WATCHDOG, { eval: true, ...options });
    // A watchdog that fails stops alone, and the process runs as it would outside Stryker, its output untouched.
    worker.on('error', () => {});
    worker.unref();

    return worker;
  },
  callSites: getCallSites,
});
