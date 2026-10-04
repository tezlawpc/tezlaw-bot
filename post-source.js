/**
 * post-source.js — a document or JJ's own text as the source of a post.
 *
 * The Post Creator could only take a topic or a link. JJ wants to hand it the
 * thing itself: a decision, an order, a notice — or an article he wrote — and
 * have it go out the same way as the daily posts (website in three languages,
 * Rule 7.1 gate, branded card, Telegram approval, Postiz).
 *
 * Three jobs, no state:
 *   extract(buffer, filename)     file → text (and clean HTML for a .docx)
 *   sourceContext({...})          the instructions + text handed to the writer
 *   postFromOwnText({...})        JJ's own words → a post object, NOT rewritten
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *   · It does not publish. /api/post/generate returns a draft; a document-
 *     sourced draft is always shown for review before /api/post/publish.
 *   · It does not keep the upload. The file is read in memory for this one
 *     request and dropped; a client's order must not end up in a table because
 *     someone wanted a blog post about it.
 *   · It does not read scans. A scanned PDF has no text layer; extract() says
 *     so instead of handing the writer two lines of noise to invent around.
 */

const MAX_BYTES = 15 * 1024 * 1024;       // the JSON body limit is 25 MB; base64 adds a third
const MAX_SOURCE_CHARS = 60000;           // what the writer is given; a long opinion is cut, and says so
const MIN_USEFUL_CHARS = 400;

const ALLOWED = ["pdf", "docx", "txt", "md"];

function extOf(filename) {
  const n = String(filename || "").toLowerCase();
  return n.includes(".") ? n.split(".").pop() : "";
}

const tidy = (s) => String(s || "")
  .replace(/\r\n?/g, "\n").replace(/[ \t ]+/g, " ")
  .replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Keep only the tags a post body needs. mammoth output is already plain, but
// it is a file from outside going onto the public site: nothing gets through
// that was not asked for — no scripts, styles, images, or attributes other
// than a web link's href.
function sanitizeHtml(html) {
  let s = String(html || "")
    .replace(/<(script|style|iframe|object|embed|svg|img|table)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(img|br|hr)[^>]*>/gi, m => (/^<br/i.test(m) ? "<br>" : ""))
    .replace(/<h1(\s[^>]*)?>/gi, "<h2>").replace(/<\/h1>/gi, "</h2>");
  s = s.replace(/<(\/?)([a-z0-9]+)([^>]*)>/gi, (m, close, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!["p", "h2", "h3", "h4", "ul", "ol", "li", "strong", "b", "em", "i", "u", "blockquote", "a", "br", "sup"].includes(t)) return "";
    if (close) return `</${t}>`;
    if (t === "a") {
      const href = (attrs.match(/href\s*=\s*"(https?:\/\/[^"]+)"/i) || [])[1];
      return href ? `<a href="${esc(href)}">` : "<a>";
    }
    return `<${t}>`;
  });
  return s.replace(/<a>([\s\S]*?)<\/a>/gi, "$1").replace(/<p>\s*<\/p>/g, "").trim();
}

/**
 * @returns {Promise<{ok, name, kind, text, html, chars, pages, truncated, warning, error}>}
 */
