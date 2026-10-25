// Code that exists to be mutated: the Node.js API shapes the production operators match that no other file here has.
import assert from 'node:assert/strict';
import { once, type EventEmitter } from 'node:events';
import process from 'node:process';
import type { Readable, Writable } from 'node:stream';
import timers from 'node:timers';
import { scheduler, setTimeout as sleep } from 'node:timers/promises';

export async function pause(ms: number): Promise<void> {
  await sleep(ms);
}

export async function wait(ms: number): Promise<void> {
  await scheduler.wait(ms);
}

export function later(callback: () => void, ms: number): void {
  timers.setTimeout(callback, ms);
}

export async function closed(emitter: EventEmitter): Promise<void> {
  await once(emitter, 'close');
}

export function onFinish(stream: Writable, done: () => void): void {
  stream.on('finish', done);
}

export function onEnd(stream: Readable, done: () => void): void {
  stream.once('end', done);
}

export function onIdle(listener: () => void): void {
  process.once('beforeExit', listener);
}

export function share(part: number, whole: number): number {
  assert.ok(whole > 0);

  return part / whole;
}

export function total(count: number, size: number): number {
  assert(Number.isInteger(count));

  return count * size;
}
