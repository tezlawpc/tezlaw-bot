// ============================================================
//  scope-writer.js — Zara elaborates the scope of work
//  ─────────────────────────────────────────────────────────
//  "for scope of work, even when just writing short sentences,
//   use zara to elaborate on the description." (JJ, 2026-10-08)
//
//  WHAT THIS IS ALLOWED TO DO, AND WHAT IT IS NOT
//
//  The scope is not description. It is the operative promise: § 6148(a)(2)
//  requires the general nature of the services to be stated, and the
//  clause right after it says "Anything not listed above is outside this
//  Agreement." So every line here is a thing the firm has contracted to
//  do, and a line that quietly appears is work the firm owes for free.
//
//  A model asked to "elaborate" will add. Ask it to expand "File the
//  I-130" and it will cheerfully offer "and respond to any Request for
//  Evidence" — which is a second filing, often a second fee, and now a
//  contractual obligation nobody agreed to.
//
//  So this never writes the scope. It PROPOSES, into the drafting form,
//  where a lawyer reads it and edits it before anything is saved. The
//  same rule the case-file reader runs under: the machine fills in the
//  box, the person approves it.
//
//  Three guards, enforced here rather than asked for in the prompt:
//    1. one line in, one line out, in the same order
//    2. a line that gained a new deliverable is dropped and the
//       drafter's own line kept
//    3. nothing comes back that promises an outcome
// ============================================================

const SYSTEM = `You expand scope-of-work lines for a California law firm's fee agreement.

Each line is one service the firm is promising to perform. Rewrite it so a
client who is not a lawyer understands exactly what the firm will do, in one
sentence of plain English.

RULES, all of them absolute:
- Return exactly as many lines as you are given, in the same order, one per line.
- Do NOT add any service, step, filing, appeal, response or appearance that
  is not already in the line you were given. Expanding "prepare the petition"
  into "prepare the petition and respond to any Request for Evidence" adds a
  filing the firm has not agreed to do. Say more ABOUT the same work; never
  add work.
- Do not promise, predict or imply any result. No "successfully", no
  "ensuring approval", no "so that you obtain".
- Do not state a time, a deadline or a number of hours.
- Keep every form number, court, agency and party name exactly as written.
- Plain words. No "pursuant to", no "shall", no Latin.
- One sentence per line, about 25 to 40 words. No bullet characters, no
  numbering, no blank lines.`;

// Work a line must not acquire. Each of these is a separate engagement in
// this practice, and several carry their own fee.
const ADDED_WORK = [
  /\brequests? for evidence\b/i, /\bRFE\b/, /\bNOID\b/, /\bnotice of intent\b/i,
  /\bappeal/i, /\bmotion to reopen\b/i, /\bmotion to reconsider\b/i,
  /\bfederal (court|litigation)\b/i, /\bmandamus\b/i, /\bhabeas\b/i,
  /\bwrit\b/i, /\binterview\b/i, /\bhearing\b/i, /\btrial\b/i, /\bdeposition/i,
  /\bconsular process/i, /\badjustment of status\b/i, /\bwaiver\b/i,
  /\bbond\b/i, /\bapplication for employment authorization\b/i, /\bEAD\b/,
];

// Anything that reads as a promise about the result.
const PROMISES = [
  /\bguarant/i, /\bensur/i, /\bsuccessful/i, /\bwill be (approved|granted|won)\b/i,
  /\bso that you (will )?(obtain|receive|get)\b/i, /\bresult(ing)? in\b/i,
  /\bwe will win\b/i, /\bassure/i,
];

const clean = (t) => String(t == null ? "" : t).replace(/\s+/g, " ").trim();

/** Words in `b` that are not in `a`, lowercased, ignoring short ones. */
function gainedWork(original, rewritten) {
  for (const re of ADDED_WORK) {
    if (re.test(rewritten) && !re.test(original)) return re.source;
  }
  return null;
}

function promises(text) {
  for (const re of PROMISES) if (re.test(text)) return re.source;
  return null;
}

/**
 * Expand each scope line.
 *
 * Returns { lines, notes } where `lines` is the same length as the input
 * and every entry is either the expansion or, where a guard tripped, the
 * drafter's own line untouched. `notes` says what was rejected and why, so
 * the screen can show it rather than swallowing it.
 *
 * Never throws: if Zara is unreachable, the drafter's lines come back as
 * they went in. A fee agreement must not depend on a model being up.
 */
async function elaborate(lines, { matterLabel = "", matterType = "", think = null } = {}) {
  const input = (Array.isArray(lines) ? lines : String(lines || "").split("\n"))
    .map(clean).filter(Boolean);
  if (!input.length) return { lines: [], notes: ["Nothing to expand."] };

  const ask = think || ((o) => require("./zara-core").think(o));
  const notes = [];
  let out = [];

  try {
    const res = await ask({
      surface: "staff",
      tier: "balanced",
      system: SYSTEM,
      message: [
        matterLabel ? `Matter: ${matterLabel}` : "",
        matterType ? `Practice area: ${matterType.replace(/_/g, " ")}` : "",
        "",
        "Lines to expand:",
        ...input.map((l, i) => `${i + 1}. ${l}`),
      ].filter(Boolean).join("\n"),
      maxTokens: 1200,
      timeout: 60000,
    });
    out = String((res && res.text) || "")
      .split("\n")
      .map((l) => clean(l).replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ""))
      .filter(Boolean);
  } catch (err) {
    return { lines: input, notes: [`Zara could not be reached (${err.message}). The lines are unchanged.`] };
  }

  if (out.length !== input.length) {
    return {
      lines: input,
      notes: [`Zara returned ${out.length} lines for ${input.length}, so none were used. ` +
              `The scope is the firm's promise; a line that does not line up is not worth guessing at.`],
    };
  }

  const kept = input.map((original, i) => {
    const rewritten = out[i];
    const added = gainedWork(original, rewritten);
    if (added) {
      notes.push(`Line ${i + 1} was left as you wrote it: the expansion added work the line did not contain (${added}).`);
      return original;
    }
    const promise = promises(rewritten);
    if (promise) {
      notes.push(`Line ${i + 1} was left as you wrote it: the expansion promised a result (${promise}).`);
      return original;
    }
    if (rewritten.length < original.length) {
      notes.push(`Line ${i + 1} was left as you wrote it: the expansion was shorter than the original.`);
      return original;
    }
    return rewritten;
  });

  if (!notes.length) notes.push("Every line was expanded. Read them before saving: this is what the firm is promising to do.");
  return { lines: kept, notes };
}

module.exports = { elaborate, SYSTEM, ADDED_WORK, PROMISES, gainedWork, promises };
