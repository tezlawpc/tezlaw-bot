// ============================================================
//  NIGHTFOOD HOLDINGS, INC. — PCAOB AUDIT PORTAL
//  audit-classifier.js — AUTO-CLASSIFICATION ENGINE
//  ─────────────────────────────────────────────────────────
//  Decides, for every uploaded file and WITHOUT the uploader
//  picking anything:
//     · which of the 128 taxonomy categories it is
//     · which bracket / designated folder it files into
//     · which fiscal period it belongs to (FYE June 30)
//     · a plain-English brief for the auditor's notification
//     · a confidence score and whether a human must confirm
//
//  Two-stage design, deliberately:
//
//   STAGE 1 — deterministic scoring (always runs, no network)
//     Filename + extracted text are scored against the token
//     weights in audit-taxonomy.js. Fast, free, reproducible,
//     and auditable — which matters, because an auditor may
//     legitimately ask why a document landed where it did. Every
//     classification stores its reasoning trail.
//
//   STAGE 2 — Claude Haiku adjudication (only when needed)
//     Runs when stage 1 is ambiguous (low score, or top two
//     candidates within a narrow margin). Haiku sees the taxonomy
//     shortlist and the first ~6k characters of the document and
//     picks from the shortlist ONLY — it cannot invent a category.
//     It also writes the one-paragraph brief for the auditor.
//     If ANTHROPIC_API_KEY is absent or the call fails, the
//     deterministic result stands and the item is flagged for
//     human confirmation. The portal never blocks an upload on
//     the AI being available.
//
//  Text extraction: pdf-parse for PDF, mammoth for .docx, xlsx
//  for workbooks, plain read for text/csv. All already in
//  package.json — this module adds no dependencies.
// ============================================================

const tax = require("./audit-taxonomy");
const cal = require("./audit-calendar");

const HAIKU_MODEL = process.env.AUDIT_CLASSIFIER_MODEL || "claude-3-5-haiku-20241022";
const CONFIRM_THRESHOLD = Number(process.env.AUDIT_CLASSIFY_CONFIRM_AT || 55);
const AI_TRIGGER_SCORE = Number(process.env.AUDIT_CLASSIFY_AI_BELOW || 70);
const MAX_TEXT_FOR_AI = 6000;
const MAX_TEXT = 200000;

// ── Text extraction ─────────────────────────────────────────

/**
 * Reduce an HTML document to the words a human would read.
 *
 * This matters more than it looks. EDGAR serves every 10-K, 10-Q and 8-K
 * as .htm, and a modern filing is roughly 95% inline styling and inline
 * XBRL tags by volume. Returning the raw source and then truncating it
 * gave the classifier a slice that was 96% markup and — on a real filing,
 * where the styled preamble runs past the truncation point — contained
 * none of the document's actual words. "QUARTERLY REPORT", "GOING
 * CONCERN", the statement headings: all of it fell outside the window, so
 * an EDGAR filing was effectively classified on its filename alone.
 *
 * Stripping first and truncating after puts real text in the window.
 * Done with regexes rather than a parser on purpose: no new dependency,
 * and classification wants a bag of words, not a DOM.
 */
