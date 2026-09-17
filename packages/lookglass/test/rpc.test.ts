import { describe, expect, it } from 'vitest';
import { createRpcClient } from '../src/core/rpc.js';

/** Minimal Worker stand-in: records posts and lets tests fire events. */
class FakeWorker extends EventTarget {
  posted: unknown[] = [];
  terminated = false;
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  fail(message: string) {
    const event = new Event('error') as Event & { message: string };
    event.message = message;
    this.dispatchEvent(event);
  }
  reply(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

describe('createRpcClient', () => {
  it('resolves a call with the worker reply', async () => {
    const worker = new FakeWorker();
    const client = createRpcClient<{ add: (a: { x: number }) => number }>(worker as unknown as Worker);
    const pending = client.call('add', { x: 1 });
    const { id } = worker.posted[0] as { id: number };
    worker.reply({ lg: 'lg1', id, ok: true, value: 42 });
    await expect(pending).resolves.toBe(42);
  });

  it('rejects calls made after the worker crashed while loading', async () => {
    // A module worker that throws during evaluation fires `error` before any
    // call exists. The next call must fail fast, not wait on a dead thread.
    const worker = new FakeWorker();
    const client = createRpcClient<{ open: () => void }>(worker as unknown as Worker, 'markdown worker');
    worker.fail('document is not defined');

    await expect(client.call('open', undefined as never)).rejects.toThrow(/document is not defined/);
    expect(worker.posted).toHaveLength(0);
  });

  it('rejects in-flight calls when the worker crashes', async () => {
    const worker = new FakeWorker();
    const client = createRpcClient<{ slow: () => void }>(worker as unknown as Worker);
    const pending = client.call('slow', undefined as never);
    worker.fail('boom');
    await expect(pending).rejects.toThrow(/boom/);
  });

  it('sends a cancel message when the caller aborts', async () => {
    const worker = new FakeWorker();
    const client = createRpcClient<{ slow: () => void }>(worker as unknown as Worker);
    const controller = new AbortController();
    const pending = client.call('slow', undefined as never, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(worker.posted.some((message) => (message as { cancel?: boolean }).cancel)).toBe(true);
  });
});
