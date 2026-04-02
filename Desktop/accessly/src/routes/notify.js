/**
 * notify.js — POST /api/notify
 *
 * Saves an email address for users who hit the rate limit and want
 * to be notified when they can scan again. No email is sent in v1 —
 * this is a lead capture for manual follow-up.
 */

const express = require('express');
const { saveNotifyEmail } = require('../services/db');

const router = express.Router();

router.post('/', (req, res) => {
  const { email } = req.body;

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({
      error: true,
      message: 'A valid email address is required.',
      code: 'MISSING_FIELDS',
    });
  }

  try {
    saveNotifyEmail(email.trim().toLowerCase());
  } catch (err) {
    console.error('[notify] DB error:', err);
    return res.status(500).json({
      error: true,
      message: 'Could not save your email. Please try again.',
      code: 'DB_ERROR',
    });
  }

  return res.status(200).json({ success: true });
});

module.exports = router;
