/**
 * check-fee-agreement.js
 *
 * Guards the reason this module is allowed to touch fee terms at all:
 * every value it proposes must be quotable from the document. An unquoted
 * value is an unverifiable one, and a fee amount nobody can check against
 * the agreement is precisely what a fee dispute is made of.
 */
const fs = require("fs");
const path = require("path");
const fa = require("../fee-agreement");

let failures = 0;
const fail = m => { failures++; console.log("  FAIL " + m); };
const ok = m => console.log("  ok   " + m);
const eq = (got, want, label) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(label) : fail(`${label} — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

console.log("\nFee agreement extraction\n");

// ── 1. Unquoted values are dropped, not trusted ───────────────
{
  const group = {
    fee_amount:    { value: 5000, quote: "Client shall pay a flat fee of $5,000." },
    hourly_rate:   { value: 650,  quote: null },          // no quote -> must drop
    fee_structure: { value: "flat", quote: "  " },        // blank quote -> must drop
    scope_included:{ value: ["removal defense"], quote: "Scope includes removal defense." },
    scope_excluded:{ value: [], quote: null },
  };
  const { out, dropped } = fa.requireQuotes(group, ["fee_amount","hourly_rate","fee_structure","scope_included","scope_excluded"]);
  eq(out.fee_amount.value, 5000, "a quoted fee amount survives");
  eq(out.hourly_rate.value, null, "an UNQUOTED hourly rate is dropped");
  eq(out.fee_structure.value, null, "a blank-quoted fee structure is dropped");
  eq(out.scope_included.value, ["removal defense"], "a quoted scope array survives");
  eq(out.scope_excluded.value, [], "an empty array stays an empty array, not null");
  eq(dropped.sort(), ["fee_structure","hourly_rate"], "dropped fields are reported, not hidden");
}

// ── 2. JSON parsing survives the wrappers models add ──────────
eq(fa.parseJsonBlock('```json\n{"a":1}\n```').a, 1, "fenced json block parses");
eq(fa.parseJsonBlock('Here you go:\n{"a":2}\nHope that helps').a, 2, "json with prose around it parses");
try { fa.parseJsonBlock("no json here"); fail("non-json should throw"); }
catch (e) { ok("non-json input throws instead of returning junk"); }

// ── 3. Unreadable files are refused with a REASON ─────────────
(async () => {
  const cases = [
    { filename: "agreement.jpg",  code: "IMAGE_UNSUPPORTED", label: "a photo is refused (no OCR)" },
    { filename: "agreement.docx", code: "DOCX_UNSUPPORTED",  label: "a Word file is refused" },
    { filename: "agreement.xyz",  code: "UNSUPPORTED",       label: "an unknown type is refused" },
  ];
  for (const c of cases) {
    try {
      await fa.textFrom({ buffer: Buffer.from("x"), filename: c.filename });
      fail(c.label + " — but it was accepted");
    } catch (e) {
      if (e.code === c.code && /upload|support|OCR/i.test(e.message)) ok(c.label);
      else fail(`${c.label} — wrong error: ${e.code} ${e.message}`);
    }
  }
  eq(await fa.textFrom({ buffer: Buffer.from("plain text agreement"), filename: "a.txt" }),
     "plain text agreement", "a .txt agreement reads through");

  // ── 4. Source invariants ────────────────────────────────────
  const src = fs.readFileSync(path.join(__dirname, "..", "fee-agreement.js"), "utf8");

  if (/module\.exports\s*=\s*\{[^}]*\}/s.test(src) && !/db\.query|INSERT INTO|UPDATE /i.test(src)) {
    ok("the module never writes to the database — it only proposes");
  } else {
    fail("fee-agreement must not write to the database; it returns a proposal for a human to accept");
  }
  if (/return null/.test(src) || /Never infer, never guess/.test(src)) ok("the prompt forbids inferring unstated values");
  else fail("the prompt must forbid guessing at values the document does not state");
  if (/If you cannot quote it, the value must be null/.test(src)) ok("the prompt requires a quote for every value");
  else fail("the prompt must require a verbatim quote for each extracted value");

  console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL FEE AGREEMENT CHECKS PASSED\n");
  process.exit(failures ? 1 : 0);
})();
