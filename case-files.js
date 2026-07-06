// ============================================================
//  TEZ LAW P.C. — CASE FILES v1
//  ─────────────────────────────────────────────────────────
//  Persistent per-case memory for the Phase 4 drafting pipeline.
//
//  A "case file" is a named collection of:
//    - Free-form attorney notes (accumulated across sessions)
//    - Extracted text from uploaded documents (IJ decisions,
//      country conditions reports, expert declarations, etc.)
//    - Case metadata (client name, A#, case type)
//
//  Case files are JJ-only, single-user. Deletion is explicit
//  and requires confirmation.
//
//  Usage:
//    /case new <name> [+ attach PDF/DOCX] [+ notes on next lines]
//    /case add <name>  [+ attach PDF/DOCX] [+ notes on next lines]
//    /case notes <name>\n<multi-line notes>
//    /case list
//    /case show <name>
//    /case delete <name>       (asks for confirmation)
//    /case delete <name> yes   (actually deletes)
//
//    /draft <template> <case-name>   → uses case file as fact context
// ============================================================

const db = require("./db");

// ── Schema ───────────────────────────────────────────────

async function initCaseFilesTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS case_files (
        id          SERIAL PRIMARY KEY,
        name        TEXT UNIQUE NOT NULL,
        notes       TEXT DEFAULT '',
        documents   JSONB DEFAULT '[]'::jsonb,
        metadata    JSONB DEFAULT '{}'::jsonb,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) { if (e.code !== "23505") throw e; }

  try {
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_case_files_name
        ON case_files (name)
    `);
  } catch (e) { if (e.code !== "23505") throw e; }

  try {
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_case_files_updated
        ON case_files (updated_at DESC)
    `);
  } catch (e) { if (e.code !== "23505") throw e; }
}

// ── CRUD ─────────────────────────────────────────────────

/**
 * Create a new case file. Fails if name already exists — use addToCase for updates.
 */
async function createCase(name, { initialNotes = "", initialDoc = null, metadata = {} } = {}) {
  await initCaseFilesTable();
  const documents = initialDoc ? [initialDoc] : [];
  const r = await db.query(
    `INSERT INTO case_files (name, notes, documents, metadata)
     VALUES ($1, $2, $3::jsonb, $4::jsonb)
     RETURNING id, name, created_at`,
    [name, initialNotes, JSON.stringify(documents), JSON.stringify(metadata)]
  );
  return { ok: true, id: r.rows[0].id, name: r.rows[0].name, created_at: r.rows[0].created_at };
}

/**
 * Get a case file by name. Returns null if not found.
 */
async function getCase(name) {
  await initCaseFilesTable();
  const r = await db.query(
    `SELECT id, name, notes, documents, metadata, created_at, updated_at
     FROM case_files WHERE name = $1`,
    [name]
  );
  return r.rows[0] || null;
}

/**
 * Append notes to a case file (preserves existing notes).
 */
async function appendNotes(name, additionalNotes) {
  const existing = await getCase(name);
  if (!existing) return { ok: false, error: `Case '${name}' not found` };

  const separator = existing.notes ? "\n\n" : "";
  const timestamp = new Date().toISOString().substring(0, 10);
  const newNotes = existing.notes + separator + `[${timestamp}]\n` + additionalNotes;

  await db.query(
    `UPDATE case_files SET notes = $1, updated_at = NOW() WHERE name = $2`,
    [newNotes, name]
  );
  return { ok: true };
}

/**
 * Add a document to a case file. Document is {filename, mime, text, added_at}.
 */
async function addDocument(name, doc) {
  const existing = await getCase(name);
  if (!existing) return { ok: false, error: `Case '${name}' not found` };

  const documents = existing.documents || [];
  documents.push({
    ...doc,
    added_at: doc.added_at || new Date().toISOString(),
  });

  await db.query(
    `UPDATE case_files SET documents = $1::jsonb, updated_at = NOW() WHERE name = $2`,
    [JSON.stringify(documents), name]
  );
  return { ok: true, doc_count: documents.length };
}

/**
 * Update case metadata (client name, A#, case type, etc.).
 * Merges into existing metadata rather than replacing.
 */
async function updateMetadata(name, updates) {
  const existing = await getCase(name);
  if (!existing) return { ok: false, error: `Case '${name}' not found` };

  const metadata = { ...(existing.metadata || {}), ...updates };
  await db.query(
    `UPDATE case_files SET metadata = $1::jsonb, updated_at = NOW() WHERE name = $2`,
    [JSON.stringify(metadata), name]
  );
  return { ok: true };
}

