// ============================================================
//  conflicts.js — a conflict check that looks at the other side
//  TEZ Law Firm (Tez Law P.C.)
//  ─────────────────────────────────────────────────────────
//  "need to add button for conflict of interest for cases now
//   that we are accepting many cases."
//
//  WHAT WAS THERE. db.runConflictCheck() ran on a new intake and
//  searched two tables: `clients` and `intakes`. It never saw
//
//    civil_cases.opposing_party        the other side of a lawsuit
//    civil_cases.opposing_counsel      and who represents them
//    federal_matters.opposing_party
//    pi_insurance.policy_holder        the adverse insured
//    pi_cases.client_name              our own PI clients
//    federal_matters.client_name       our own federal clients
//    civil_cases.client_key            our own civil clients
//
//  so the Conflict Checks page reported "cleared" on names it had
//  not searched. For a check a lawyer relies on, a false clear is
//  the dangerous direction: rule 1.7 and 1.9 turn on whether the
//  firm has ever been on the other side of this person.
//
//  WHAT THIS DOES. One sweep over every place a party's name is
//  recorded, our clients and their opponents alike, with each
//  source saying which side it puts the name on. A source that
//  cannot be read is REPORTED, never silently skipped: "I could
//  not look" and "there is nothing" must not read the same to
//  somebody deciding whether to take a case.
//
//  MATCHING. The old check split a name into parts and ran
//  ILIKE '%part%' on each, so "Chen" matched Chenoweth and any
//  common surname buried the real hit. This compares whole
//  tokens, and in both orders, because a great many of the
//  firm's clients are Chinese and "Zhang Dong Sheng" and
//  "Dong Sheng Zhang" are the same person. Han characters have
//  no spaces to tokenise, so those fall back to containment.
//
//  Three strengths, and they are kept apart rather than mixed:
//    exact   the same name after normalising
//    strong  every token of the shorter name is in the longer
//    weak    surname plus first initial only
//  A weak hit is worth a human look and is listed as such. It is
//  not evidence of a conflict and is never presented as one.
// ============================================================

const db = require("./db");

// ── Names ────────────────────────────────────────────────────

// Lowercase, strip accents, drop punctuation and the noise that
// gets typed into a name field, collapse the spaces.
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "esq", "md", "phd", "dds"]);
const CORPORATE = new Set([
  "inc", "llc", "llp", "lp", "ltd", "corp", "corporation", "company", "co",
  "pc", "plc", "pllc", "trust", "the", "and", "a", "of",
]);

