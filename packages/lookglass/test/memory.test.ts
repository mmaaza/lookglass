import { describe, expect, it, vi } from 'vitest';
import { MemoryManager, rasterBytes } from '../src/core/memory.js';

const MB = 1024 * 1024;

describe('MemoryManager', () => {
  it('evicts least-recently-used entries to stay inside the budget', () => {
    const manager = new MemoryManager(10 * MB);
    manager.set('a', 'A', 4 * MB);
    manager.set('b', 'B', 4 * MB);
    manager.set('c', 'C', 4 * MB);

    expect(manager.has('a')).toBe(false);
    expect(manager.has('b')).toBe(true);
    expect(manager.has('c')).toBe(true);
    expect(manager.used).toBe(8 * MB);
  });

  it('counts a read as a use, so the recently read entry survives', () => {
    const manager = new MemoryManager(10 * MB);
    manager.set('a', 'A', 4 * MB);
    manager.set('b', 'B', 4 * MB);
    manager.get('a'); // 'a' is now the newest
    manager.set('c', 'C', 4 * MB);

    expect(manager.has('a')).toBe(true);
    expect(manager.has('b')).toBe(false);
  });

  it('never evicts a pinned entry', () => {
    const manager = new MemoryManager(10 * MB);
    manager.set('visible', 'page', 4 * MB);
    manager.pin('visible');
    manager.set('b', 'B', 4 * MB);
    manager.set('c', 'C', 4 * MB);

    expect(manager.has('visible')).toBe(true);
  });

  it('calls the disposer exactly once when an entry is evicted', () => {
    const dispose = vi.fn();
    const manager = new MemoryManager(4 * MB);
    manager.set('a', 'A', 3 * MB, dispose);
    manager.set('b', 'B', 3 * MB);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith('A');
  });

  it('rejects a value larger than the whole budget instead of emptying the cache', () => {
    const dispose = vi.fn();
    const manager = new MemoryManager(4 * MB);
    manager.set('keep', 'K', 1 * MB);

    const stored = manager.set('huge', 'H', 8 * MB, dispose);

    expect(stored).toBe(false);
    expect(manager.has('keep')).toBe(true);
    // The rejected value is disposed immediately; nothing is left dangling.
    expect(dispose).toHaveBeenCalledWith('H');
  });

  it('isolates scopes so disposing one document leaves others intact', () => {
    const manager = new MemoryManager(100 * MB);
    const first = manager.scope('doc-1');
    const second = manager.scope('doc-2');

    first.set('page:1', 'one', MB);
    second.set('page:1', 'two', MB);

    first.dispose();

    expect(first.get('page:1')).toBeUndefined();
    expect(second.get('page:1')).toBe('two');
    expect(manager.used).toBe(MB);
  });

  it('reports pressure and frees space on reserve', () => {
    const manager = new MemoryManager(10 * MB);
    manager.set('a', 'A', 8 * MB);
    expect(manager.pressure).toBeCloseTo(0.8);

    expect(manager.reserve(6 * MB)).toBe(true);
    expect(manager.has('a')).toBe(false);
  });

  it('estimates raster cost as 4 bytes per pixel', () => {
    expect(rasterBytes(1000, 1000)).toBe(4_000_000);
  });
});
