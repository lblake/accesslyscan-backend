/**
 * audit.js — Route handlers for the core audit flow
 *
 * POST /api/audit
 *   Orchestrates the full pipeline: WAVE scan → Claude analysis → DB save → response
 *
 * GET /api/audit/:scanId/pdf
 *   Retrieves stored analysis JSON and streams a freshly generated PDF
 */

const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const { scanUrl, WaveError } = require('../services/wave');
const { analyseResults, ClaudeError } = require('../services/claude');
const { generatePdf, buildFilename } = require('../services/pdf');
const { saveLead, saveAnalysis, getAnalysis } = require('../services/db');
const { auditRateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// ─── POST /api/audit ─────────────────────────────────────────────────────────

router.post('/', auditRateLimit, async (req, res) => {
  const { url, email, firstName } = req.body;

  // ── 1. Input validation ───────────────────────────────────────────────────
  const missing = [];
  if (!url)       missing.push('url');
  if (!email)     missing.push('email');
  if (!firstName) missing.push('firstName');

  if (missing.length > 0) {
    return res.status(400).json({
      error: true,
      message: `Missing required fields: ${missing.join(', ')}`,
      code: 'MISSING_FIELDS',
    });
  }

  // Basic URL format check — must be http or https
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Protocol must be http or https');
    }
  } catch {
    return res.status(400).json({
      error: true,
      message: 'The URL provided is not valid. Please include https:// at the start.',
      code: 'INVALID_URL',
    });
  }

  // ── 2. WAVE API scan ──────────────────────────────────────────────────────
  let waveData;
  try {
    waveData = await scanUrl(url);
  } catch (err) {
    if (err instanceof WaveError) {
      // WAVE_BLOCKED gets a 422 (store is reachable but refuses the scan)
      // all other WAVE errors get a 502 (upstream failure)
      const status = err.code === 'WAVE_BLOCKED' ? 422 : 502;
      return res.status(status).json({
        error: true,
        message: err.message,
        code: err.code,
      });
    }
    // Unexpected error
    console.error('[audit] Unexpected WAVE error:', err);
    return res.status(500).json({
      error: true,
      message: 'An unexpected error occurred during the accessibility scan.',
      code: 'INTERNAL_ERROR',
    });
  }

  // ── 3. Claude AI analysis ─────────────────────────────────────────────────
  let analysis;
  try {
    analysis = await analyseResults(waveData, url);
  } catch (err) {
    if (err instanceof ClaudeError) {
      return res.status(502).json({
        error: true,
        message: err.message,
        code: err.code,
      });
    }
    console.error('[audit] Unexpected Claude error:', err);
    return res.status(500).json({
      error: true,
      message: 'An unexpected error occurred while analysing the scan results.',
      code: 'INTERNAL_ERROR',
    });
  }

  // ── 4. Persist to SQLite ──────────────────────────────────────────────────
  const scanId = uuidv4();
  const ipAddress =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket.remoteAddress;

  try {
    saveLead({
      scanId,
      firstName,
      email,
      storeUrl: url,
      pageScanned: waveData.pageScanned,
      riskScore: analysis.riskScore,
      ipAddress,
    });

    saveAnalysis(scanId, {
      ...analysis,
      pageScanned: waveData.pageScanned,
      scanDate: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[audit] DB error:', err);
    return res.status(500).json({
      error: true,
      message: 'The scan completed successfully but could not be saved. Please try again.',
      code: 'DB_ERROR',
    });
  }

  // ── 5. Fire GHL webhook (non-blocking) ───────────────────────────────────
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const pdfUrl = `${baseUrl}/api/audit/${scanId}/pdf`;

  if (process.env.GHL_WEBHOOK_URL) {
    axios
      .post(process.env.GHL_WEBHOOK_URL, {
        firstName,
        email,
        url,
        riskScore: analysis.riskScore,
        pdfUrl,
        scanId,
      })
      .catch((err) => {
        // Log but never fail the request — email is best-effort
        console.error('[audit] GHL webhook error:', err.message);
      });
  }

  // ── 6. Build and return response ──────────────────────────────────────────
  return res.status(200).json({
    scanId,
    topIssues: analysis.topIssues,
    riskScore: analysis.riskScore,
    executiveSummary: analysis.executiveSummary,
    pdfUrl,
    pageScanned: waveData.pageScanned,
  });
});

// ─── GET /api/audit/:scanId/pdf ───────────────────────────────────────────────

router.get('/:scanId/pdf', async (req, res) => {
  const { scanId } = req.params;

  // ── 1. Retrieve stored analysis ───────────────────────────────────────────
  let record;
  try {
    record = getAnalysis(scanId);
  } catch (err) {
    console.error('[pdf] DB error fetching analysis:', err);
    return res.status(500).json({
      error: true,
      message: 'Could not retrieve the scan record.',
      code: 'DB_ERROR',
    });
  }

  if (!record) {
    return res.status(404).json({
      error: true,
      message: 'No scan found with that ID.',
      code: 'NOT_FOUND',
    });
  }

  // ── 2. Generate PDF ───────────────────────────────────────────────────────
  let pdfBuffer;
  try {
    pdfBuffer = await generatePdf(
      record.analysisJson,
      record.analysisJson.pageScanned,
      record.analysisJson.scanDate || record.createdAt
    );
  } catch (err) {
    console.error('[pdf] Generation error:', err);
    return res.status(500).json({
      error: true,
      message: 'Could not generate the PDF report.',
      code: 'PDF_ERROR',
    });
  }

  // ── 3. Stream to client ───────────────────────────────────────────────────
  const filename = buildFilename(
    record.analysisJson.pageScanned,
    record.analysisJson.scanDate || record.createdAt
  );

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  res.send(pdfBuffer);
});

module.exports = router;