function normalize(s) {
  return String(s == null ? "" : s)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")   // café -> cafe
    .toLowerCase()
    // Dotted abbreviations are one word: "P.C." -> "pc", "L.L.C." -> "llc",
    // so they can be recognised as corporate filler below. Two letters
    // minimum, so a lone initial like "W." is left to mean an initial.
    .replace(/\b(?:[a-z]\.){2,}/g, (m) => m.replace(/\./g, ""))
    .replace(/[.,'’"()\[\]]/g, " ")
    .replace(/\s*&\s*/g, " and ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const hasHan = (s) => /[㐀-䶿一-鿿豈-﫿]/.test(s);

// The tokens worth comparing: no suffixes, no corporate filler.
function tokensOf(name) {
  const n = normalize(name);
  if (!n) return [];
  if (hasHan(n)) return [n.replace(/\s/g, "")];        // one unit; see containment below
  // Single letters are kept: "W. Chen" is a near-miss worth a human look,
  // and dropping the initial made it look like no match at all.
  return n.split(" ").filter((t) => t && !SUFFIXES.has(t) && !CORPORATE.has(t));
}

/**
 * How alike two names are: "exact", "strong", "weak", or null.
 *
 * Order-insensitive on purpose. A Chinese name written surname-first
 * in one matter and surname-last in another is one person, and a
 * conflict check that misses that is the kind of miss that matters.
 */
// An initial stands for the name it starts: "w" matches "wei".
const tokenAlike = (x, y) =>
  x === y || (x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y));

function compareNames(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return null;
  if (na === nb) return "exact";

  const ta = tokensOf(a), tb = tokensOf(b);
  if (!ta.length || !tb.length) return null;

  // Han names: no spaces to split on, so containment either way, and
  // only for something long enough to mean anything.
  if (hasHan(na) || hasHan(nb)) {
    const [sa, sb] = [ta[0], tb[0]];
    if (sa === sb) return "exact";
    const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
    if (short.length >= 2 && long.includes(short)) return "strong";
    return null;
  }

  const sa = new Set(ta), sb = new Set(tb);
  if (sa.size === sb.size && [...sa].every((t) => sb.has(t))) return "exact";

  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const bigSet = new Set(big);

  // Every token of the shorter name is in the longer one, whole.
  // "Wei Chen" inside "Wei Ming Chen" — the same person, written out.
  if (small.length >= 2 && small.every((t) => t.length >= 2 && bigSet.has(t))) return "strong";

  // Worth a human look, not a finding:
  //  · the same tokens once an initial is allowed to stand for a name;
  //  · a lone surname or given name that appears in the longer name,
  //    which is how a party often gets typed into a case field.
  if (small.length >= 2 && small.every((t) => big.some((u) => tokenAlike(t, u)))) return "weak";
  if (small.length === 1 && small[0].length >= 2 && bigSet.has(small[0])) return "weak";

  // Deliberately NOT a match: the same surname with a different given
  // name. Chen, Zhang, Wang and Li would each flood the page, and
  // "Wendy Chen" is not "Wei Chen".
  return null;
}

const RANK = { exact: 3, strong: 2, weak: 1 };

// ── Where a party's name is written down ─────────────────────
//
// `side` is what the firm was to this person. It is the whole point:
// "client" twice over is a 1.7 question, "client" against "adverse"
// is a 1.9 question, and the page has to be able to say which.

const SOURCES = [
  {
    name: "clients",
    side: "client",
    sql: `SELECT name, case_type AS detail, NULL::text AS matter, first_seen AS at
            FROM clients WHERE name IS NOT NULL`,
  },
  {
    name: "intakes",
    side: "prospective client",
    sql: `SELECT name, case_type AS detail, NULL::text AS matter, created_at AS at
            FROM intakes WHERE name IS NOT NULL
           ORDER BY created_at DESC LIMIT 4000`,
  },
  {
    name: "civil cases (our client)",
    side: "client",
    sql: `SELECT case_name AS name, case_type AS detail,
                 'Civil #' || id::text AS matter, created_at AS at
            FROM civil_cases WHERE case_name IS NOT NULL`,
  },
  {
    name: "civil cases (the other side)",
    side: "adverse",
    sql: `SELECT opposing_party AS name, case_type AS detail,
                 'Civil #' || id::text AS matter, created_at AS at
            FROM civil_cases WHERE opposing_party IS NOT NULL AND opposing_party <> ''`,
  },
  {
    name: "opposing counsel",
    side: "opposing counsel",
    // JSONB, and it has been written both as a list of objects and as
    // a list of plain strings. Take a name either way.
    sql: `SELECT COALESCE(e->>'name', e->>'firm', e#>>'{}') AS name,
                 NULL::text AS detail, 'Civil #' || c.id::text AS matter, c.created_at AS at
            FROM civil_cases c
            CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(c.opposing_counsel) = 'array'
                   THEN c.opposing_counsel ELSE '[]'::jsonb END) AS e
           WHERE c.opposing_counsel IS NOT NULL`,
  },
  {
    name: "PI cases (our client)",
    side: "client",
    sql: `SELECT client_name AS name, incident_type AS detail,
                 'PI #' || id::text AS matter, created_at AS at
            FROM pi_cases WHERE client_name IS NOT NULL`,
  },
  {
    name: "PI adverse insured and carriers",
    side: "adverse",
    sql: `SELECT COALESCE(NULLIF(policy_holder, ''), carrier_name) AS name,
                 role AS detail, 'PI #' || case_id::text AS matter, created_at AS at
            FROM pi_insurance
           WHERE role = 'adverse'
             AND COALESCE(NULLIF(policy_holder, ''), carrier_name) IS NOT NULL`,
  },
  {
    name: "federal matters (our client)",
    side: "client",
    sql: `SELECT client_name AS name, NULL::text AS detail,
                 'Federal #' || id::text AS matter, created_at AS at
            FROM federal_matters WHERE client_name IS NOT NULL`,
  },
  {
    name: "federal matters (the other side)",
    side: "adverse",
    sql: `SELECT opposing_party AS name, NULL::text AS detail,
                 'Federal #' || id::text AS matter, created_at AS at
            FROM federal_matters WHERE opposing_party IS NOT NULL AND opposing_party <> ''`,
  },
];

/**
 * Every party name the firm has recorded.
 *
 * A source that throws costs that source, not the answer — but the
 * caller is told which, and the page says so. A conflict check that
 * quietly searched six of nine places is worse than one that admits it.
 */
async function allParties() {
  const parties = [];
  const unavailable = [];

  for (const src of SOURCES) {
    try {
      const r = await db.query(src.sql);
      for (const row of r.rows) {
        if (!row.name || !String(row.name).trim()) continue;
        parties.push({
          name: String(row.name).trim(),
          side: src.side,
          source: src.name,
          detail: row.detail || null,
          matter: row.matter || null,
          at: row.at || null,
        });
      }
    } catch (e) {
      // 42P01 is "table does not exist": a practice area the firm has
      // not switched on holds no parties, which is an empty list, not
      // a failure. Anything else, the caller must hear about.
      if (e && e.code === "42P01") continue;
      unavailable.push(src.name);
      console.warn(`[conflicts] ${src.name}: ${e.message}`);
    }
  }
  return { parties, unavailable };
}

/**
 * Run a check on one or more names.
 *
 * `exclude` drops the matter being checked from its own results, so
 * running a check on a case does not report the case against itself.
 */
async function runCheck({ names, exclude = [] } = {}) {
  const wanted = (Array.isArray(names) ? names : [names])
    .map((n) => String(n == null ? "" : n).trim()).filter(Boolean);
  if (!wanted.length) throw new Error("a conflict check needs a name to check");

  const { parties, unavailable } = await allParties();
  const skip = new Set(exclude.filter(Boolean));

  const hits = [];
  for (const party of parties) {
    if (party.matter && skip.has(party.matter)) continue;
    for (const name of wanted) {
      const strength = compareNames(name, party.name);
      if (!strength) continue;
      hits.push({ ...party, searched: name, strength });
      break;
    }
  }

  // Strongest first, and adverse before client: being on the other
  // side of this person is the finding that stops a case.
  const sideWeight = (s) => (s === "adverse" ? 2 : s === "opposing counsel" ? 1 : 0);
  hits.sort((a, b) =>
    RANK[b.strength] - RANK[a.strength] ||
    sideWeight(b.side) - sideWeight(a.side) ||
    String(a.name).localeCompare(String(b.name)));

  const real = hits.filter((h) => h.strength !== "weak");
  const adverse = real.filter((h) => h.side === "adverse" || h.side === "opposing counsel");

  return {
    searched: wanted,
    hits,
    // "cleared" is only honest when every source could be read.
    disposition: unavailable.length ? "incomplete" : adverse.length ? "conflict" : real.length ? "possible" : "cleared",
    counts: {
      total: hits.length,
      adverse: adverse.length,
      weak: hits.filter((h) => h.strength === "weak").length,
    },
    sources_searched: SOURCES.length - unavailable.length,
    sources_total: SOURCES.length,
    unavailable,
    parties_compared: parties.length,
  };
}

// ── The record ───────────────────────────────────────────────
//
//  A conflict check is a compliance artifact, not a lookup. Rule 1.7
//  and 1.9 questions get asked years later, by a client, a successor
//  firm, or the State Bar, and the answer has to be "here is the check
//  we ran, on this date, by this person, against these sources, and
//  here is what it found" -- including when it found nothing.
//
//  conflict_checks already existed for the automatic intake check. It
//  is keyed to an intake, so these columns let a check belong to a
//  case instead, and record who ran it and what could not be read.

async function initTable() {
  // The table itself is created in db.js (initTables). These are the
  // columns an on-demand, case-level check needs on top of that.
  for (const col of [
    "case_kind TEXT",                 // civil | pi | federal | client | manual
    "case_ref TEXT",                  // 'Civil #12', so a hit can point back
    "run_by TEXT",                    // the person who pressed the button
    "searched_names JSONB",           // every name the check covered
    "sources_unavailable JSONB",      // what could not be read, if anything
    "note TEXT",                      // why it was run, or what was decided
  ]) {
    try {
      await db.query(`ALTER TABLE conflict_checks ADD COLUMN IF NOT EXISTS ${col}`);
    } catch (e) {
      console.warn(`[conflicts] migrate ${col.split(" ")[0]}: ${e.message}`);
    }
  }
}

/**
 * Run a check and keep the result.
 *
 * The row is written whatever the outcome. A check that found nothing
 * is the one most worth having on file.
 */
async function checkAndRecord({ names, caseKind = "manual", caseRef = null, exclude = [], runBy = null, note = null } = {}) {
  await initTable();
  const result = await runCheck({ names, exclude });

  let id = null;
  try {
    const r = await db.query(
      `INSERT INTO conflict_checks
         (search_name, matches, disposition, case_kind, case_ref, run_by,
          searched_names, sources_unavailable, note)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
       RETURNING id, checked_at`,
      [
        result.searched.join("; ").slice(0, 200),
        JSON.stringify(result.hits),
        result.disposition,
        caseKind, caseRef, runBy,
        JSON.stringify(result.searched),
        JSON.stringify(result.unavailable),
        note,
      ]
    );
    id = r.rows[0].id;
    return { ...result, id, checked_at: r.rows[0].checked_at };
  } catch (e) {
    // The check ran; only the filing failed. Say so rather than
    // returning a result that looks recorded and is not.
    console.error("[conflicts] could not record the check:", e.message);
    return { ...result, id: null, not_recorded: e.message };
  }
}

/** Checks already run against a case, newest first. */
async function checksFor(caseRef, limit = 10) {
  await initTable();
  try {
    const r = await db.query(
      `SELECT id, search_name, disposition, checked_at, run_by, note,
              jsonb_array_length(COALESCE(matches, '[]'::jsonb)) AS hit_count,
              COALESCE(sources_unavailable, '[]'::jsonb) AS sources_unavailable
         FROM conflict_checks
        WHERE case_ref = $1
        ORDER BY checked_at DESC LIMIT $2`,
      [caseRef, limit]
    );
    return r.rows;
  } catch (e) {
    console.warn("[conflicts] checksFor:", e.message);
    return [];
  }
}

/** One recorded check, in full, for the page that shows what was found. */
async function getCheck(id) {
  await initTable();
  const r = await db.query(
    `SELECT * FROM conflict_checks WHERE id = $1`, [parseInt(id, 10) || 0]);
  return r.rows[0] || null;
}

module.exports = {
  normalize, tokensOf, compareNames, allParties, runCheck,
  initTable, checkAndRecord, checksFor, getCheck,
  SOURCES, RANK,
};
