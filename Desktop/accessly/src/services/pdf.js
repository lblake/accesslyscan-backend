/**
 * pdf.js — Branded PDF report generation
 *
 * Generates an AccesslyScan accessibility audit report from Claude's
 * structured analysis JSON. Returns a Buffer — no file is written to disk.
 * The buffer is streamed directly to the HTTP response on each download.
 *
 * Fonts: Inter (Regular, SemiBold, Bold) embedded from /fonts/
 * Layout: A4 portrait
 */

const PDFDocument = require('pdfkit');
const path = require('path');

// ─── Brand colours ──────────────────────────────────────────────────────────
const COLOURS = {
  background:   '#0f0f1a', // near-black — cover page bg
  accent:       '#f5e042', // AccesslyScan yellow
  white:        '#ffffff',
  textDark:     '#1a1a2e', // body text on white pages
  textMid:      '#4a4a6a', // secondary text
  severityCrit: '#e53e3e', // Critical — red
  severityMaj:  '#dd6b20', // Major — orange
  severityMin:  '#d69e2e', // Minor — amber
  ruleLine:     '#e2e8f0', // light grey horizontal rules
  coverSubtext: '#a0a0c0', // muted purple-grey on dark bg
};

// ─── Font paths ──────────────────────────────────────────────────────────────
const FONTS = {
  regular:  path.join(__dirname, '../../fonts/Inter-Regular.ttf'),
  semibold: path.join(__dirname, '../../fonts/Inter-SemiBold.ttf'),
  bold:     path.join(__dirname, '../../fonts/Inter-Bold.ttf'),
};

// ─── Page geometry ───────────────────────────────────────────────────────────
const MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4 points
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// ─── Severity helpers ────────────────────────────────────────────────────────
function severityColour(severity) {
  if (!severity) return COLOURS.severityMin;
  const s = severity.toLowerCase();
  if (s === 'critical') return COLOURS.severityCrit;
  if (s === 'major')    return COLOURS.severityMaj;
  return COLOURS.severityMin;
}

/**
 * Generate an accessibility audit PDF report.
 *
 * @param {object} analysisJson  - Claude's structured analysis output
 * @param {string} pageScanned   - Final URL after redirects (from WAVE)
 * @param {string} scanDate      - ISO 8601 timestamp of the scan
 * @returns {Promise<Buffer>}
 */
function generatePdf(analysisJson, pageScanned, scanDate) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      info: {
        Title: 'AccesslyScan Accessibility Audit Report',
        Author: 'AccesslyScan',
        Subject: `Accessibility audit for ${pageScanned}`,
      },
    });

    // Register Inter font variants
    doc.registerFont('Inter',         FONTS.regular);
    doc.registerFont('Inter-SemiBold', FONTS.semibold);
    doc.registerFont('Inter-Bold',    FONTS.bold);

    // Collect output into a buffer
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Pages ────────────────────────────────────────────────────────────────
    renderCoverPage(doc, analysisJson, pageScanned, scanDate);
    doc.addPage();
    renderExecutiveSummary(doc, analysisJson, pageScanned, scanDate);
    renderTopIssues(doc, analysisJson);
    renderFullIssueList(doc, analysisJson);
    renderCtaPage(doc, pageScanned);

    doc.end();
  });
}

// ─── Cover page ──────────────────────────────────────────────────────────────

