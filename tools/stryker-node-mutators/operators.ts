import { assertLiveness } from './assert-liveness.ts';
import { assertRemoval } from './assert-removal.ts';
import { assertValidator } from './assert-validator.ts';
import { nodeEventName } from './node-event-name.ts';
import { nodeTimerDelay } from './node-timer-delay.ts';
import type { Operator } from './operator.ts';

export const productionOperators: readonly Operator[] = [nodeTimerDelay, nodeEventName, assertRemoval];

export const testOperators: readonly Operator[] = [assertLiveness, assertValidator];

export function operatorsFor(name: string): readonly Operator[] {
  return name.endsWith('.test.ts') ? testOperators : productionOperators;
}
