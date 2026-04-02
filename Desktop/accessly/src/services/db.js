/**
 * db.js — SQLite database setup and queries
 *
 * Uses better-sqlite3 (synchronous API) — appropriate for this scale.
 * DB path switches between local and Render's persistent disk based on NODE_ENV.
 */

const Database = require('better-sqlite3');
const path = require('path');

// Production: Render persistent disk at /data/
// Development: project root
const DB_PATH =
  process.env.NODE_ENV === 'production' ? '/data/leads.db' : './leads.db';

let db;

/**
 * Initialise the database and create tables if they don't exist.
 * Called once at server startup (from index.js).
 */
function initDb() {
  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  db.exec(`
    -- Lead capture: one row per successful scan
    CREATE TABLE IF NOT EXISTS leads (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      scanId      TEXT    UNIQUE NOT NULL,
      firstName   TEXT    NOT NULL,
      email       TEXT    NOT NULL,
      storeUrl    TEXT    NOT NULL,
      pageScanned TEXT    NOT NULL,
      riskScore   INTEGER NOT NULL,
      scanDate    TEXT    NOT NULL,
      ipAddress   TEXT    NOT NULL
    );

    -- Stores Claude's structured JSON so PDFs can be regenerated on demand
    CREATE TABLE IF NOT EXISTS scan_results (
      scanId      TEXT PRIMARY KEY,
      analysisJson TEXT NOT NULL,
      createdAt   TEXT NOT NULL
    );

    -- Email capture for rate-limited users who want to be notified
    CREATE TABLE IF NOT EXISTS notify_list (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      email     TEXT    NOT NULL,
      createdAt TEXT    NOT NULL
    );
  `);

  console.log(`[db] Connected to SQLite at ${DB_PATH}`);
}

/**
 * Save a lead record after a successful scan.
 * @param {object} data
 * @param {string} data.scanId
 * @param {string} data.firstName
 * @param {string} data.email
 * @param {string} data.storeUrl
 * @param {string} data.pageScanned
 * @param {number} data.riskScore
 * @param {string} data.ipAddress
 */
function saveLead(data) {
  const stmt = db.prepare(`
    INSERT INTO leads (scanId, firstName, email, storeUrl, pageScanned, riskScore, scanDate, ipAddress)
    VALUES (@scanId, @firstName, @email, @storeUrl, @pageScanned, @riskScore, @scanDate, @ipAddress)
  `);

  stmt.run({
    ...data,
    scanDate: new Date().toISOString(),
  });
}

/**
 * Save Claude's structured analysis JSON, keyed by scanId.
 * This is what the PDF download endpoint reads to regenerate the report.
 * @param {string} scanId
 * @param {object} analysisJson - Parsed Claude response object
 */
function saveAnalysis(scanId, analysisJson) {
  const stmt = db.prepare(`
    INSERT INTO scan_results (scanId, analysisJson, createdAt)
    VALUES (?, ?, ?)
  `);

  stmt.run(scanId, JSON.stringify(analysisJson), new Date().toISOString());
}

/**
 * Retrieve Claude's analysis JSON for a given scanId.
 * Returns null if the scanId doesn't exist.
 * @param {string} scanId
 * @returns {{ analysisJson: object, createdAt: string } | null}
 */
function getAnalysis(scanId) {
  const row = db
    .prepare('SELECT analysisJson, createdAt FROM scan_results WHERE scanId = ?')
    .get(scanId);

  if (!row) return null;

  return {
    analysisJson: JSON.parse(row.analysisJson),
    createdAt: row.createdAt,
  };
}

/**
 * Save an email address from a rate-limited user who wants to be notified.
 * @param {string} email
 */
function saveNotifyEmail(email) {
  const stmt = db.prepare(
    'INSERT INTO notify_list (email, createdAt) VALUES (?, ?)'
  );
  stmt.run(email, new Date().toISOString());
}

module.exports = { initDb, saveLead, saveAnalysis, getAnalysis, saveNotifyEmail };