function htmlToText(html) {
  let s = String(html || "");
  // Script, style and head metadata carry no classification signal and a
  // great deal of volume.
  s = s.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Block-level boundaries become line breaks so headings stay separable.
  s = s.replace(/<\/(p|div|tr|h[1-6]|li|table|section)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Cell boundaries become spaces so "Total current liabilities" does not
  // run into the figure beside it.
  s = s.replace(/<\/t[dh]>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  // Entities, numeric and named. &#160;/&nbsp; dominate EDGAR documents.
  s = s.replace(/&#(\d+);/g, (_, d) => {
    const n = Number(d);
    return n === 160 ? " " : n > 31 && n < 65536 ? String.fromCharCode(n) : " ";
  });
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => {
    const n = parseInt(h, 16);
    return n === 160 ? " " : n > 31 && n < 65536 ? String.fromCharCode(n) : " ";
  });
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&(?:rsquo|lsquo|apos|#39);/gi, "'")
    .replace(/&(?:rdquo|ldquo);/gi, '"')
    .replace(/&(?:mdash|ndash);/gi, "-")
    .replace(/&[a-z]+;/gi, " ");
  // Collapse the whitespace the stripping leaves behind.
  s = s.replace(/[ \t ]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n");
  return s.trim();
}

async function extractText(buffer, filename, mimeType) {
  const name = String(filename || "").toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() : "";
  try {
    if (ext === "pdf" || /pdf/.test(mimeType || "")) {
      const pdfParse = require("pdf-parse");
      const out = await pdfParse(buffer);
      return { text: out.text || "", pages: out.numpages || null, engine: "pdf-parse" };
    }
    if (ext === "docx") {
      const mammoth = require("mammoth");
      const out = await mammoth.extractRawText({ buffer });
      return { text: out.value || "", pages: null, engine: "mammoth" };
    }
    if (["xlsx", "xlsm", "xls", "csv", "tsv"].includes(ext)) {
      const XLSX = require("xlsx");
      const wb = XLSX.read(buffer, { type: "buffer", sheetRows: 80 });
      const parts = [];
      // Sheet names carry a LOT of classification signal in close
      // packages ("Bank Rec", "Flux", "Debt Sched", "Cap Table").
      parts.push("SHEETS: " + wb.SheetNames.join(" | "));
      wb.SheetNames.slice(0, 12).forEach((sn) => {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sn], { blankrows: false });
        parts.push(`--- ${sn} ---\n` + csv.slice(0, 4000));
      });
      return { text: parts.join("\n"), pages: wb.SheetNames.length, engine: "xlsx", sheets: wb.SheetNames };
    }
    // HTML and inline-XBRL: strip to readable text BEFORE truncating.
    // Truncating the source first is what hid every EDGAR filing's body
    // behind its own styling preamble.
    if (["htm", "html", "xhtml"].includes(ext) || /html/.test(mimeType || "")) {
      const text = htmlToText(buffer.toString("utf8"));
      return { text: text.slice(0, MAX_TEXT), pages: null, engine: "html-text" };
    }
    if (["txt", "md", "json", "xml"].includes(ext) || /^text\//.test(mimeType || "")) {
      const raw = buffer.toString("utf8");
      // An .xml that is really a filing document gets the same treatment.
      const looksMarkedUp = /<[a-z][^>]*>/i.test(raw.slice(0, 4000));
      const text = looksMarkedUp ? htmlToText(raw) : raw;
      return { text: text.slice(0, MAX_TEXT), pages: null, engine: looksMarkedUp ? "html-text" : "utf8" };
    }
  } catch (err) {
    return { text: "", pages: null, engine: "failed", error: err.message };
  }
  // Images, zips, proprietary formats — filename is all we get.
  return { text: "", pages: null, engine: "none" };
}

// ── Stage 1: deterministic scoring ──────────────────────────

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ");
}

// Count non-overlapping occurrences, capped so one repeated word
// can't dominate.
function hits(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
    if (n >= 6) break;
  }
  return n;
}

const W = {
  strongFilename: 26,
  strongText: 11,
  kwFilename: 7,
  kwText: 2.2,
  labelTokenFilename: 4,
  negFilename: -22,
  negText: -7,
};

function scoreDeterministic({ filename, text, sheets }) {
  const fn = normalize(filename);
  // Sheet names weigh like filename signal, not body text.
  const fnPlus = sheets && sheets.length ? fn + " " + normalize(sheets.join(" ")) : fn;
  const body = normalize(text).slice(0, 120000);

  const scored = tax.CLASSIFIER_INDEX.map((c) => {
    let score = 0;
    const why = [];

    c.strong.forEach((t) => {
      const f = hits(fnPlus, t);
      if (f) {
        score += W.strongFilename * Math.min(f, 2);
        why.push(`filename/sheet strong "${t}" ×${f}`);
      }
      const b = hits(body, t);
      if (b) {
        score += W.strongText * Math.min(b, 3);
        why.push(`text strong "${t}" ×${b}`);
      }
    });

    c.kw.forEach((t) => {
      const f = hits(fnPlus, t);
      if (f) {
        score += W.kwFilename * Math.min(f, 2);
        why.push(`filename kw "${t}"`);
      }
      const b = hits(body, t);
      if (b) {
        score += W.kwText * Math.min(b, 4);
        why.push(`text kw "${t}" ×${b}`);
      }
    });

    c.labelTokens.forEach((t) => {
      if (hits(fnPlus, t)) {
        score += W.labelTokenFilename;
        why.push(`label token "${t}"`);
      }
    });

    c.neg.forEach((t) => {
      if (hits(fnPlus, t)) {
        score += W.negFilename;
        why.push(`NEG filename "${t}"`);
      } else if (hits(body, t)) {
        score += W.negText;
        why.push(`NEG text "${t}"`);
      }
    });

    return { code: c.code, bracket: c.bracket, label: c.label, raw: Math.max(0, score), why };
  })
    .filter((r) => r.raw > 0)
    .sort((a, b) => b.raw - a.raw);

  // Normalize to 0-100 against a reference ceiling so scores mean
  // the same thing across document types.
  const CEIL = 90;
  scored.forEach((r) => (r.score = Math.round(Math.min(100, (r.raw / CEIL) * 100))));

  const top = scored[0] || null;
  const second = scored[1] || null;
  const margin = top && second ? top.score - second.score : top ? top.score : 0;

  return { candidates: scored.slice(0, 6), top, second, margin };
}

