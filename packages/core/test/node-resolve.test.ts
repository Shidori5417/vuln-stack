import { describe, expect, it } from 'vitest';
import { nodeResolve } from '../src/node/resolve.js';

describe('nodeResolve', () => {
  it('returns addresses for IP literals and localhost without network', async () => {
    expect(await nodeResolve('127.0.0.1')).toEqual(['127.0.0.1']);
    expect((await nodeResolve('localhost')).length).toBeGreaterThan(0);
  });
});
