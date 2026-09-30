/**
 * check-i589-vision.js
 *
 * JJ, after the first real sweep: "it scanned, but only 1 was readable and
 * rest was not readable... how is that possible? just look at 589 applicatoin
 * scanned pdf and look at question 8 on the application."
 *
 * He was right about the cause. The firm's I-589s are scans — images of pages.
 * A scan has no form fields and no text layer, so both of the cheap readers
 * come back with nothing. i589-vision.js reads the page by looking at it.
 *
 * That makes the model the parser, which moves the burden of proof into the
 * prompt and into shape(). So this file tests four things, and they are the
 * four ways this could hurt a client:
 *
 *   1. Item 9 must stay out. On a represented case item 9 is usually THIS
 *      FIRM'S office. Harvesting it would put Tez Law's address on every
 *      asylum client's record and their hearing notices would come here
 *      instead of to them.
 *   2. "I could not read it" must survive. If the model says the scan is
 *      illegible, that must not become an address anyway.
 *   3. Only page 1 is sent. The rest of an I-589 is somebody's account of
 *      why they fear return; there is no reason to ship it anywhere to read
 *      an address.
 *   4. The review screen must SAY a row was read this way, so JJ can weigh it
 *      differently from a value lifted straight out of a form field.
 *
 * Nothing here calls the API. readItem8 takes an injectable `ask`, so the
 * model's answer is supplied by the test.
 */
const v = require("../i589-vision");
const page = require("../i589-page");

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

// ── 1. The prompt itself ───────────────────────────────────────────────
console.log("\nthe instruction given to the model");
{
  const P = v.PROMPT;
  ok("names item 8 as the thing to read", /Item Number 8/.test(P));
  ok("forbids item 9 outright", /DO NOT read Item Number 9/.test(P));
  ok("says WHY item 9 is off limits, so it is not silently relaxed later",
    /law firm's own address/i.test(P));
  ok("a blank item 8 stays blank even when item 9 is filled in",
    /If Item 8 is blank but Item 9 is filled in, Item 8 is still blank/i.test(P));
  ok("asks for a legibility verdict, not a best effort", /"legible"/.test(P));
  ok("forbids guessing an unclear character", /Do not guess/.test(P));
  ok("explains the stake, which is the missed hearing notice",
    /missed hearing notice/i.test(P));
}

// ── 2. Refusal survives ────────────────────────────────────────────────
console.log("\nwhen the scan cannot be read");
{
  const out = v.shape({
    street: "1425 Cameron Ave", city: "West Covina", state: "CA", zip: "91790",
    phone: "(626) 555-0142", legible: false, note: "the ZIP could be 91790 or 91730",
  });
  ok("a not-legible answer is NOT accepted", out.ok === false);
  ok("...and no address comes out of it", out.address === "");
  ok("...and no phone comes out of it either", !out.phone);
  ok("what it thought it saw is kept as partial, for a human to look at",
    /Cameron/.test(out.partial || ""));
  ok("the reason is stated first", /could not be read reliably/.test((out.notes || [])[0] || ""));
  ok("the model's own note is kept", (out.notes || []).some(n => /91730/.test(n)));
}

// ── 3. A good read, and the completeness bar ───────────────────────────
console.log("\nwhen item 8 is readable");
{
  const good = v.shape({
    street: "1425 Cameron Avenue", apt: "3B", city: "West Covina",
    state: "ca", zip: "91790", phone: "6265550142", legible: true, note: null,
  });
  ok("it is accepted", good.ok === true);
  ok("the address is assembled", /1425 Cameron Avenue/.test(good.address));
  ok("the apartment is not dropped", /3B/.test(good.address));
  ok("the state is normalised to two upper-case letters", /\bCA\b/.test(good.address));
  ok("the phone is formatted the same as everywhere else", /626/.test(good.phone));
  ok("it is labelled as a vision read, not passed off as a field read",
    good.method === "vision");

  const partial = v.shape({
    street: "1425 Cameron Avenue", apt: null, city: null, state: null,
    zip: null, phone: null, legible: true, note: null,
  });
  ok("a street with no city or state is NOT an address", partial.ok === false);
  ok("...it is offered as partial instead", /Cameron/.test(partial.partial || ""));
  ok("...and says what was missing", (partial.notes || []).some(n => /city/i.test(n)));

  const blank = v.shape({
    street: null, apt: null, city: null, state: null, zip: null,
    phone: null, legible: true, note: null,
  });
  ok("a blank item 8 reads as blank, not as an error", blank.ok === false);
  ok("...and says so in words", (blank.notes || []).some(n => /blank/i.test(n)));

  const nulls = v.shape({
    street: "N/A", city: "none", state: "unknown", zip: "null",
    phone: "", legible: true, note: "",
  });
  ok("the words a model writes instead of null are treated as empty",
    nulls.ok === false && nulls.address === "");
}

// ── 4. Only page 1 leaves the building ─────────────────────────────────
console.log("\nwhat is sent");
{
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "i589-vision.js"), "utf8");
  ok("page 1 is taken before anything is sent", /firstPage\(buffer\)/.test(src));
  ok("firstPage copies exactly one page", /copyPages\(src, \[0\]\)/.test(src));

  const body = src.slice(src.indexOf("const call = ask ||"), src.indexOf("let got;"));
  ok("what is sent is the extracted page, not the original file",
    /data: pdf\.toString\("base64"\)/.test(body) && !/buffer\.toString\("base64"\)/.test(body));
  ok("the model's answer is forced into JSON with the assistant prefill",
    /role: "assistant", content: "\{"/.test(body));

  ok("a missing API key is an honest failure, not a silent empty read",
    /ANTHROPIC_API_KEY/.test(src) && /no ANTHROPIC_API_KEY set on the server/.test(src));
}