// ── Stage 2: Claude Haiku adjudication ──────────────────────

function haikuAvailable() {
  return !!process.env.ANTHROPIC_API_KEY;
}

async function adjudicateWithHaiku({ filename, text, shortlist, periodGuess }) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const options = shortlist
    .map((c) => {
      const cat = tax.CATEGORY_BY_CODE[c.code];
      const br = tax.BRACKET_BY_CODE[cat.bracket];
      return `${c.code} | ${br.label} | ${cat.label}${cat.note ? " — " + cat.note.split(".")[0] + "." : ""}`;
    })
    .join("\n");

  const prompt = `You are classifying a document uploaded to a PCAOB audit-support portal for Nightfood Holdings, Inc. (NGTF), an OTC issuer with a JUNE 30 fiscal year end preparing to uplist to Nasdaq. Its segments are Foodservice Packaging Distribution (CarryOutSupplies.com), Robotics-as-a-Service (TechForce/RoboOp365), and Hospitality Asset Ownership (hotels). Its snack and beverage line was discontinued as of June 30, 2025.

FILENAME: ${filename}

DOCUMENT TEXT (truncated):
"""
${String(text || "").slice(0, MAX_TEXT_FOR_AI)}
"""

Choose the ONE best category from this shortlist. You may not invent a category outside the list.

${options}

Also decide the period the document covers, if it is determinable from the content. A pattern-match guess from the filename was: ${periodGuess ? JSON.stringify(periodGuess) : "none"}.

Respond with ONLY a JSON object, no prose and no code fence:
{
  "code": "<one code from the shortlist>",
  "confidence": <integer 0-100>,
  "period_as_of": "<YYYY-MM-DD or null>",
  "brief": "<2-3 sentences for the auditor: what this document IS, what period it covers, and the one thing an auditor would look at first. Name concrete figures or counts if they appear. No preamble.>",
  "flags": ["<short warning, e.g. 'appears to be a draft', 'password protected', 'missing user IDs', 'unsigned'>"],
  "reasoning": "<one sentence on why this category over the others>"
}`;

  const resp = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 900,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = (resp.content || []).map((b) => b.text || "").join("").trim();
  const jsonStr = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(jsonStr);

  // Hard guard: Haiku must stay inside the shortlist.
  if (!shortlist.some((c) => c.code === parsed.code)) {
    throw new Error(`Haiku returned out-of-shortlist code "${parsed.code}"`);
  }
  return parsed;
}

// ── Deterministic brief (fallback when no AI) ───────────────

function buildFallbackBrief({ category, period, filename, textInfo, sizeBytes }) {
  const cat = tax.CATEGORY_BY_CODE[category];
  const br = tax.BRACKET_BY_CODE[cat.bracket];
  const bits = [];
  bits.push(`${cat.label} filed under ${br.label}.`);
  if (period && period.asOf) bits.push(`Appears to be as of ${period.asOf}.`);
  else if (period && period.quarter) bits.push(`Assigned to ${period.quarter.label}.`);
  const mb = sizeBytes ? (sizeBytes / 1024 / 1024).toFixed(2) + " MB" : null;
  const shape = [];
  if (textInfo && textInfo.pages) shape.push(`${textInfo.pages} ${textInfo.engine === "xlsx" ? "sheet(s)" : "page(s)"}`);
  if (mb) shape.push(mb);
  if (shape.length) bits.push(`(${shape.join(", ")}.)`);
  if (cat.authority && cat.authority.length) bits.push(`Required under ${cat.authority.slice(0, 2).join(", ")}.`);
  return bits.join(" ");
}