function renderCoverPage(doc, analysis, pageScanned, scanDate) {
  // Dark background — fill entire page
  doc
    .rect(0, 0, PAGE_WIDTH, doc.page.height)
    .fill(COLOURS.background);

  // Accent bar at top
  doc.rect(0, 0, PAGE_WIDTH, 6).fill(COLOURS.accent);

  // Wordmark
  doc
    .font('Inter-Bold')
    .fontSize(32)
    .fillColor(COLOURS.white)
    .text('AccesslyScan', MARGIN, 80);

  // Tagline
  doc
    .font('Inter')
    .fontSize(12)
    .fillColor(COLOURS.coverSubtext)
    .text('Accessibility Audit Report', MARGIN, 120);

  // Risk score badge — centred
  const badgeY = 190;
  const score = analysis.riskScore ?? 0;
  const badgeColour = score >= 7 ? COLOURS.severityCrit
                    : score >= 4 ? COLOURS.severityMaj
                    : COLOURS.severityMin;

  // Outer ring — radius 85 gives a chord of ~152pt at cy+40,
  // wide enough for "Compliance Risk Score" at 9pt on a single line
  const BADGE_RADIUS = 85;
  const cx = PAGE_WIDTH / 2;
  const cy = badgeY + BADGE_RADIUS;
  doc.circle(cx, cy, BADGE_RADIUS).stroke(badgeColour).lineWidth(3);

  // Score number — centred inside the ring
  doc
    .font('Inter-Bold')
    .fontSize(52)
    .fillColor(badgeColour)
    .text(String(score), cx - 40, cy - 38, { width: 80, align: 'center' });

  // Label — 9pt, width 160 fits comfortably within the lower arc at this radius
  doc
    .font('Inter')
    .fontSize(9)
    .fillColor(COLOURS.coverSubtext)
    .text('Compliance Risk Score', cx - 80, cy + 40, { width: 160, align: 'center' });

  // URL scanned
  doc
    .font('Inter-SemiBold')
    .fontSize(12)
    .fillColor(COLOURS.white)
    .text('Page scanned', MARGIN, 380);

  doc
    .font('Inter')
    .fontSize(11)
    .fillColor(COLOURS.coverSubtext)
    .text(pageScanned, MARGIN, 398, { width: CONTENT_WIDTH });

  // Scan date
  const formatted = formatDate(scanDate);
  doc
    .font('Inter-SemiBold')
    .fontSize(12)
    .fillColor(COLOURS.white)
    .text('Scan date', MARGIN, 440);

  doc
    .font('Inter')
    .fontSize(11)
    .fillColor(COLOURS.coverSubtext)
    .text(formatted, MARGIN, 458);

  // Accent bar at bottom
  // NOTE: no footer text here — placing text below the bottom margin (page.height - MARGIN)
  // causes PDFKit to auto-paginate and produce a spurious blank page.
  // The branding footer lives on the CTA page instead.
  doc.rect(0, doc.page.height - 6, PAGE_WIDTH, 6).fill(COLOURS.accent);
}

// ─── Executive summary ───────────────────────────────────────────────────────

function renderExecutiveSummary(doc, analysis, _pageScanned, _scanDate) {
  sectionHeader(doc, 'Executive Summary');

  doc
    .font('Inter')
    .fontSize(11)
    .fillColor(COLOURS.textDark)
    .text(analysis.executiveSummary || '', { width: CONTENT_WIDTH, lineGap: 4 });

  doc.moveDown(1.5);

  // Summary stats row
  const score = analysis.riskScore ?? 0;
  const critCount = (analysis.fullIssueList || []).filter(
    (i) => i.severity?.toLowerCase() === 'critical'
  ).length;
  const totalCount = (analysis.fullIssueList || []).length;

  const stats = [
    { label: 'Risk Score',       value: `${score} / 10` },
    { label: 'Critical Issues',  value: String(critCount) },
    { label: 'Total Issues',     value: String(totalCount) },
    { label: 'Standard',         value: 'WCAG 2.1' },
  ];

  const colWidth = CONTENT_WIDTH / stats.length;
  const rowY = doc.y;

  stats.forEach((stat, i) => {
    const x = MARGIN + i * colWidth;

    doc
      .font('Inter-Bold')
      .fontSize(20)
      .fillColor(COLOURS.textDark)
      .text(stat.value, x, rowY, { width: colWidth, align: 'center' });

    doc
      .font('Inter')
      .fontSize(9)
      .fillColor(COLOURS.textMid)
      .text(stat.label, x, rowY + 26, { width: colWidth, align: 'center' });
  });

  doc.moveDown(4);
  horizontalRule(doc);
}

// ─── Top 3 critical issues ───────────────────────────────────────────────────

const CARD_INNER_PAD = 20; // padding inside issue cards, all sides
const CARD_HEADER_H  = 44; // fixed height of the coloured title bar

