# AccesslyScan Backend — Implementation Plan

## Overview

Node.js/Express backend that accepts a Shopify store URL and lead details,
runs a WAVE accessibility scan, has Claude AI analyse the results, generates
a branded PDF report on demand, and stores lead data in SQLite.

---

## Project Structure

```
accessly/
├── index.js                  # Entry point — Express app setup, middleware, route mounting
├── package.json
├── .env.example              # Template for required environment variables
├── .gitignore
│
├── src/
│   ├── routes/
│   │   ├── audit.js          # POST /api/audit and GET /api/audit/:scanId/pdf
│   │   └── notify.js         # POST /api/notify
│   │
│   ├── services/
│   │   ├── wave.js           # WAVE API call → normalised raw results
│   │   ├── claude.js         # Claude AI analysis → structured JSON
│   │   ├── pdf.js            # PDFKit report generation from structured JSON
│   │   └── db.js             # SQLite setup, queries (leads + scan results)
│   │
│   └── middleware/
│       └── rateLimit.js      # 3 scans/IP/hour using express-rate-limit
│
└── data/                     # Created at runtime by Render persistent disk
    └── leads.db              # SQLite database (production path: /data/leads.db)
```

**Why this structure:**
- Routes are thin — they validate input and orchestrate service calls only
- Services are single-responsibility and independently testable
- Middleware is isolated so rate limiting can be adjusted without touching routes

---

## Dependencies

| Package | Purpose |
|---|---|
| `express` | HTTP server and routing |
| `cors` | CORS middleware with origin whitelist |
| `dotenv` | Environment variable loading |
| `axios` | WAVE API HTTP calls |
| `@anthropic-ai/sdk` | Claude API client |
| `pdfkit` | PDF generation |
| `better-sqlite3` | SQLite — synchronous, no connection pooling needed at this scale |
| `express-rate-limit` | IP-based rate limiting |
| `uuid` | scanId generation |

No build step, no TypeScript, no ORM. Keeps the footprint minimal as requested.

---

## Environment Variables

```bash
# Required
WAVE_API_KEY=           # WAVE API key (https://wave.webaim.org/api/)
ANTHROPIC_API_KEY=      # Anthropic Claude API key
BASE_URL=               # e.g. https://accesslyscan-api.onrender.com
PORT=                   # Set automatically by Render; fallback to 3000 locally
NODE_ENV=               # "production" or "development"

# CORS — comma-separated list of allowed origins
CORS_ORIGIN=https://accesslyscan.ai,https://*.lovable.app,http://localhost:3000

# Future — not implemented in v1
SMTP_HOST=
SMTP_USER=
SMTP_PASS=
```

---

## Database Schema

**Table: `leads`**
Stores one row per successful scan.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `scanId` | TEXT UNIQUE | UUID — links to scan_results |
| `firstName` | TEXT | |
| `email` | TEXT | |
| `storeUrl` | TEXT | Original URL submitted |
| `pageScanned` | TEXT | Final URL after redirects |
| `riskScore` | INTEGER | 1–10 from Claude |
| `scanDate` | TEXT | ISO 8601 timestamp |
| `ipAddress` | TEXT | For rate limiting audit trail |

**Table: `scan_results`**
Stores Claude's structured JSON output for on-the-fly PDF generation.

| Column | Type | Notes |
|---|---|---|
| `scanId` | TEXT PK | UUID — matches leads.scanId |
| `analysisJson` | TEXT | Full JSON blob from Claude |
| `createdAt` | TEXT | ISO 8601 timestamp |

**Table: `notify_list`**
Rate-limited users who want to be notified.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `email` | TEXT | |
| `createdAt` | TEXT | ISO 8601 timestamp |

---

## Build Order & Implementation Steps

### Step 1 — Express server + health endpoint
- `index.js`: loads dotenv, sets up Express, mounts CORS, JSON body parser,
  and routes
- `GET /api/health` returns `{ status: "ok" }`
- Consistent error response shape established:
  `{ error: true, message: string, code: string }`
- Server listens on `process.env.PORT || 3000`

### Step 2 — WAVE API integration (`src/services/wave.js`)
- `scanUrl(url)` — calls WAVE API with `reporttype=4` (full results)
- Follows redirects via axios; captures final URL for `pageScanned`
- Returns normalised object: `{ pageScanned, categories, items }`
- Handles: invalid URL format, WAVE API errors, stores that block scanning
  (WAVE returns a specific error status for these), network timeouts

### Step 3 — Claude AI analysis (`src/services/claude.js`)
- `analyseResults(waveData, storeUrl)` — sends WAVE output to Claude
- Prompt instructs Claude to return **only valid JSON** (no markdown wrapper)
  with this shape:
  ```json
  {
    "executiveSummary": "2-3 sentence plain-English summary",
    "riskScore": 7,
    "topIssues": [
      {
        "title": "...",
        "description": "...",
        "severity": "Critical | Major | Minor",
        "legalRisk": "...",
        "howToFix": "..."
      }
    ],
    "fullIssueList": [
      { "title": "...", "severity": "...", "count": 3 }
    ]
  }
  ```
- Prompt framing (per spec):
  - Plain English, not WCAG jargon
  - UK/EU legal context first: EAA (deadline June 2025 — merchants now
    exposed), Equality Act 2010, WCAG 2.1 AA
  - Frame issues around legal risk and lost revenue
  - ADA mentioned only as secondary US market context
  - Tone: direct and consultative, not alarming
- Uses `claude-sonnet-4-6` model with `max_tokens: 2000`
- Validates JSON parse before returning; throws structured error if malformed