// ── Quality pre-flight checks ───────────────────────────────
// Catch the problems that cause an auditor to bounce a PBC item
// straight back, BEFORE the auditor is notified. Cheap to run and
// saves a full round trip.
/**
 * Decide which engagement tier a classified document belongs to.
 *
 * Three rules, in order, and each exists because getting it wrong files
 * a document somewhere it can never be found:
 *
 *  1. A tier inferred from the document's DATE wins, but only if the
 *     category actually supports it. Previously an inferred tier was
 *     used unconditionally, so a document whose category exists only at
 *     the annual and event tiers could be assigned "monthly" and then
 *     fail to open an engagement.
 *
 *  2. For a June-30 fiscal year end there is NO fourth-quarter 10-Q —
 *     the fourth quarter IS the annual period. Without this, every
 *     document dated April through June that resolved to the quarterly
 *     tier threw "Quarter 4 has no 10-Q" and could not be filed at all,
 *     which is a quarter of the year.
 *
 *  3. Otherwise the category's own preference order decides, and a
 *     category offered only at the event tier goes there rather than
 *     being forced into a period it does not belong to.
 */
function resolveTier(cat, period) {
  const supported = (cat && cat.tiers) || [];
  let tier = period && period.inferredTier;
  if (tier && !supported.includes(tier)) tier = null;

  if (!tier) {
    tier = supported.includes("monthly")
      ? "monthly"
      : supported.includes("quarterly")
      ? "quarterly"
      : supported[0] || "monthly";
  }

  if (tier === "quarterly" && period && period.quarter && period.quarter.quarter === 4) {
    tier = supported.includes("annual") ? "annual" : supported.includes("event") ? "event" : tier;
  }

  return tier;
}

function preflight({ category, filename, text, sizeBytes, textInfo }) {
  const flags = [];
  const t = normalize(text);
  const fn = normalize(filename);

  if (!sizeBytes) flags.push("empty_file");
  if (textInfo && textInfo.engine === "failed") flags.push("text_extraction_failed");
  if (textInfo && textInfo.engine === "none") flags.push("no_text_layer_scanned_or_image");

  // CRITICAL: every check below this line reasons about what the
  // document CONTAINS. If no text could be extracted — a scanned PDF,
  // an image, a password-protected file, a parser that threw — then
  // absence of a phrase proves nothing, and asserting otherwise
  // produces false accusations ("journal entry export is missing user
  // IDs") about documents that are perfectly fine. An auditor who is
  // told twice that a good document is defective stops reading the
  // flags at all, which costs more than the checks are worth.
  //
  // So when there is no text to inspect, we say only that we could not
  // inspect it, and stop.
  const readable = (text || "").trim().length > 40;
  if (!readable) {
    if (sizeBytes && !flags.includes("text_extraction_failed") && !flags.includes("no_text_layer_scanned_or_image")) {
      flags.push("no_readable_text_checks_skipped");
    }
    return flags;
  }

  if (/\bdraft\b|\bwip\b|\bwork in progress\b/.test(fn + " " + t.slice(0, 3000))) flags.push("marked_draft");
  if (/\[?(tbd|tba|xx+|placeholder|to be determined)\]?/.test(t.slice(0, 5000))) flags.push("contains_placeholders");

  // Category-specific gates that reflect an actual standard.
  if (category === "B-030" || category === "B-020") {
    // AS 2401.58 journal entry testing needs the preparer/approver.
    const hasUser = /user\s*id|entered by|created by|prepared by|posted by|approver|approved by/.test(t);
    if (!hasUser) flags.push("je_export_missing_user_id_or_approver");
    const hasDates = /entry date|posting date|effective date|created date/.test(t);
    if (!hasDates) flags.push("je_export_missing_entry_vs_effective_date");
  }
  if (["L-120", "L-130", "L-040", "L-050"].includes(category)) {
    const signed = /\/s\/|signature|signed|duly authorized|electronically signed/.test(t);
    if (!signed) flags.push("appears_unsigned");
  }
  if (category === "C-040" || category === "G-070") {
    if (!/authoriz/.test(t)) flags.push("confirmation_authorization_language_not_found");
  }
  if (["G-060", "J-020", "H-050"].includes(category)) {
    // AS 2501 requires the auditor to test the data and assumptions —
    // impossible from a flat PDF of model output.
    const ext = fn.split(".").pop();
    if (["pdf", "png", "jpg", "jpeg"].includes(ext)) flags.push("model_uploaded_as_flat_file_request_live_workbook");
  }
  if (category === "A-010" || category === "A-020") {
    if (/unapproved|draft minutes/.test(t)) flags.push("minutes_not_yet_approved_acceptable_note_it");
  }
  return flags;
}

