import { describe, expect, it, vi } from 'vitest';
import { fetchJson, HttpError, retryAfterMs } from '../src/net/http.js';
import { json } from './helpers.js';

const noSleep = { sleep: vi.fn(async (_ms: number) => {}) };

describe('fetchJson', () => {
  it('returns parsed JSON', async () => {
    expect(await fetchJson(async () => json({ ok: 1 }), 'u')).toEqual({ ok: 1 });
  });

  it('retries 429 honouring Retry-After, then succeeds', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ done: true }));
    expect(await fetchJson(fetch, 'u', {}, { sleep, baseDelayMs: 100 })).toEqual({ done: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls[0]).toEqual([2000]);
    expect(sleep.mock.calls[1]![0]).toBeLessThanOrEqual(200);
  });

  it('retries network errors and gives up after the limit', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(fetchJson(fetch, 'u', {}, { ...noSleep, retries: 2 })).rejects.toThrow(
      'fetch failed',
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry client errors', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ message: 'nope' }, 404));
    const error = (await fetchJson(fetch, 'https://x/y', {}, noSleep).catch(
      (e: unknown) => e,
    )) as HttpError;
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(404);
    expect(error.message).toContain('nope');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws the last HttpError when 5xx persists', async () => {
    const fetch = vi.fn().mockImplementation(async () => json({}, 500));
    await expect(fetchJson(fetch, 'u', {}, { ...noSleep, retries: 1 })).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchJson(async () => json({}), 'u', {}, { signal: controller.signal }),
    ).rejects.toThrow();
  });

  it('passes the signal to fetch', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => json({}));
    await fetchJson(fetch, 'u', { method: 'POST' }, { signal: controller.signal });
    expect(fetch).toHaveBeenCalledWith('u', { method: 'POST', signal: controller.signal });
  });
});

describe('retryAfterMs', () => {
  it('parses seconds and HTTP dates', () => {
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', Date.parse('2026-01-01T00:00:00Z'))).toBe(
      10_000,
    );
    expect(retryAfterMs('soon')).toBeUndefined();
  });
});
