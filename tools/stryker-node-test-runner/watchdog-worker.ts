// The memory watchdog's worker thread, which hook.ts starts.
import { workerData } from 'node:worker_threads';

import { watch, type WatchdogData } from './watchdog.ts';

watch(workerData as WatchdogData);