function renderTopIssues(doc, analysis) {
  const issues = (analysis.topIssues || []).slice(0, 3);
  if (issues.length === 0) return;

  // Inner geometry — 20px padding left and right inside the card
  const innerX     = MARGIN + CARD_INNER_PAD;
  const innerWidth = CONTENT_WIDTH - CARD_INNER_PAD * 2;

  issues.forEach((issue, idx) => {
    // Each issue gets its own page.
    // Page order: exec summary (p2) → issue 1 with section header (p3) → issues 2,3 (p4,5)
    doc.addPage();

    // Section header and intro appear only on the first issue page (p3),
    // keeping the exec summary page clean and uncluttered.
    if (idx === 0) {
      sectionHeader(doc, 'Top Priority Issues');
      doc
        .font('Inter')
        .fontSize(11)
        .fillColor(COLOURS.textMid)
        .text(
          'The following issues have the highest legal and commercial impact and should be addressed first.',
          MARGIN, doc.y, { width: CONTENT_WIDTH, lineGap: 3 }
        );
      doc.moveDown(1.5);
    }

    const colour    = severityColour(issue.severity);
    const headerY   = doc.y; // top of page = MARGIN after addPage()

    // ── Coloured header bar (fixed height, full content width) ──────────────
    doc.rect(MARGIN, headerY, CONTENT_WIDTH, CARD_HEADER_H).fill(colour);

    // Issue number + title — positioned absolutely inside the bar
    // Width leaves 80pt on the right for the severity badge
    doc
      .font('Inter-Bold')
      .fontSize(12)
      .fillColor(COLOURS.white)
      .text(
        `${idx + 1}.  ${issue.title || 'Untitled issue'}`,
        innerX,
        headerY + 16,
        { width: innerWidth - 80, lineBreak: false }
      );

    // Severity badge — right-aligned, vertically centred in bar
    doc
      .font('Inter-SemiBold')
      .fontSize(9)
      .fillColor(COLOURS.white)
      .text(
        (issue.severity || 'Minor').toUpperCase(),
        MARGIN + CONTENT_WIDTH - 80,
        headerY + 18,
        { width: 70, align: 'right' }
      );

    // ── Body — move cursor below header + top inner padding ─────────────────
    // Set doc.y explicitly so it sits flush below the header bar,
    // regardless of where the title text left the cursor.
    doc.y = headerY + CARD_HEADER_H + CARD_INNER_PAD;

    labeledParagraph(doc, 'What it is',              issue.description, innerWidth, innerX);
    labeledParagraph(doc, 'Legal & commercial risk',  issue.legalRisk,   innerWidth, innerX);
    labeledParagraph(doc, 'How to fix it',             issue.howToFix,    innerWidth, innerX);
  });
}

// ─── Full issue list ─────────────────────────────────────────────────────────

function renderFullIssueList(doc, analysis) {
  const issues = analysis.fullIssueList || [];
  if (issues.length === 0) return;

  if (doc.y > 500) doc.addPage();

  doc.moveDown(1);
  sectionHeader(doc, 'Full Issue List');

  doc
    .font('Inter')
    .fontSize(11)
    .fillColor(COLOURS.textMid)
    .text(
      'All accessibility issues identified during this scan, ordered by severity.',
      { width: CONTENT_WIDTH, lineGap: 3 }
    );

  doc.moveDown(1);

  // Table header
  const COL = { title: MARGIN, severity: MARGIN + 340, count: MARGIN + 450 };
  const headerY = doc.y;

  doc.rect(MARGIN, headerY, CONTENT_WIDTH, 22).fill(COLOURS.textDark);

  doc
    .font('Inter-SemiBold')
    .fontSize(9)
    .fillColor(COLOURS.white)
    .text('Issue', COL.title + 8, headerY + 7, { width: 320 })
    .text('Severity', COL.severity, headerY + 7, { width: 100 })
    .text('Count', COL.count, headerY + 7, { width: 40 });

  doc.moveDown(0.3);

  issues.forEach((issue, idx) => {
    if (doc.y > 720) doc.addPage();

    const rowY = doc.y;
    const rowBg = idx % 2 === 0 ? '#f7f7fb' : COLOURS.white;

    doc.rect(MARGIN, rowY, CONTENT_WIDTH, 20).fill(rowBg);

    const colour = severityColour(issue.severity);

    doc
      .font('Inter')
      .fontSize(9)
      .fillColor(COLOURS.textDark)
      .text(issue.title || '—', COL.title + 8, rowY + 6, { width: 320 });

    // Severity pill
    doc
      .rect(COL.severity, rowY + 4, 60, 13)
      .fill(colour);

    doc
      .font('Inter-SemiBold')
      .fontSize(7)
      .fillColor(COLOURS.white)
      .text((issue.severity || 'Minor').toUpperCase(), COL.severity + 2, rowY + 7, { width: 56, align: 'center' });

    doc
      .font('Inter')
      .fontSize(9)
      .fillColor(COLOURS.textDark)
      .text(String(issue.count ?? '—'), COL.count, rowY + 6, { width: 40 });

    doc.moveDown(0.15);
  });

  doc.moveDown(1);
}

