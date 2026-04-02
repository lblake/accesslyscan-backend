/**
 * wave.js — WAVE API integration
 *
 * Calls the WebAIM WAVE API with reporttype=4 (full results including
 * all issue items, not just category counts). Returns a normalised
 * object ready to pass to the Claude analysis service.
 *
 * WAVE API docs: https://wave.webaim.org/api/
 */

const axios = require('axios');

const WAVE_API_BASE = 'https://wave.webaim.org/api/request';

// Timeout for WAVE API calls — large Shopify stores can take a while to scan
const WAVE_TIMEOUT_MS = 60_000;

/**
 * Scan a URL with the WAVE API and return normalised results.
 *
 * @param {string} url - The URL to scan (exact URL provided by user)
 * @returns {Promise<{ pageScanned: string, categories: object, items: object }>}
 * @throws {WaveError} with a code property for structured error handling
 */
async function scanUrl(url) {
  // ── Diagnostic checks ────────────────────────────────────────────────────
  console.log('[wave] API key set:', !!process.env.WAVE_API_KEY);
  console.log('[wave] API key prefix:', process.env.WAVE_API_KEY?.slice(0, 6) + '…');
  console.log('[wave] URL to scan:', url);
  console.log('[wave] reporttype: 4');

  const params = {
    key: process.env.WAVE_API_KEY,
    url,
    reporttype: 4, // Full results: all items with details
    format: 'json',
  };

  // Log the exact query string that will be sent (key partially redacted)
  const redacted = { ...params, key: params.key?.slice(0, 6) + '…' };
  console.log('[wave] Request params:', JSON.stringify(redacted));

  let response;

  try {
    response = await axios.get(WAVE_API_BASE, {
      params,
      timeout: WAVE_TIMEOUT_MS,
    });
  } catch (err) {
    // Network-level failure (DNS, timeout, etc.)
    if (err.code === 'ECONNABORTED') {
      throw new WaveError(
        'The scan is taking longer than expected. This can happen with larger stores. Please try scanning a specific product or collection page URL instead of the homepage, or try again in a few minutes.',
        'WAVE_TIMEOUT'
      );
    }
    throw new WaveError(
      `WAVE API request failed: ${err.message}`,
      'WAVE_ERROR'
    );
  }

  const data = response.data;

  // Log the full raw response so we can see the exact structure
  console.log('[wave] Raw response:', JSON.stringify(data, null, 2));

  // WAVE API returns status.success as integer 1 (success) or 0 (failure).
  // Coerce to number so both 0 and false are treated as failure.
  if (!Number(data?.status?.success)) {
    // WAVE uses status.error for machine-readable messages and
    // status.description for human-readable ones — check both.
    const waveMessage =
      data?.status?.description ||
      data?.status?.error ||
      'Unknown WAVE error';

    // Detect stores that actively block external scanners
    if (isBlockedError(waveMessage)) {
      // Tailor the message for DNS failures vs deliberate blocks
      const isDns = waveMessage.toLowerCase().includes('err_name_not_resolved');
      const userMessage = isDns
        ? 'That URL could not be reached — please check the address is correct and the store is publicly accessible.'
        : 'This store is blocking external accessibility scanners. Try a different page URL, or contact us for a manual audit.';

      throw new WaveError(userMessage, 'WAVE_BLOCKED');
    }

    throw new WaveError(
      `WAVE scan failed: ${waveMessage}`,
      'WAVE_ERROR'
    );
  }

  // The URL after any redirects (e.g. HTTP → HTTPS, www → non-www)
  const pageScanned = data?.statistics?.pageurl || url;

  return {
    pageScanned,
    // category-level counts (errors, alerts, features, etc.)
    categories: data?.categories ?? {},
    // full item detail — the meat of reporttype=4
    items: data?.items ?? {},
    // raw statistics for context (total elements, wave version, etc.)
    statistics: data?.statistics ?? {},
  };
}

/**
 * Heuristic check for "store blocked the scanner" error messages.
 * WAVE doesn't use a consistent error code for this — we match on message text.
 * @param {string} message
 * @returns {boolean}
 */
function isBlockedError(message) {
  const blockedPhrases = [
    'could not be accessed',
    'access denied',
    'forbidden',
    '403',
    'blocked',
    'connection refused',
    'err_name_not_resolved',  // DNS failure — domain unreachable from WAVE
    'err_connection_refused',
    'err_connection_timed_out',
  ];
  const lower = message.toLowerCase();
  return blockedPhrases.some((phrase) => lower.includes(phrase));
}

/**
 * Structured error class for WAVE failures.
 * Includes a `code` property so the route handler can map it to the right
 * HTTP status and error code in the response.
 */
class WaveError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WaveError';
    this.code = code;
  }
}

module.exports = { scanUrl, WaveError };
