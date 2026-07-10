// src/middleware/rateLimiter.js
// In-memory rate limiting middleware for Express.
// Protects dashboard and API endpoints from abuse.

import { logger } from "../logger.js";

/**
 * Create a rate limiter middleware.
 *
 * @param {object} options
 * @param {number} options.windowMs - Time window in milliseconds (default: 60000 = 1 min)
 * @param {number} options.maxRequests - Max requests per window per IP (default: 60)
 * @param {string} [options.message] - Response message when rate limited
 * @param {boolean} [options.skipAuthenticated] - Skip rate limiting for authenticated users
 * @returns {Function} Express middleware
 */
export function createRateLimiter({
  windowMs = 60_000,
  maxRequests = 60,
  message = "Too many requests, please try again later.",
  skipAuthenticated = false,
} = {}) {
  const hits = new Map(); // IP → { count, resetAt }

  // Periodic cleanup to prevent memory leaks
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of hits) {
      if (now > record.resetAt) {
        hits.delete(ip);
      }
    }
  }, windowMs * 2);

  // Allow cleanup interval to not prevent process exit
  if (cleanupInterval.unref) cleanupInterval.unref();

  return function rateLimiterMiddleware(req, res, next) {
    // Skip for authenticated users if configured.
    // Passport exposes the user at req.user (session data lives under
    // req.session.passport); also accept req.session.user for safety.
    if (skipAuthenticated && (req.user || req.session?.user)) {
      return next();
    }

    const ip = req.ip || req.connection?.remoteAddress || "unknown";
    const now = Date.now();

    let record = hits.get(ip);
    if (!record || now > record.resetAt) {
      record = { count: 0, resetAt: now + windowMs };
      hits.set(ip, record);
    }

    record.count++;

    // Set rate limit headers
    res.set("X-RateLimit-Limit", String(maxRequests));
    res.set("X-RateLimit-Remaining", String(Math.max(0, maxRequests - record.count)));
    res.set("X-RateLimit-Reset", String(Math.ceil(record.resetAt / 1000)));

    if (record.count > maxRequests) {
      logger.warn({ ip, count: record.count, maxRequests }, "Rate limit exceeded");
      res.status(429).json({
        error: "rate_limited",
        message,
        retryAfter: Math.ceil((record.resetAt - now) / 1000),
      });
      return;
    }

    next();
  };
}

/**
 * Pre-configured rate limiters for different endpoint groups.
 */
export const apiLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 60,
  skipAuthenticated: true,
});

export const webhookLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 120,
  message: "Webhook rate limit exceeded.",
});

export const authLimiter = createRateLimiter({
  windowMs: 900_000, // 15 minutes
  maxRequests: 10,
  message: "Too many login attempts.",
});

export const dashboardLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 100,
  skipAuthenticated: true,
});