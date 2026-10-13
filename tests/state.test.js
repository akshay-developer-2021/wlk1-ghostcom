import { describe, it, expect, beforeEach, vi } from 'vitest';
import { state, set, setPeer, removePeer, clearPeers, on, linkedSlots } from '../src/core/state.js';

beforeEach(() => {
  /* reset module state between tests */
  clearPeers();
  set({ channel: null, secret: null, mySlot: -1, joined: false, tx: false, micHot: false, powerSave: false, sas: null });
});

describe('state store', () => {
  it('emits only on actual change', () => {
    const spy = vi.fn();
    on('channel', spy);
    set({ channel: '22' });
    set({ channel: '22' });      // no-op
    expect(spy).toHaveBeenCalledTimes(1);
    expect(state.channel).toBe('22');
  });

  it('emits change event with full state', () => {
    const spy = vi.fn();
    on('change', spy);
    set({ joined: true });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ joined: true }));
  });

  it('tracks peers with change detection', () => {
    const spy = vi.fn();
    on('peers', spy);
    setPeer(3, { linked: true });
    setPeer(3, { linked: true });      // no-op
    expect(spy).toHaveBeenCalledTimes(1);
    expect(linkedSlots()).toEqual([3]);
    setPeer(3, { speaking: true });
    expect(linkedSlots()).toEqual([3]);
    removePeer(3);
    expect(linkedSlots()).toEqual([]);
  });

  it('clearPeers wipes the mesh bookkeeping', () => {
    setPeer(0, { linked: true });
    setPeer(1, { linked: true });
    clearPeers();
    expect(linkedSlots()).toEqual([]);
  });
});
