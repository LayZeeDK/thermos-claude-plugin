// Code that exists to be mutated. It holds the Node.js API shapes that the production operators match and that no
// other file of this repository has, so npm run mutate makes those mutants and node-apis.test.ts has to kill them.
import assert from 'node:assert/strict';
import { once, type EventEmitter } from 'node:events';
import process from 'node:process';
import type { Readable, Writable } from 'node:stream';
import timers from 'node:timers';
import { scheduler, setTimeout as sleep } from 'node:timers/promises';

/** Resolves after `ms` milliseconds, through the promise timer of `node:timers/promises`. */
export async function pause(ms: number): Promise<void> {
  await sleep(ms);
}

/** Resolves after `ms` milliseconds, through `scheduler.wait`. */
export async function wait(ms: number): Promise<void> {
  await scheduler.wait(ms);
}

/** Calls `callback` after `ms` milliseconds, through the default export of `node:timers`. */
export function later(callback: () => void, ms: number): void {
  timers.setTimeout(callback, ms);
}

/** Resolves once `emitter` emits `close`, through `once` of `node:events`. */
export async function closed(emitter: EventEmitter): Promise<void> {
  await once(emitter, 'close');
}

/** Calls `done` once `stream` has flushed all it was given. */
export function onFinish(stream: Writable, done: () => void): void {
  stream.on('finish', done);
}

/** Calls `done` once `stream` has given all it holds. */
export function onEnd(stream: Readable, done: () => void): void {
  stream.once('end', done);
}

/** Calls `listener` when the event loop of the process empties, through an import of `node:process`. */
export function onIdle(listener: () => void): void {
  process.once('beforeExit', listener);
}

/** The share of `part` in `whole`, which has to be positive. */
export function share(part: number, whole: number): number {
  assert.ok(whole > 0);

  return part / whole;
}

/** `count` items of `size` each, where `count` has to be a whole number. */
export function total(count: number, size: number): number {
  assert(Number.isInteger(count));

  return count * size;
}