### Step 4 — PDF generation (`src/services/pdf.js`)
- `generatePdf(analysisJson, pageScanned, scanDate)` — returns a Buffer
- Layout:
  1. **Cover page**: dark background (`#1a1a2e`), AccesslyScan wordmark in
     white, accent bar in `#f5e042`, store URL and scan date, risk score badge
  2. **Executive summary**: 2-3 sentences from Claude output
  3. **Top 3 critical issues**: title, description, legal/commercial risk,
     how to fix — one section per issue with severity label
  4. **Full issue list**: table with issue title, severity, count
  5. **CTA page**: "This automated scan catches ~30% of accessibility
     issues..." with full copy per spec, accesslyscan.ai URL
- Filename for Content-Disposition header:
  `[store-domain]-accessibility-audit-[YYYY-MM-DD].pdf`
  e.g. `mystore.myshopify.com-accessibility-audit-2026-04-02.pdf`

### Step 5 — SQLite lead storage (`src/services/db.js`)
- `initDb()` — creates tables if not exist; called at server startup
- `saveLead(data)` — inserts into `leads`
- `saveAnalysis(scanId, analysisJson)` — inserts into `scan_results`
- `getAnalysis(scanId)` — retrieves JSON blob for PDF regeneration
- `saveNotifyEmail(email)` — inserts into `notify_list`
- DB path: `process.env.NODE_ENV === 'production' ? '/data/leads.db' : './leads.db'`

### Step 6 — Wire POST /api/audit (`src/routes/audit.js`)
Full orchestration:
1. Validate request body (`url`, `email`, `firstName` all required)
2. Basic URL format check (must be http/https)
3. Generate `scanId` (UUID v4)
4. Call `wave.scanUrl(url)` → raw results + final URL
5. Call `claude.analyseResults(waveData, url)` → structured JSON
6. Call `db.saveLead(...)` and `db.saveAnalysis(scanId, analysisJson)`
7. Construct `pdfUrl` from `BASE_URL + /api/audit/:scanId/pdf`
8. Return full response shape per spec

Each step catches its own errors and maps to a consistent error response with
an appropriate HTTP status and `code` string (e.g. `WAVE_ERROR`,
`CLAUDE_ERROR`, `DB_ERROR`, `INVALID_URL`).

### Step 7 — Rate limiting (`src/middleware/rateLimit.js`)
- `express-rate-limit` configured for 3 requests per 15-minute window per IP
  (equivalent to 3/hour but with a rolling window — simpler and more robust)
  — **Note**: spec says 3/hour; if you prefer a strict 60-minute window over
  a 15-minute rolling window, I'll implement accordingly
- Returns: HTTP 429 with `{ error: true, message: "...", code: "RATE_LIMITED" }`
- Applied only to `POST /api/audit` (not health or notify)

### Step 8 — PDF download endpoint
- `GET /api/audit/:scanId/pdf`
- Calls `db.getAnalysis(scanId)` — 404 if not found
- Calls `pdf.generatePdf(...)` — returns Buffer
- Sets headers:
  - `Content-Type: application/pdf`
  - `Content-Disposition: attachment; filename="..."`
- Streams Buffer to response

---

## Error Response Codes

| Code | Meaning | HTTP Status |
|---|---|---|
| `INVALID_URL` | URL missing or malformed | 400 |
| `MISSING_FIELDS` | Required body fields absent | 400 |
| `WAVE_ERROR` | WAVE API failure or scan blocked | 502 |
| `WAVE_BLOCKED` | Store blocked the WAVE scanner | 422 |
| `CLAUDE_ERROR` | Claude API failure or malformed response | 502 |
| `DB_ERROR` | SQLite read/write failure | 500 |
| `NOT_FOUND` | scanId not in database | 404 |
| `RATE_LIMITED` | IP exceeded scan limit | 429 |

---

## CORS Configuration

Origins parsed from `CORS_ORIGIN` env var (comma-separated). Additionally,
wildcard matching applied for `*.lovable.app` subdomains and `localhost:*`
using a custom origin function — express `cors` doesn't natively support
glob patterns so we'll match with a simple regex.

---

## Render Deployment Checklist (for reference)

| Setting | Value |
|---|---|
| Environment | Node |
| Build command | `npm install` |
| Start command | `node index.js` |
| Health check path | `/api/health` |
| Persistent disk mount | `/data` |
| Auto-deploy | Yes |

---

## Open Questions / Decisions for You to Confirm

1. **Rate limit window**: Spec says "3 per hour." `express-rate-limit` works
   more naturally with rolling windows. Recommend **3 per 60-minute rolling
   window** — functionally equivalent and simpler. OK?

2. **Claude model**: Plan uses `claude-sonnet-4-6` (current Sonnet, good
   balance of quality and speed for this use case). Prefer Haiku (faster/cheaper)
   or Opus (slower/more thorough)?

3. **WAVE reporttype**: Spec says `reporttype=4`. Confirming you have a WAVE
   API key that supports this report type (requires a paid WAVE API plan).

4. **PDF fonts**: PDFKit ships with Helvetica (built-in). For a more branded
   look we could embed a custom font (e.g. Inter). That requires adding a font
   file to the repo. Stick with Helvetica for v1, or add a custom font?

---

## What's NOT in v1

- Email delivery (SMTP env vars present but unused)
- API key authentication between Lovable and this backend
- PDF caching / pre-generation
- Admin dashboard or lead export
- Webhook on new scan

---

Approve this plan and I'll begin writing code in the build order above,
confirming each step before moving to the next.
