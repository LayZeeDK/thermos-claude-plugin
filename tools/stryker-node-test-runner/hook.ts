// Loaded into every Node.js process of a Stryker run through NODE_OPTIONS (`--import`). See hook-core.ts.
import { writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';

import { install, type HookDependencies, type NodeTestModule } from './hook-core.ts';

const require = createRequire(import.meta.url);

install({
  env: process.env,
  mainFile: process.argv[1] ? resolve(process.argv[1]) : undefined,
  pid: process.pid,
  global: globalThis as HookDependencies['global'],
  nodeTest: () => require('node:test') as NodeTestModule,
  publishNodeTest: syncBuiltinESMExports,
  onExit: (listener) => process.on('exit', listener),
  writeRecord: (path, record) => writeFileSync(path, JSON.stringify(record)),
  join,
});