/**
 * List all case files (metadata only — not the full documents).
 */
async function listCases() {
  await initCaseFilesTable();
  const r = await db.query(
    `SELECT id, name, LENGTH(notes) AS notes_len,
       jsonb_array_length(COALESCE(documents, '[]'::jsonb)) AS doc_count,
       metadata,
       created_at, updated_at
     FROM case_files
     ORDER BY updated_at DESC`
  );
  return r.rows;
}

/**
 * Delete a case file.
 */
async function deleteCase(name) {
  const r = await db.query(
    `DELETE FROM case_files WHERE name = $1 RETURNING id`,
    [name]
  );
  return { ok: r.rowCount > 0 };
}

// ── Build Fact Text From Case File ────────────────────────

/**
 * Given a case file, build the fact_doc_text string that will be fed
 * into the drafting pipeline. Combines notes + all documents in a
 * clearly-labeled format so the drafting prompt can distinguish them.
 */
function buildFactDocText(caseFile) {
  if (!caseFile) return null;

  const parts = [];

  if (caseFile.notes && caseFile.notes.trim()) {
    parts.push(`=== ATTORNEY NOTES ON CASE ===\n${caseFile.notes.trim()}`);
  }

  const docs = caseFile.documents || [];
  if (docs.length) {
    for (const doc of docs) {
      if (!doc.text) continue;
      const header = `=== ATTACHED DOCUMENT: ${doc.filename || 'unnamed'} ===`;
      parts.push(`${header}\n${doc.text}`);
    }
  }

  return parts.length ? parts.join("\n\n") : null;
}

// ── Human-Readable Summary ────────────────────────────────

/**
 * Build a human-readable summary of a case file for /case show output.
 */
function summarizeCase(caseFile) {
  if (!caseFile) return "(case not found)";

  const docs = caseFile.documents || [];
  const meta = caseFile.metadata || {};
  const notesPreview = (caseFile.notes || "").substring(0, 500);

  const lines = [
    `📁 *${caseFile.name}*`,
    `Created: ${new Date(caseFile.created_at).toLocaleDateString()}`,
    `Last updated: ${new Date(caseFile.updated_at).toLocaleDateString()}`,
  ];

  // Metadata
  if (Object.keys(meta).length) {
    lines.push("");
    lines.push("*Metadata:*");
    for (const [k, v] of Object.entries(meta)) {
      lines.push(`  • ${k}: ${v}`);
    }
  }

  // Documents
  lines.push("");
  lines.push(`*Documents (${docs.length}):*`);
  if (docs.length === 0) {
    lines.push("  (none)");
  } else {
    for (const doc of docs) {
      const size = doc.text ? `${doc.text.length.toLocaleString()} chars` : "no text";
      const added = doc.added_at ? new Date(doc.added_at).toLocaleDateString() : "unknown";
      lines.push(`  • ${doc.filename || 'unnamed'}  (${size}, added ${added})`);
    }
  }

  // Notes
  lines.push("");
  const notesLen = (caseFile.notes || "").length;
  lines.push(`*Notes (${notesLen.toLocaleString()} chars):*`);
  if (notesLen === 0) {
    lines.push("  (none)");
  } else {
    lines.push(notesPreview);
    if (notesLen > 500) lines.push("...(truncated for display)");
  }

  return lines.join("\n");
}

// ── Exports ───────────────────────────────────────────────

module.exports = {
  initCaseFilesTable,
  createCase,
  getCase,
  appendNotes,
  addDocument,
  updateMetadata,
  listCases,
  deleteCase,
  buildFactDocText,
  summarizeCase,
};

// ── CLI Mode ─────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.includes("--init")) {
      await initCaseFilesTable();
      console.log("case_files table initialized");
      process.exit(0);
    }
    if (args.includes("--list")) {
      const cases = await listCases();
      console.log(`\n${cases.length} case file(s):\n`);
      for (const c of cases) {
        console.log(`  #${c.id} | ${c.name} | ${c.doc_count} docs | ${c.notes_len} note chars | updated ${new Date(c.updated_at).toLocaleDateString()}`);
      }
      process.exit(0);
    }
    console.log(`Usage:
  node case-files.js --init      Initialize table
  node case-files.js --list      List case files
`);
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}
