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

// fastify/test/stream.5.test.js:144
export function idle(callback: () => void, ms: number): void {
  setTimeout(callback, ms).unref();
}

// pino-pretty/test/basic.test.js:1288
const POLL_MS = 100;

export function poll(tick: () => void): NodeJS.Timeout {
  return setInterval(tick, POLL_MS);
}

export async function closed(emitter: EventEmitter): Promise<void> {
  await once(emitter, 'close');
}

export function onFinish(stream: Writable, done: () => void): void {
  stream.on('finish', done);
}

// fastify/lib/reply.js:1015
export function onSent(reply: { raw: Writable }, done: () => void): void {
  reply.raw.on('finish', done);
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