// ── 5. The sweep only pays for this when it has to ─────────────────────
console.log("\nhow the sweep uses it");
{
  const sweep = require("fs").readFileSync(require("path").join(__dirname, "..", "i589-sweep.js"), "utf8");
  const scan = sweep.slice(sweep.indexOf("async function scanOne"), sweep.indexOf("async function readPdf"));
  ok("vision is only reached after the cheap readers fail",
    /if \(!got\.ok\) \{[\s\S]*?require\("\.\/i589-vision"\)/.test(scan));
  ok("the vision read is awaited", /await require\("\.\/i589-vision"\)\.readItem8\(buf\)/.test(scan));
  ok("a successful vision read replaces the failed one", /if \(seen\.ok/.test(scan));
  ok("the method recorded is whatever actually answered", /out\.method = got\.method;/.test(scan));
  ok("the stored method column allows it", /method +TEXT,.*vision/.test(sweep));
}

// ── 6. The review screen says which rows were read this way ────────────
console.log("\nwhat the review screen shows");
{
  ok("there is a word for the vision method", !!page.METHOD.vision);
  ok("it says the page was looked at, not parsed", /look/i.test(page.METHOD.vision));

  const html = page.row({
    client_key: "wang-baohong", client_name: "Baohong Wang", status: "found",
    method: "vision", form_path: "/Clients/Wang/i589.pdf",
    found_phone: "(626) 555-0142", found_address: "1425 Cameron Avenue, Apt 3B, West Covina, CA 91790",
    current_phone: "", current_address: "", action: { conflicts: [] }, notes: [],
  });
  ok("a vision row says how it was read", /looking at the scanned page/.test(html));
  ok("...and still offers Apply, since it is a proposal either way",
    /Apply to profile/.test(html));

  const fieldRow = page.row({
    client_key: "x", client_name: "X", status: "found", method: "fields",
    found_address: "1 A St, B, CA 90000", current_address: "", action: {}, notes: [],
  });
  ok("a field row is still described as a field row", /own fields/.test(fieldRow));
  ok("...and is not mislabelled as a scan", !/looking at the scanned page/.test(fieldRow));
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL I-589 VISION CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
