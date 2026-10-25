// A transform stream sees the events as node:test reports them; an async generator would see them later, after more
// tests have run.
import { Transform } from 'node:stream';

import { reporting, type HookDependencies, type TestEvent } from './hook-core.ts';

const global = globalThis as HookDependencies['global'];

export default new Transform({
  writableObjectMode: true,
  transform(event: TestEvent, _encoding, callback) {
    // Processes forked from the test file inherit the reporter, but only the test file's own process records.
    global[reporting]?.(event);
    callback();
  },
});
