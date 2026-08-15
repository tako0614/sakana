import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { IndexedDbModelCache } from './idb-cache';

describe('IndexedDbModelCache', () => {
  const cache = new IndexedDbModelCache();

  beforeEach(async () => {
    await cache.clear();
  });

  it('round-trips a response and reports its size', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await cache.put(
      'https://huggingface.co/model.onnx',
      new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }),
    );
    const response = await cache.match('https://huggingface.co/model.onnx');
    expect(response).toBeDefined();
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(bytes);
    expect(await cache.size()).toBe(bytes.byteLength);
  });

  it('does not match missing entries and clears completed entries', async () => {
    expect(await cache.match('missing')).toBeUndefined();
    await cache.put('one', new Response(new Uint8Array([1])));
    await cache.clear();
    expect(await cache.match('one')).toBeUndefined();
    expect(await cache.size()).toBe(0);
  });

  it('round-trips data across IndexedDB chunk boundaries', async () => {
    const bytes = new Uint8Array(8 * 1024 * 1024 + 17);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    await cache.put('chunked', new Response(bytes));
    const response = await cache.match('chunked');
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(bytes);
  }, 30_000);
});
