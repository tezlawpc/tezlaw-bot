/**
 * check-document-tables.js
 *
 * Two kinds of document are kept about a client, for two audiences:
 *
 *   client_documents   the firm's Documents tab on a client (client-documents.js).
 *                      Work product may be filed here. Staff only.
 *   client_uploads     what comes through the phone app: a client's own
 *                      uploads, hearing exhibits, documents saved to the client.
 *
 * They used to share the name client_documents with different columns, so
 * whichever feature created the table first broke the other. Worse, had the
 * shapes ever matched, a client's app would have listed the firm's files.
 * This pins the separation.
 */
const fs = require("fs");
const path = require("path");

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail !== undefined ? "  → " + JSON.stringify(detail).slice(0, 400) : "")); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
// Whole-line comments only. (Stripping /* … */ as well would eat real code:
// these files contain regular expressions and strings with those characters.)
const noComments = (s) => s.replace(/^\s*\/\/.*$/gm, "");

const api = noComments(read("app-api.js"));
const firm = noComments(read("client-documents.js"));
const record = noComments(read("client-record.js"));

console.log("\n── One table each ───────────────────────────────");
ok("the app creates client_uploads, and no longer a table called client_documents",
  /CREATE TABLE IF NOT EXISTS client_uploads/.test(api) && !/CREATE TABLE IF NOT EXISTS client_documents/.test(api));
ok("the firm's module creates client_documents and never touches client_uploads",
  /CREATE TABLE IF NOT EXISTS client_documents/.test(firm) && !/client_uploads/.test(firm));
ok("nothing in the app code writes to the firm's table", !/INSERT INTO client_documents/.test(api) && !/DELETE FROM client_documents/.test(api));

console.log("\n── What a client or a consultant can reach ──────");
// Every route a client's or consultant's token can call.
const handlers = [...api.matchAll(/app\.(get|post|patch|put|delete)\("(\/api\/(?:client|consultant)\/[^"]*)"[\s\S]*?\n  \}\);/g)];
ok("there are client and consultant routes to check", handlers.length > 25, handlers.length);
const leaky = handlers.filter(h => /client_documents/.test(h[0])).map(h => h[1] + " " + h[2]);
ok("none of them reads the firm's Documents tab", leaky.length === 0, leaky);
const download = (api.match(/app\.get\("\/api\/documents\/:id"[\s\S]*?\n  \}\);/) || [""])[0];
ok("the shared download route serves the app's table only", /FROM client_uploads WHERE id = \$1/.test(download) && !/client_documents/.test(download));
ok("…and still checks the document belongs to the client asking", /client_key !== doc\.client_key/.test(download) && /403/.test(download));
ok("the client's record for Zara reads the app's table, never the firm's", /FROM client_uploads/.test(record) && !/client_documents/.test(record));
const clientPrompt = noComments(read("zara-app-chat.js"));
const recent = (clientPrompt.match(/if \(name === "list_recent_client_documents"\)[\s\S]*?\n    \}/) || [""])[0];
ok("Zara's staff tool lists both, and says which is which", /FROM client_documents/.test(recent) && /FROM client_uploads/.test(recent) && /AS source/.test(recent));

console.log("\n── Databases that already have one or the other ─");
const carry = (api.match(/CREATE INDEX IF NOT EXISTS idx_client_uploads_key[\s\S]*?carry-over skipped/) || [""])[0];
ok("rows are copied out of a shared table only when it has the app's columns",
  /\["client_id", "note", "content", "uploaded_by"\]\.every\(c => cols\.has\(c\)\)/.test(carry));
ok("…once, and only into an empty table", /SELECT 1 FROM client_uploads LIMIT 1/.test(carry) && /if \(!already\.rows\.length\)/.test(carry));
ok("…keeping their ids, which hearing exhibits refer to", /INSERT INTO client_uploads \(id, client_key/.test(carry) && /setval\(pg_get_serial_sequence\('client_uploads', 'id'\)/.test(carry));
ok("…and a failure there cannot stop the server starting", /catch \(e\) \{ console\.warn\("\[client uploads\] carry-over skipped/.test(api));
ok("the firm's module adds its own columns to a table the app created first",
  ["client_name TEXT", "a_number TEXT", "description TEXT", "file_data BYTEA"].every(c => firm.includes(c)) && /ADD COLUMN IF NOT EXISTS \$\{col\}/.test(firm) && /ALTER COLUMN content DROP NOT NULL/.test(firm));
ok("the firm's tab lists, opens and deletes only rows that hold a firm file",
  (firm.match(/file_data IS NOT NULL/g) || []).length >= 5);
ok("the table set-up runs once per process, not on every page", /let _ready = null;/.test(firm) && /if \(!_ready\) _ready = createTable\(\)/.test(firm));
ok("merging two client profiles moves both kinds of document",
  /UPDATE client_documents SET client_key = \$2 WHERE client_key = \$1/.test(api) && /UPDATE client_uploads SET client_key = \$2 WHERE client_key = \$1/.test(api));

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
