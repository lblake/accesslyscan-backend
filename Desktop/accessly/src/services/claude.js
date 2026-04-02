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
 * @returns {Promise<AnalysisResult>}
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
  "executiveSummary": "2-3 sentence plain-English summary of the accessibility situation and its business/legal risk. Do not use WCAG codes. Write as if speaking directly to the store owner.",
  "riskScore": <integer 1-10, where 10 is the highest risk>,
  "topIssues": [
    {
      "title": "Short descriptive title (not a WCAG code)",
      "description": "What the issue is and how it affects users with disabilities, in plain English",
      "severity": "Critical | Major | Minor",
      "legalRisk": "Specific legal and commercial risk this issue creates for the merchant",
      "howToFix": "Practical, actionable fix — what a developer should do"
    }
  ],
  "fullIssueList": [
    {
      "title": "Short descriptive title",
      "severity": "Critical | Major | Minor",
      "count": <number of instances>
    }
  ]
}

IMPORTANT GUIDANCE — follow this carefully:

1. LANGUAGE: Write for a non-technical merchant, not a developer. Never use raw WCAG codes (e.g. "1.1.1") as issue titles. Translate them into plain English (e.g. "Images missing text descriptions").

2. LEGAL CONTEXT — UK/EU first:
   - The European Accessibility Act (EAA) deadline passed in June 2025. UK/EU merchants are NOW exposed to enforcement and legal action — frame this seriously but without scaremongering.
   - Reference the UK Equality Act 2010 for UK merchants — failure to meet accessibility standards can constitute disability discrimination.
   - Reference WCAG 2.1 AA as the applicable standard.
   - Mention ADA (Americans with Disabilities Act) only as secondary context for US market exposure. Do not lead with it.

3. PRIORITISATION: Order topIssues by business impact (legal risk + revenue loss potential), not by WCAG severity level. A missing alt tag on a product image is higher impact than a colour contrast issue on a footer link.

4. SEVERITY MAPPING:
   - Critical: Blocks a user with a disability from completing a core task (purchase, navigation, account). Legal exposure is direct.
   - Major: Significantly degrades the experience but doesn't fully block access. Legal exposure is real.
   - Minor: Best-practice issue with low immediate legal risk but still worth fixing.

5. TONE: Direct and consultative. The merchant needs to understand the risk clearly but should not feel attacked. Avoid words like "illegal", "lawsuit", "penalty" — instead use "legal exposure", "enforcement risk", "discrimination claim".

6. TOP ISSUES: Include the 3 most impactful issues in topIssues. The fullIssueList should cover ALL issues found, including the top 3.

7. RISK SCORE:
   - 1-3: Minor issues only, low exposure
   - 4-6: Mix of major and minor issues, real but manageable exposure
   - 7-9: Multiple critical issues, significant legal and revenue risk
   - 10: Site is fundamentally inaccessible, extreme exposure

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
