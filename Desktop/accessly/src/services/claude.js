/**
 * claude.js — Claude AI analysis of WAVE accessibility scan results
 *
 * Sends normalised WAVE data to Claude and gets back a structured JSON
 * report with plain-English issue descriptions framed around legal risk
 * and lost revenue — not raw WCAG codes.
 *
 * Model: claude-sonnet-4-6
 */

const Anthropic = require('@anthropic-ai/sdk');

// Lazily initialised so the module can be required before env vars are loaded
let _client;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * Analyse WAVE scan results and return a structured report.
 *
 * @param {object} waveData - Normalised output from wave.scanUrl()
 * @param {string} storeUrl - Original URL submitted by the user
 * @returns {Promise<object>}
 * @throws {ClaudeError}
 */
async function analyseResults(waveData, storeUrl) {
  const prompt = buildPrompt(waveData, storeUrl);

  let message;
  try {
    message = await getClient().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    throw new ClaudeError(
      `Claude API request failed: ${err.message}`,
      'CLAUDE_ERROR'
    );
  }

  // Extract the text content from Claude's response
  const rawText = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // Parse and validate the JSON — Claude is instructed to return only JSON,
  // but we defensively strip any accidental markdown code fences
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ClaudeError(
      'Claude returned a response that could not be parsed as JSON.',
      'CLAUDE_PARSE_ERROR'
    );
  }

  // Validate required fields before returning
  if (
    typeof parsed.executiveSummary !== 'string' ||
    typeof parsed.riskScore !== 'number' ||
    !Array.isArray(parsed.topIssues) ||
    !Array.isArray(parsed.fullIssueList)
  ) {
    throw new ClaudeError(
      'Claude response was missing required fields.',
      'CLAUDE_PARSE_ERROR'
    );
  }

  return parsed;
}

/**
 * Build the prompt sent to Claude.
 * Instructs Claude to return only valid JSON with no surrounding markdown.
 * @param {object} waveData
 * @param {string} storeUrl
 * @returns {string}
 */
function buildPrompt(waveData, storeUrl) {
  // Summarise category counts for the prompt header
  const categorySummary = Object.entries(waveData.categories)
    .map(([key, val]) => `${key}: ${val?.count ?? 0}`)
    .join(', ');

  // Flatten items into a readable list for Claude to work with
  const itemLines = [];
  for (const [category, categoryData] of Object.entries(waveData.items || {})) {
    for (const [itemId, item] of Object.entries(categoryData?.items || {})) {
      itemLines.push(
        `[${category.toUpperCase()}] ${itemId} — "${item?.description || ''}" (count: ${item?.count ?? 1})`
      );
    }
  }

  const itemsText =
    itemLines.length > 0
      ? itemLines.join('\n')
      : 'No individual items returned by WAVE.';

  return `You are an accessibility consultant preparing a report for the owner of an e-commerce store.

The store URL is: ${storeUrl}

A WAVE API accessibility scan has returned the following results:

CATEGORY SUMMARY
${categorySummary}

INDIVIDUAL ISSUES
${itemsText}

---

Your task is to analyse these results and produce a structured report. You must respond with ONLY a valid JSON object — no markdown, no explanation, no code fences. The JSON must conform exactly to this structure:

{
  "executiveSummary": "3 sentences. Sentence 1: what the scan found and the overall picture (use specific numbers where available — errors, contrast failures, alerts). Sentence 2: what the most serious issues affect — name the specific functions at risk (e.g. adding to cart, selecting sizes, completing checkout). Sentence 3: why the merchant should act now — reference legal exposure and revenue impact directly. Write directly to the store owner. No hedging language.",
  "riskScore": <integer 1-10, where 10 is the highest risk>,
  "topIssues": [
    {
      "title": "Action-oriented title that names the specific problem and its impact — not a WCAG code. Example: 'Critical errors may block customers from selecting products or completing checkout'",
      "description": "What the issue is and exactly how it affects real customers. Be specific: name the type of user affected, what they cannot do, and what that means for a purchase. Use plain English. Quantify where possible (e.g. '10 critical errors', '24 contrast failures'). Do not hedge — if something blocks a purchase, say it blocks a purchase.",
      "severity": "Critical | Major | Minor",
      "legalRisk": "The specific legal and commercial risk this creates. Name the law (UK Equality Act 2010, EAA). State whether the issue affects core purchase journeys — this increases enforcement risk. Frame around likelihood of complaints or action, not just theoretical exposure. Be direct but not alarmist.",
      "howToFix": "Concise, actionable fix aimed at a developer. Name specific tools or techniques where relevant. Prioritise the highest-impact elements first."
    }
  ],
  "fullIssueList": [
    {
      "title": "Short descriptive title in plain English — no WCAG codes",
      "severity": "Critical | Major | Minor",
      "count": <number of instances>
    }
  ]
}

IMPORTANT GUIDANCE — follow this carefully:

1. AUDIENCE: You are writing for Shopify founders and ecommerce managers, not accessibility experts or developers. They care about revenue, legal risk, and keeping their store running — not WCAG clause numbers. Every sentence should be readable and actionable for someone with no accessibility background.

2. TONE: Urgent and commercially focused. This is not an academic report — it is a sales tool that should motivate action. Be direct about risk without being alarmist. Replace vague language ("may cause issues", "could potentially affect") with specific, confident statements ("blocks keyboard users from completing checkout", "prevents screen readers from reading product names"). Never use raw WCAG codes (e.g. "1.1.1") in any field.

3. EXECUTIVE SUMMARY — write 3 clear sentences:
   - Sentence 1: What the scan found. Mention the number and type of issues. Name the store if identifiable from the URL.
   - Sentence 2: What the most serious issues affect — be specific about which purchase functions are at risk.
   - Sentence 3: Why acting now matters — reference the EAA being in force and/or the UK Equality Act, and the revenue impact.

4. LEGAL CONTEXT — UK/EU first, always:
   - The European Accessibility Act (EAA) deadline passed in June 2025. UK/EU merchants are NOW exposed to enforcement and legal action. Do not say "may be exposed" — say "creates exposure to enforcement action".
   - Reference the UK Equality Act 2010 — failure to accommodate disabled customers can constitute disability discrimination.
   - WCAG 2.1 AA is the applicable standard — mention it by name where it strengthens the point.
   - Mention ADA only as secondary US market context. Never lead with it.

5. PRIORITISATION: Order topIssues by business impact — legal risk plus revenue loss potential. Issues that block core purchase journeys (add to cart, size selection, checkout) always rank above cosmetic or structural issues.

6. SEVERITY MAPPING:
   - Critical: Directly blocks a user with a disability from completing a core purchase task. Legal exposure is immediate and direct.
   - Major: Significantly degrades the experience or affects key information (prices, product names, CTAs). Legal exposure is real and demonstrable.
   - Minor: Best-practice issue with lower immediate legal risk but worth fixing as part of a broader remediation effort.

7. RISK SCORE:
   - 1-3: Minor issues only, low exposure
   - 4-6: Mix of major and minor issues, real but manageable exposure
   - 7-9: Multiple critical or systemic issues, significant legal and revenue risk
   - 10: Site is fundamentally inaccessible, extreme exposure across all purchase journeys

Respond with the JSON object only. No other text.`;
}

/**
 * Structured error class for Claude failures.
 */
class ClaudeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ClaudeError';
    this.code = code;
  }
}

module.exports = { analyseResults, ClaudeError };
