import type { Request, Response, NextFunction } from 'express';

/** Tiny in-memory fixed-window rate limiter (no external dependency). */
export interface Limiter {
  /** Returns true if the call is allowed, false if the limit is exceeded. */
  hit(key: string, cost?: number): boolean;
  /** Remaining seconds until the key's window resets (0 if none). */
  retryAfterSec(key: string): number;
  reset(key: string): void;
  size(): number;
}

export function createLimiter(opts: { windowMs: number; max: number; maxKeys?: number }): Limiter {
  const maxKeys = opts.maxKeys ?? 50000;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, Math.min(opts.windowMs, 60_000));
  timer.unref();

  return {
    hit(key, cost = 1) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b || b.resetAt <= now) {
        // Bound memory: when saturated, drop the oldest key (Map keeps insertion order).
        if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value as string);
        b = { count: 0, resetAt: now + opts.windowMs };
        buckets.set(key, b);
      }
      b.count += cost;
      return b.count <= opts.max;
    },
    retryAfterSec(key) {
      const b = buckets.get(key);
      return b ? Math.max(0, Math.ceil((b.resetAt - Date.now()) / 1000)) : 0;
    },
    reset(key) { buckets.delete(key); },
    size() { return buckets.size; }
  };
}

export function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export function rateLimitMiddleware(limiter: Limiter, message = 'Too many requests.') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = clientIp(req);
    if (!limiter.hit(key)) {
      res.setHeader('Retry-After', String(limiter.retryAfterSec(key) || 60));
      res.status(429).json({ error: message });
      return;
    }
    next();
  };
}
