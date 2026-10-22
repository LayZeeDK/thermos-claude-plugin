// Loaded into every Node.js process of a Stryker run through NODE_OPTIONS (`--import`). See hook-core.ts.
import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCallSites } from 'node:util';

import { install, type HookDependencies, type NodeTestModule } from './hook-core.ts';

install({
  env: process.env,
  mainFile: process.argv[1] ? resolve(process.argv[1]) : undefined,
  pid: process.pid,
  global: globalThis as HookDependencies['global'],
  nodeTest: () => process.getBuiltinModule('node:test') as NodeTestModule,
  registerHooks: registerHooks as HookDependencies['registerHooks'],
  onExit: (listener) => process.on('exit', listener),
  writeRecord: (path, record) => writeFileSync(path, JSON.stringify(record)),
  callSites: getCallSites,
  fileURLToPath,
});