async function extract(buffer, filename) {
  const name = String(filename || "document").replace(/[\\/]/g, "_").slice(0, 200);
  const kind = extOf(name);
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, name, error: "The file arrived empty. Try choosing it again." };
  if (buffer.length > MAX_BYTES) return { ok: false, name, error: `That file is ${(buffer.length / 1048576).toFixed(1)} MB. The limit is 15 MB.` };
  if (!ALLOWED.includes(kind)) {
    return { ok: false, name, error: kind === "doc"
      ? "Old Word files (.doc) can't be read. Open it in Word, save as .docx, and upload that."
      : "Upload a PDF, a Word file (.docx), or a text file." };
  }

  let text = "", html = null, pages = null;
  try {
    if (kind === "pdf") {
      const out = await require("pdf-parse")(buffer);
      text = out.text || ""; pages = out.numpages || null;
    } else if (kind === "docx") {
      const mammoth = require("mammoth");
      text = (await mammoth.extractRawText({ buffer })).value || "";
      html = sanitizeHtml((await mammoth.convertToHtml({ buffer })).value || "");
    } else {
      text = buffer.toString("utf8");
    }
  } catch (e) {
    return { ok: false, name, error: `Could not read ${name}: ${e.message}` };
  }

  text = tidy(text);
  if (text.length < MIN_USEFUL_CHARS && kind === "pdf") {
    return { ok: false, name, pages, error:
      `No readable text in ${name}${pages ? ` (${pages} page${pages === 1 ? "" : "s"})` : ""}. ` +
      "It looks like a scan — a picture of the pages. Upload a text PDF or the Word file, or paste the text into the box." };
  }
  if (!text) return { ok: false, name, error: `${name} has no text in it.` };

  const truncated = text.length > MAX_SOURCE_CHARS;
  return {
    ok: true, name, kind, pages, html,
    chars: text.length,
    text: truncated ? text.slice(0, MAX_SOURCE_CHARS) : text,
    truncated,
    warning: truncated
      ? `Long document: the first ${MAX_SOURCE_CHARS.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters are used.`
      : (text.length < MIN_USEFUL_CHARS ? "Very little text was found in this file." : null),
  };
}

/**
 * What the writer (autoposter.generatePost) is given as CONTEXT when the
 * source is a document. The rules sit ABOVE the text so they are read first.
 *
 * anonymize defaults to true. A document JJ uploads is, as often as not, from
 * a client's file. Rule 1.6 does not care that the decision is public or that
 * the client won; naming them on the firm's blog needs their consent, and this
 * tool cannot know whether it was given. So the default leaves people out, and
 * keeping names is a box JJ ticks for that one post.
 */
function sourceContext({ name, text, anonymize = true, notes = "", truncated = false } = {}) {
  const privacy = anonymize
    ? `PRIVACY — mandatory. Do NOT name or identify any private person or business that appears in the document: no names of clients, parties, family members, witnesses or employers; no A-numbers, receipt or case numbers, dates of birth, street addresses, phone numbers or emails. Write "the applicant", "the petitioner", "the tenant", "a business owner". You may name the court or agency, the judge, the statute or rule, and published authorities the document cites. If a detail could identify the person even without the name (a small town plus an unusual occupation, an exact filing date), generalise it.`
    : `NAMES — the attorney has confirmed this is a public decision and that naming the parties is appropriate. Use names only as they appear in the document; still leave out A-numbers, dates of birth, home addresses, phone numbers and emails.`;

  return [
    // The file name is shown only when names are allowed — it is often the client's name.
    `SOURCE DOCUMENT${!anonymize && name ? ` — "${name}"` : ""}. The article is ABOUT this document.`,
    "",
    "RULES FOR USING IT",
    "1. Every statement about what the document says, holds, orders or requires must come from the text below. Do not add facts about this matter from memory or from a search, and do not guess at anything the text does not say. If the text is silent on a point a reader would expect, leave it out.",
    "2. Explain what happened and what it means for people in a similar position, in plain language. General legal background may come from your own knowledge and official sources.",
    `3. ${privacy}`,
    "4. This is not a victory announcement. Do not present the document as the firm's result or achievement, and do not suggest readers can expect the same. If it describes an outcome in a particular case, state it factually and add that every case turns on its own facts and that a past result does not predict or guarantee a similar one.",
    "5. Do not quote more than a sentence or two at a time.",
    truncated ? "6. The text below was cut off for length. Write only about the part you can see, and do not describe how the document ends." : "",
    notes ? `\nTHE ATTORNEY'S NOTES ON WHAT TO COVER: ${String(notes).slice(0, 2000)}` : "",
    "",
    "----- BEGIN DOCUMENT TEXT -----",
    String(text || ""),
    "----- END DOCUMENT TEXT -----",
  ].filter(l => l !== "").join("\n");
}

// A fallback topic line when JJ uploads a file and types no topic. The file
// name is deliberately NOT used: "Chen Wei bond order.pdf" would hand the
// writer the client's name in the one place the privacy rule does not cover.
function topicFor({ topic } = {}) {
  const t = String(topic || "").trim();
  return t || "What the attached document means, explained in plain language for the people it affects";
}

