import { assertCall } from './assert-call.ts';
import { assertStatement } from './assert-statement.ts';
import { assertValidator } from './assert-validator.ts';
import { nodeEventName } from './node-event-name.ts';
import { nodeTimerDelay } from './node-timer-delay.ts';
import type { Operator } from './operator.ts';

export const productionOperators: readonly Operator[] = [nodeTimerDelay, nodeEventName, assertStatement];

export const testOperators: readonly Operator[] = [assertCall, assertValidator];

export function operatorsFor(name: string): readonly Operator[] {
  return name.endsWith('.test.ts') ? testOperators : productionOperators;
}
