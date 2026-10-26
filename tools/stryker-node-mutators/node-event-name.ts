import type { NodePath, types } from '@babel/core';

import { importOf } from './bindings.ts';
import type { Operator } from './operator.ts';

const LISTEN: ReadonlySet<string> = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);
const NODE_EVENTS: ReadonlySet<string> = new Set(['node:events', 'events']);
const NODE_PROCESS: ReadonlySet<string> = new Set(['node:process', 'process']);
const PROCESS_SWAPS: ReadonlyMap<string, readonly string[]> = new Map([
  ['exit', ['beforeExit']],
  ['beforeExit', ['exit']],
]);
const STREAM_SWAPS: ReadonlyMap<string, readonly string[]> = new Map([
  ['close', ['exit']],
  ['exit', ['close']],
  ['finish', ['end', 'close']],
  ['end', ['close']],
]);

/**
 * Swaps a lifecycle event that a listener waits for with one that fires at another time, such as a child process's
 * `exit`, which can fire while its output is still open, and its `close`.
 */
export const nodeEventName: Operator = {
  name: 'NodeEventName',
  sample: "child.on('exit', () => {});\n",
  *mutate(path, t) {
    if (!path.isStringLiteral()) {
      return;
    }

    const receiver = receiverOf(path);

    if (receiver === undefined) {
      return;
    }

    const swaps = isProcess(path, receiver) ? PROCESS_SWAPS : STREAM_SWAPS;

    for (const name of swaps.get(path.node.value) ?? []) {
      yield t.stringLiteral(name);
    }
  },
};

function receiverOf(path: NodePath): types.Node | undefined {
  const call = path.parent;

  if (call.type !== 'CallExpression') {
    return undefined;
  }

  if (isEventsFunction(path, call.callee)) {
    return path.key === 1 ? call.arguments[0] : undefined;
  }

  const { callee } = call;
  const listens = callee.type === 'MemberExpression' && callee.property.type === 'Identifier' && LISTEN.has(callee.property.name);

  return listens && path.key === 0 ? callee.object : undefined;
}

function isEventsFunction(path: NodePath, callee: types.Node): boolean {
  if (callee.type === 'Identifier') {
    const from = importOf(path, callee.name);

    return from !== undefined && NODE_EVENTS.has(from.source) && isOnceOrOn(from.imported);
  }

  if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier' || callee.property.type !== 'Identifier') {
    return false;
  }

  const from = importOf(path, callee.object.name);

  return (
    from !== undefined &&
    NODE_EVENTS.has(from.source) &&
    (from.imported === undefined || from.imported === 'EventEmitter') &&
    isOnceOrOn(callee.property.name)
  );
}

function isOnceOrOn(name: string | undefined): boolean {
  return name === 'once' || name === 'on';
}

function isProcess(path: NodePath, receiver: types.Node): boolean {
  if (receiver.type !== 'Identifier') {
    return false;
  }

  const from = importOf(path, receiver.name);

  return from === undefined
    ? receiver.name === 'process' && !path.scope.hasBinding('process')
    : NODE_PROCESS.has(from.source) && from.imported === undefined;
}