// ── JJ's own article, published as written ────────────────────────────

// Plain text → HTML. Blank line = new paragraph. "# " / "## " or a short line
// with no closing punctuation standing alone = a heading. "- " / "* " / "1. "
// lines = a list. Nothing is reworded.
function textToHtml(text) {
  const blocks = tidy(text).split(/\n{2,}/);
  const out = [];
  for (const raw of blocks) {
    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const md = lines[0].match(/^(#{1,4})\s+(.*)$/);
    if (lines.length === 1 && md) { out.push(`<${md[1].length <= 2 ? "h2" : "h3"}>${esc(md[2])}</${md[1].length <= 2 ? "h2" : "h3"}>`); continue; }
    if (lines.every(l => /^([-*•]|\d+[.)])\s+/.test(l))) {
      const ordered = /^\d+[.)]\s+/.test(lines[0]);
      out.push(`<${ordered ? "ol" : "ul"}>` + lines.map(l => `<li>${esc(l.replace(/^([-*•]|\d+[.)])\s+/, ""))}</li>`).join("") + `</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (lines.length === 1 && lines[0].length <= 90 && !/[.!?:;,。！？]$/.test(lines[0]) && out.length) {
      out.push(`<h2>${esc(lines[0])}</h2>`); continue;
    }
    out.push(`<p>${lines.map(esc).join("<br>")}</p>`);
  }
  return out.join("\n");
}

const plain = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const CATEGORY = {
  "Immigration Law": "Immigration", "Immigration": "Immigration", "Personal Injury": "Personal Injury",
  "Business Law": "Business Law", "Estate Planning": "Estate Planning", "Trademarks": "Trademarks",
  // The site has no Real Estate or Landlord–Tenant category, and the writer
  // is only ever allowed the five above. File these where it files them.
  "Real Estate": "Business Law", "Landlord Tenant": "Business Law", "General": "Business Law",
};

/**
 * JJ's own words as a post object in the shape generatePost returns. The body
 * is his text with paragraph tags round it — not rewritten, not "improved".
 * The only additions are the standard author footer every post carries and a
 * meta description cut from his own first sentences.
 *
 * @param {object} o
 * @param {string} [o.title]   if empty, the first line of the text is the title
 * @param {string} [o.text]    pasted text
 * @param {string} [o.html]    clean HTML from a .docx (used in preference to text)
 * @param {string} [o.practiceArea]
 * @param {function} [o.footer] (title, lang) => html, autoposter.getStaticFooter
 */
function postFromOwnText({ title = "", text = "", html = "", practiceArea = "General", footer = null } = {}) {
  let body = html ? sanitizeHtml(html) : textToHtml(text);
  let t = String(title || "").trim();
  if (!t) {
    // First heading or first line becomes the title, and leaves the body.
    const m = body.match(/^\s*<(h2|h3|p)>([\s\S]*?)<\/\1>/);
    if (m && plain(m[2]).length <= 140) { t = plain(m[2]); body = body.slice(m[0].length).trim(); }
  }
  if (!t) throw new Error("Give the article a title — type one in the Topic box, or put it on the first line of your text.");
  if (plain(body).length < 200) throw new Error("That is too short to publish as an article (under 200 characters).");

  const first = plain(body);
  let meta = first.slice(0, 158);
  if (first.length > 158) meta = meta.slice(0, meta.lastIndexOf(" ") > 100 ? meta.lastIndexOf(" ") : 155).replace(/[,;:\s]+$/, "") + "…";

  const category = CATEGORY[practiceArea] || "Business Law";
  return {
    title: t.slice(0, 160),
    metaDescription: meta,
    content: body + (typeof footer === "function" ? footer(t, "en") : ""),
    category,
    practiceArea: category,
    focusKeyword: "",
    tags: [],
    asWritten: true,
  };
}

// ── After the writer: did anything identifying get through? ────────────
//
// "Leave out names" is an instruction to a model, and an instruction is not a
// control. This is the control: plain pattern matching, no second opinion from
// the model that wrote the draft. It pulls the identifiers out of the SOURCE —
// A-numbers, case and receipt numbers, emails, phone numbers, and the parties
// named in the caption — and reports any that appear in the article. A draft
// with a hit is saved to WordPress as a draft instead of being published.
//
// It cannot catch everything (a name that appears only in the body of a
// decision, a nickname). It is a net under the instruction, not a substitute
// for JJ reading the preview.
const OFFICIAL = /\b(united|states|america|department|homeland|security|warden|secretary|attorney|general|director|commissioner|court|county|city|state|people|government|service|services|bureau|board|agency|office|field|facility|center|processing|immigration|customs|enforcement|citizenship|uscis|ice|dhs|eoir|bia|commission|administration|judge|clerk|honorable|respondents?|petitioners?|plaintiffs?|defendants?)\b/i;

function privacyFlags(sourceText, articleHtml) {
  const src = String(sourceText || "");
  const art = plain(articleHtml).toLowerCase();
  const squash = (v) => v.toLowerCase().replace(/[^a-z0-9@]+/g, "");
  const artSquashed = squash(art);
  const hits = new Map();
  const note = (kind, value) => { const v = value.trim(); if (v && !hits.has(v.toLowerCase())) hits.set(v.toLowerCase(), `${kind}: ${v}`); };

  const numbers = [
    ["A-number", /\bA[-# ]?\d{3}[- ]?\d{3}[- ]?\d{3}\b/g],
    ["A-number", /\b\d{3}-\d{3}-\d{3}\b/g],
    ["Case number", /\b\d{1,2}:\d{2}-[a-z]{2,4}-\d{3,6}(?:-[A-Z]{2,5})*\b/gi],
    ["Case number", /\b\d{2}[A-Z]{2,6}\d{4,}\b/g],
    ["Receipt number", /\b[A-Z]{3}\d{10}\b/g],
    ["Phone", /\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g],
    ["Email", /[\w.+-]+@[\w-]+\.[\w.]+/g],
  ];
  for (const [kind, re] of numbers) {
    for (const m of src.matchAll(re)) {
      const v = m[0];
      if (kind === "Phone" && /626[-. ]?678[-. ]?8677/.test(v)) continue;          // the firm's own line
      if (kind === "Email" && /@tezlawfirm\.com$/i.test(v)) continue;
      if (artSquashed.includes(squash(v))) note(kind, v);
    }
  }

  // Parties in the caption: "Wei Chen, Petitioner" and "Wei Chen v. …".
  // A name is 2–4 capitalised words; a middle initial may carry its dot, but a
  // full stop after a whole word ends the name (it ends the sentence).
  const W = "(?:[A-Z][A-Za-z'’-]+|[A-Z]\\.)";
  const NAME = "(" + W + "(?: " + W + "){1,3})";
  // An official sued in their official capacity is not a private person.
  const TITLE = /^\W{0,3}(?:in (?:his|her|their) official capacity|(?:acting )?(?:attorney general|secretary|director|warden|commissioner|field office director|administrator))/i;
  const captions = [
    new RegExp(NAME + ",? (?:Petitioner|Respondent|Plaintiff|Defendant|Applicant|Appellant|Appellee|Beneficiary|Claimant)s?\\b", "g"),
    new RegExp(NAME + " v\\.? ", "g"),
    new RegExp(" v\\.? " + NAME, "g"),
    new RegExp("(?:In re|Matter of) " + NAME, "g"),
  ];
  for (const re of captions) {
    for (const m of src.matchAll(re)) {
      const name = m[1].replace(/[.,]+$/, "");
      if (OFFICIAL.test(name)) continue;
      if (TITLE.test(src.slice(m.index + m[0].length, m.index + m[0].length + 60))) continue;
      if (art.includes(name.toLowerCase())) note("Name", name === name.toUpperCase() ? name.replace(/\b([A-Z])([A-Z'’-]+)\b/g, (x, a, b) => a + b.toLowerCase()) : name);
    }
  }
  return [...hits.values()];
}

module.exports = {
  extract, sourceContext, topicFor, postFromOwnText, textToHtml, sanitizeHtml, privacyFlags,
  MAX_BYTES, MAX_SOURCE_CHARS, ALLOWED,
};
