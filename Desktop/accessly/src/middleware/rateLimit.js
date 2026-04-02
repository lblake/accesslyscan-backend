/**
 * rateLimit.js — IP-based rate limiting for POST /api/audit
 *
 * Allows 3 scan requests per IP per 60-minute rolling window.
 * Returns a consistent JSON error on breach — same shape as all other errors.
 */

const rateLimit = require('express-rate-limit');

const auditRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 60-minute rolling window
  max: 3,                    // max 3 requests per window per IP
  standardHeaders: true,     // return RateLimit-* headers so clients can self-throttle
  legacyHeaders: false,

  // Return consistent JSON error shape instead of the default HTML response
  handler: (_req, res) => {
    res.status(429).json({
      error: true,
      message:
        'You have reached the maximum number of free scans for this hour. ' +
        "Enter your email below and we'll let you know when you can scan again.",
      code: 'RATE_LIMITED',
    });
  },

  // Use the real client IP — important when behind Render's proxy
  // Render forwards the client IP in X-Forwarded-For
  keyGenerator: (req) => {
    return (
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket.remoteAddress
    );
  },
});

module.exports = { auditRateLimit };
