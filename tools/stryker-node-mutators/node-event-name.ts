import type { NodePath, types } from '@babel/core';

import { importOf } from './bindings.ts';
import type { Operator } from './operator.ts';

const LISTEN: ReadonlySet<string> = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);
const NODE_EVENTS: ReadonlySet<string> = new Set(['node:events', 'events']);
const NODE_PROCESS: ReadonlySet<string> = new Set(['node:process', 'process']);
/** The process's own events that fire at a different time from each other. */
const PROCESS_SWAPS: ReadonlyMap<string, readonly string[]> = new Map([
  ['exit', ['beforeExit']],
  ['beforeExit', ['exit']],
]);
/** A child process's and a stream's events that fire at a different time from each other. */
const STREAM_SWAPS: ReadonlyMap<string, readonly string[]> = new Map([
  ['close', ['exit']],
  ['exit', ['close']],
  ['finish', ['end', 'close']],
  ['end', ['close']],
]);

/**
 * Swaps the name of a lifecycle event that a listener waits for with one that fires at another time, such as a child
 * process's `exit`, which can fire while its output is still open, and its `close`. It covers the listener methods of
 * an event emitter and the `once` and `on` functions of `node:events`; names outside the swap tables stay.
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

/** The emitter whose event `path` names, or `undefined` when `path` names no event a listener waits for. */
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

/** Whether `callee` is `once` or `on` of `node:events`, which take the emitter first and the event name second. */
function isEventsFunction(path: NodePath, callee: types.Node): boolean {
  if (callee.type === 'Identifier') {
    const from = importOf(path, callee.name);

    return from !== undefined && NODE_EVENTS.has(from.source) && isOnceOrOn(from.imported);
  }

  if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier' || callee.property.type !== 'Identifier') {
    return false;
  }

  const from = importOf(path, callee.object.name);

  // The module itself, from a default or a namespace import, or its EventEmitter class.
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

/** Whether `receiver` is Node.js's process: the global, or an import of `node:process`. */
function isProcess(path: NodePath, receiver: types.Node): boolean {
  if (receiver.type !== 'Identifier') {
    return false;
  }

  const from = importOf(path, receiver.name);

  return from === undefined
    ? receiver.name === 'process' && !path.scope.hasBinding('process')
    : NODE_PROCESS.has(from.source) && from.imported === undefined;
}
