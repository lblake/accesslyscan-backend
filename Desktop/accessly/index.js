/**
 * index.js — AccesslyScan API entry point
 *
 * Starts the Express server, configures middleware, mounts routes,
 * and initialises the SQLite database. All other logic lives in
 * src/services/ and src/routes/.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const { initDb } = require('./src/services/db');
const auditRouter = require('./src/routes/audit');
const notifyRouter = require('./src/routes/notify');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Allowed origins come from the CORS_ORIGIN env var (comma-separated).
// *.lovable.app subdomains and localhost:* are matched by regex since
// the cors package doesn't support glob patterns natively.

const LOVABLE_REGEX = /^https:\/\/[a-z0-9-]+\.lovable\.app$/;
const LOCALHOST_REGEX = /^http:\/\/localhost(:\d+)?$/;

const staticOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. curl, Render health checks, same-origin)
      if (!origin) return callback(null, true);

      if (
        staticOrigins.includes(origin) ||
        LOVABLE_REGEX.test(origin) ||
        LOCALHOST_REGEX.test(origin)
      ) {
        return callback(null, true);
      }

      callback(new Error(`CORS: origin not allowed — ${origin}`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  })
);

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check — used by Render as the health check path
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/audit', auditRouter);
app.use('/api/notify', notifyRouter);

// ─── 404 catch-all ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: true,
    message: `Route not found: ${req.method} ${req.path}`,
    code: 'NOT_FOUND',
  });
});

// ─── Global error handler ─────────────────────────────────────────────────────
// Catches anything that falls through (e.g. CORS rejection, JSON parse errors)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err.message);
  res.status(500).json({
    error: true,
    message: err.message || 'An unexpected server error occurred.',
    code: 'INTERNAL_ERROR',
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

// Initialise SQLite before accepting requests
initDb();

app.listen(PORT, () => {
  console.log(`[server] AccesslyScan API running on port ${PORT}`);
  console.log(`[server] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[server] Base URL: ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
});
