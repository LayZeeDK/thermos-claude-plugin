import { assertLiveness } from './assert-liveness.ts';
import { nodeEventName } from './node-event-name.ts';
import { nodeTimerDelay } from './node-timer-delay.ts';
import type { Operator } from './operator.ts';

/** The operators that mutate production code, next to Stryker's own mutators. */
export const productionOperators: readonly Operator[] = [nodeTimerDelay, nodeEventName];

/** The operators that mutate test code, in place of Stryker's own mutators. */
export const testOperators: readonly Operator[] = [assertLiveness];
