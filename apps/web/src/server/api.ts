import { ConflictError, NotFoundError, ValidationError } from '@/server/store';
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { readConfig } from './config';
import { RateLimiter } from './rate-limit';
import { getCurrentUser, type CurrentUser } from './session';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const config = readConfig();

/** One window per authenticated user, shared by web scans and CLI uploads. */
export const userLimiter = new RateLimiter(config.scansPerMinute, 60_000);

/** Website scans fetch third-party sites, so they get a third of the budget. */
export const userUrlLimiter = new RateLimiter(
  Math.max(1, Math.ceil(config.scansPerMinute / 3)),
  60_000,
);

export function enforceRateLimit(userId: string, limiter: RateLimiter = userLimiter): void {
  const retryAfter = limiter.hit(userId);
  if (retryAfter > 0) {
    throw new HttpError(`Too many requests. Try again in ${retryAfter}s.`, 429, {
      'retry-after': String(retryAfter),
    });
  }
}

export async function requireUser(request: Request): Promise<CurrentUser> {
  const user = await getCurrentUser(request.headers);
  if (!user) throw new HttpError('Sign in required', 401);
  return user;
}

/** Reads a JSON body, enforcing the size limit even when Content-Length is missing or wrong. */
export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes) {
    throw new HttpError('Request too large', 413);
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new HttpError('Request too large', 413);
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError('Request body must be JSON', 400);
  }
}

export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ');
    throw new HttpError(`Invalid request: ${issues}`, 400);
  }
  return result.data;
}

export const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { 'cache-control': 'no-store' } });

/** Wraps a handler and maps known errors to JSON error responses. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    const respond = (message: string, status: number, headers?: Record<string, string>) =>
      NextResponse.json({ error: message }, { status, ...(headers ? { headers } : {}) });
    if (e instanceof HttpError) return respond(e.message, e.status, e.headers);
    if (e instanceof NotFoundError) return respond(e.message, 404);
    if (e instanceof ConflictError) return respond(e.message, 409);
    if (e instanceof ValidationError) return respond(e.message, 400);
    console.error('request failed', e instanceof Error ? e.message : e);
    return respond('Internal error', 500);
  }
}

/** Public origin used in links handed to the CLI. */
export function originOf(request: Request): string {
  const configured = process.env.BETTER_AUTH_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return new URL(request.url).origin;
}