// ── Main entry point ────────────────────────────────────────

/**
 * Classify one uploaded document.
 * Never throws — on total failure returns an UNCLASSIFIED result
 * that lands in the triage queue so the upload still succeeds.
 */
async function classify({ filename, buffer, mimeType, sizeBytes, useAI = true, periodHint = null }) {
  const started = Date.now();
  const trail = [];
  let textInfo = { text: "", engine: "skipped" };

  try {
    textInfo = await extractText(buffer, filename, mimeType);
    trail.push(`extracted via ${textInfo.engine}${textInfo.pages ? ` (${textInfo.pages})` : ""}`);
  } catch (err) {
    trail.push(`extraction error: ${err.message}`);
  }

  // Period: explicit hint wins, then filename, then document text.
  let period = null;
  if (periodHint) {
    // cal.dstr tolerates anything date-ish and returns "" rather than
    // throwing; cal.iso(cal.parse(x)) used to blow up on "09/30/2026",
    // "Sept 2026" or "Q1 FY2026" — and it sat outside the only try in
    // this function, so the documented "never throws" guarantee failed
    // and the uploader got "Cannot read properties of null".
    const asOf = cal.dstr(periodHint) || null;
    if (asOf) {
      period = { matched: "explicit hint", ...cal.resolvePeriods(asOf), asOf };
      trail.push(`period from explicit hint ${asOf}`);
    } else {
      const sniffed = cal.sniffPeriod(String(periodHint));
      if (sniffed) {
        period = sniffed;
        trail.push(`period hint "${periodHint}" parsed loosely as ${sniffed.asOf || sniffed.quarter.label}`);
      } else {
        trail.push(`period hint "${periodHint}" not understood — ignored`);
      }
    }
  }
  if (!period) {
    period = cal.sniffPeriod(filename);
    if (period) trail.push(`period from filename "${period.matched}"`);
  }
  if (!period && textInfo.text) {
    period = cal.sniffPeriod(textInfo.text.slice(0, 4000));
    if (period) trail.push(`period from document text "${period.matched}"`);
  }

  const det = scoreDeterministic({ filename, text: textInfo.text, sheets: textInfo.sheets });
  trail.push(
    det.top
      ? `deterministic top ${det.top.code} @${det.top.score} (margin ${det.margin})`
      : "deterministic: no candidate matched"
  );

  let code = det.top ? det.top.code : null;
  let confidence = det.top ? det.top.score : 0;
  let brief = null;
  let aiFlags = [];
  let method = "deterministic";
  let aiReasoning = null;

  // Decide whether to escalate to Haiku.
  const ambiguous = !det.top || det.top.score < AI_TRIGGER_SCORE || (det.second && det.margin < 12);
  if (useAI && ambiguous && haikuAvailable()) {
    // Shortlist: deterministic candidates, padded with the most
    // commonly-confused neighbours so Haiku has real choices.
    let shortlist = det.candidates.slice(0, 6);
    if (shortlist.length < 3) {
      const pad = ["B-010", "B-050", "B-060", "C-020", "D-010", "L-170"]
        .filter((c) => !shortlist.some((s) => s.code === c))
        .map((c) => ({ code: c }));
      shortlist = shortlist.concat(pad).slice(0, 8);
    }
    try {
      const ai = await adjudicateWithHaiku({
        filename,
        text: textInfo.text,
        shortlist,
        periodGuess: period ? { asOf: period.asOf || null, quarter: period.quarter && period.quarter.label } : null,
      });
      code = ai.code;
      confidence = Math.max(confidence, Number(ai.confidence) || 0);
      brief = ai.brief || null;
      aiFlags = Array.isArray(ai.flags) ? ai.flags.filter(Boolean) : [];
      aiReasoning = ai.reasoning || null;
      method = "haiku_adjudicated";
      trail.push(`haiku chose ${ai.code} @${ai.confidence}: ${ai.reasoning || ""}`);
      if (ai.period_as_of && /^\d{4}-\d{2}-\d{2}$/.test(ai.period_as_of)) {
        const p = cal.resolvePeriods(ai.period_as_of);
        if (p) {
          period = { matched: "haiku", asOf: ai.period_as_of, ...p };
          trail.push(`period from haiku ${ai.period_as_of}`);
        }
      }
    } catch (err) {
      trail.push(`haiku unavailable/failed, keeping deterministic: ${err.message}`);
      method = "deterministic_ai_failed";
    }
  } else if (ambiguous && !haikuAvailable()) {
    trail.push("ambiguous but ANTHROPIC_API_KEY not set — deterministic result stands");
  }

  // Nothing matched at all → triage queue, not a rejection.
  if (!code) {
    return {
      ok: true,
      classified: false,
      categoryCode: null,
      bracketCode: null,
      folderPath: null,
      confidence: 0,
      needsConfirmation: true,
      method: "unclassified",
      brief:
        `Could not auto-classify "${filename}". Routed to the triage queue for manual ` +
        `categorization — the file is stored and versioned, nothing is lost.`,
      flags: ["unclassified"],
      period: period || cal.resolvePeriods(new Date()),
      candidates: [],
      reasoningTrail: trail,
      textChars: (textInfo.text || "").length,
      ms: Date.now() - started,
    };
  }

  if (!period) {
    period = cal.resolvePeriods(new Date());
    trail.push("no period found — defaulted to current period, flagged for confirmation");
  }

  const cat = tax.CATEGORY_BY_CODE[code];
  const tier = resolveTier(cat, period);

  const periodLabelForFolder =
    tier === "annual"
      ? period.annual.label
      : tier === "quarterly"
      ? period.quarter.label
      : tier === "event"
      ? // The event's own engagement label is derived downstream, from the
        // document and its date. Until then the folder is provisional.
        `EVT-${period.asOf || period.annual.end}`
      : period.month.label;

  const flags = [
    ...new Set([
      ...preflight({ category: code, filename, text: textInfo.text, sizeBytes, textInfo }),
      ...aiFlags,
      ...(period.matched ? [] : ["period_not_determinable"]),
    ]),
  ];

  if (!brief) {
    brief = buildFallbackBrief({ category: code, period, filename, textInfo, sizeBytes });
  }

  return {
    ok: true,
    classified: true,
    categoryCode: code,
    categoryLabel: cat.label,
    bracketCode: cat.bracket,
    bracketLabel: tax.BRACKET_BY_CODE[cat.bracket].label,
    folderPath: tax.folderPath(code, { fiscalYear: period.fiscalYear, periodLabel: periodLabelForFolder }),
    tier,
    period: {
      fiscalYear: period.fiscalYear,
      asOf: period.asOf || null,
      monthLabel: period.month.label,
      quarterLabel: period.quarter.label,
      annualLabel: period.annual.label,
      periodLabel: periodLabelForFolder,
      source: period.matched || "default",
    },
    confidence,
    needsConfirmation: confidence < CONFIRM_THRESHOLD || flags.includes("unclassified"),
    isGate: !!cat.gate,
    isConfidential: !!cat.conf,
    authority: cat.authority || [],
    categoryNote: cat.note || null,
    defaultOwner: cat.owner || null,
    brief,
    aiReasoning,
    flags,
    candidates: det.candidates.map((c) => ({ code: c.code, label: c.label, score: c.score })),
    reasoningTrail: trail,
    method,
    textChars: (textInfo.text || "").length,
    ms: Date.now() - started,
  };
}

module.exports = {
  classify,
  extractText,
  htmlToText,
  scoreDeterministic,
  preflight,
  haikuAvailable,
  CONFIRM_THRESHOLD,
  AI_TRIGGER_SCORE,
};