// ─── CTA page ────────────────────────────────────────────────────────────────

function renderCtaPage(doc, _pageScanned) {
  doc.addPage();

  // Dark background
  doc
    .rect(0, 0, PAGE_WIDTH, doc.page.height)
    .fill(COLOURS.background);

  // Top accent bar
  doc.rect(0, 0, PAGE_WIDTH, 6).fill(COLOURS.accent);

  // Accent divider
  doc.rect(MARGIN, 100, 60, 4).fill(COLOURS.accent);

  doc
    .font('Inter-Bold')
    .fontSize(24)
    .fillColor(COLOURS.white)
    .text('Want the full picture?', MARGIN, 120, { width: CONTENT_WIDTH });

  doc.moveDown(0.8);

  const ctaBody =
    'This automated scan catches around 30% of accessibility issues — ' +
    'the ones that can be detected by a tool.\n\n' +
    'A full AccesslyScan audit covers the rest: manual review by an ' +
    'accessibility specialist, a prioritised fix list your development ' +
    'team can act on immediately, and compliance documentation you can ' +
    'use with legal if needed.';

  doc
    .font('Inter')
    .fontSize(12)
    .fillColor(COLOURS.coverSubtext)
    .text(ctaBody, { width: CONTENT_WIDTH, lineGap: 5 });

  doc.moveDown(2);

  // CTA button-style box
  const btnY = doc.y;
  doc.rect(MARGIN, btnY, CONTENT_WIDTH, 50).fill(COLOURS.accent);

  doc
    .font('Inter-Bold')
    .fontSize(14)
    .fillColor(COLOURS.textDark)
    .text(
      'Book a free 20-minute call — AccesslyScan.ai',
      MARGIN,
      btnY + 17,
      { width: CONTENT_WIDTH, align: 'center' }
    );

  // Bottom accent bar
  doc.rect(0, doc.page.height - 6, PAGE_WIDTH, 6).fill(COLOURS.accent);

  // Footer
  doc
    .font('Inter')
    .fontSize(9)
    .fillColor(COLOURS.coverSubtext)
    .text(
      'This report was generated by AccesslyScan.ai',
      MARGIN,
      doc.page.height - 30,
      { width: CONTENT_WIDTH, align: 'center' }
    );
}

// ─── Layout helpers ───────────────────────────────────────────────────────────

function sectionHeader(doc, title) {
  doc
    .font('Inter-Bold')
    .fontSize(18)
    .fillColor(COLOURS.textDark)
    .text(title, { width: CONTENT_WIDTH });

  // Accent underline
  const lineY = doc.y + 4;
  doc.rect(MARGIN, lineY, 40, 3).fill(COLOURS.accent);
  doc.moveDown(1.2);
}

function horizontalRule(doc) {
  doc
    .rect(MARGIN, doc.y, CONTENT_WIDTH, 1)
    .fill(COLOURS.ruleLine);
  doc.moveDown(0.5);
}

// width and x default to full content area; issue cards pass innerWidth/innerX
function labeledParagraph(doc, label, text, width = CONTENT_WIDTH, x = MARGIN) {
  if (!text) return;

  doc
    .font('Inter-SemiBold')
    .fontSize(10)
    .fillColor(COLOURS.textDark)
    .text(label, x, doc.y, { width });

  doc
    .font('Inter')
    .fontSize(10)
    .fillColor(COLOURS.textMid)
    .text(text, x, doc.y, { width, lineGap: 4 });

  doc.moveDown(1.2);
}

function formatDate(isoString) {
  try {
    return new Date(isoString).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return isoString;
  }
}

/**
 * Derive a filename-safe store domain from a URL.
 * e.g. "https://mystore.myshopify.com/products" → "mystore.myshopify.com"
 * @param {string} url
 * @returns {string}
 */
function domainFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'store';
  }
}

/**
 * Build the Content-Disposition filename for the PDF download.
 * Format: [store-domain]-accessibility-audit-[DD-MM-YYYY].pdf
 * @param {string} pageScanned
 * @param {string} scanDate - ISO 8601
 * @returns {string}
 */
function buildFilename(pageScanned, scanDate) {
  const domain = domainFromUrl(pageScanned);
  const iso = scanDate ? scanDate.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const [yyyy, mm, dd] = iso.split('-');
  const date = `${dd}-${mm}-${yyyy}`;
  return `${domain}-accessibility-audit-${date}.pdf`;
}

module.exports = { generatePdf, buildFilename };
