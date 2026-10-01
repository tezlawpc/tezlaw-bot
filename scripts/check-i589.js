/**
 * check-i589.js
 *
 * JJ: "...in accordance of the most recent 589 application page 1 and
 * question 8. do not use info in question 9."
 *
 * Item 8 is where the person actually lives. Item 9 is the mailing address,
 * and on a represented case it is very often THIS FIRM'S OWN OFFICE. Pulling
 * item 9 would replace every asylum client's home address with Tez Law's, so
 * the central test below feeds the parser a form whose item 9 IS the firm and
 * proves it never comes out.
 *
 * The second theme is refusal. A wrong address on a client in removal
 * proceedings means a hearing notice that never arrives, which means an in
 * absentia order. So anything ambiguous must come back as "cannot tell"
 * rather than a best guess.
 */
const x = require("../i589-extract");

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

// A filled page 1, laid out the way pdf-parse returns it. Item 9 is the firm.
const PAGE1 = `
Part A.I. Information About You
1. Alien Registration Number(s) (A-Number) A 200-123-456
4. Complete Last Name  WANG
5. First Name  BAOHONG
8. Residence in the U.S. (where you physically reside)
Street Number and Name
1425 Cameron Avenue
Apt. Number  3B
City  West Covina
State  CA   Zip Code  91790
Telephone Number  (626) 555-0142
9. Mailing Address in the U.S. (if different than the address in Item Number 8)
In Care Of  TEZ LAW P.C.
Street Number and Name
1050 Lakes Drive Suite 225
City  West Covina
State  CA   Zip Code  91790
Telephone Number  (626) 888-9999
10. Gender
`;

console.log("\n── Item 9 must never be used ───────────────────");
{
  const r = x.extract({ text: PAGE1 });
  ok("it reads item 8", r.ok && /1425 Cameron/.test(r.address), JSON.stringify(r));
  ok("the phone is item 8's, not item 9's", r.phone === "626-555-0142", r.phone);
  ok("the firm's street never appears in the result", !/1050 Lakes/.test(r.address), r.address);
  ok("the firm's phone never appears", !/888.?9999/.test(r.phone + r.address));
  ok("\"In Care Of\" is not picked up", !/TEZ LAW|Care Of/i.test(r.address), r.address);
  ok("the apartment number is kept", /3B/.test(r.address), r.address);
  ok("the city is read", /West Covina/.test(r.address), r.address);
  ok("the state is read", /\bCA\b/.test(r.address), r.address);
  ok("the zip is read", /91790/.test(r.address), r.address);
  ok("the whole address comes out usable",
    r.address === "1425 Cameron Avenue, Apt 3B, West Covina, CA 91790", r.address);
}

console.log("\n── An incomplete address is not an address ─────");
{
  // The first version of the text parser returned "1425 Cameron Avenue, 91790"
  // — no apartment, no city, no state — and called it a success. That would
  // have gone into client records as a postal address a hearing notice could
  // never reach.
  const noCity = PAGE1.replace(/City\s+West Covina\n/, "");
  const r = x.extract({ text: noCity });
  ok("a street with no city does not become an address", !r.address, r.address);
  ok("…and the reason names the missing part",
    /city could not be read/.test(r.notes.join("; ")), r.notes.join("; "));
  ok("…while what WAS read is still shown, for a human to finish",
    /1425 Cameron/.test(r.partial || ""), r.partial);

  const noState = PAGE1.replace(/State\s+CA\s+/, "");
  const r2 = x.extract({ text: noState });
  ok("a missing state is caught too", !r2.address && /state could not be read/.test(r2.notes.join("; ")),
    r2.notes.join("; "));

  const phoneOnly = x.extract({ text: PAGE1.replace(/Street Number and Name\n1425 Cameron Avenue\n/, "") });
  ok("a page with only a phone still yields the phone",
    phoneOnly.phone === "626-555-0142" && !phoneOnly.address, JSON.stringify(phoneOnly));
}

console.log("\n── Ambiguity is refused, not guessed ───────────");
{
  const noNine = PAGE1.slice(0, PAGE1.indexOf("9. Mailing Address"));
  const r = x.extract({ text: noNine });
  ok("without the item 9 heading the end of item 8 is unknown, so it refuses",
    !r.ok && /item 9 heading not found/.test(r.notes.join(" ")), JSON.stringify(r.notes));
  const noEight = x.extract({ text: "10. Gender\nM\n" });
  ok("without item 8 it refuses too",
    !noEight.ok && /item 8 heading not found/.test(noEight.notes.join(" ")));
  ok("a refusal returns no address and no phone at all",
    !noEight.address && !noEight.phone);
}

console.log("\n── Form fields win, and item 9 fields are ignored ──");
{
  const fields = [
    { name: "Pt1Line8_StreetNumberName[0]", value: "1425 Cameron Avenue" },
    { name: "Pt1Line8_AptSteFlrNumber[0]", value: "3B" },
    { name: "Pt1Line8_CityOrTown[0]", value: "West Covina" },
    { name: "Pt1Line8_State[0]", value: "CA" },
    { name: "Pt1Line8_ZipCode[0]", value: "91790" },
    { name: "Pt1Line8_Telephone[0]", value: "6265550142" },
    { name: "Pt1Line9_StreetNumberName[0]", value: "1050 Lakes Drive Suite 225" },
    { name: "Pt1Line9_Telephone[0]", value: "6268889999" },
  ];
  const r = x.extract({ fields, text: PAGE1 });
  ok("form fields are used when the PDF has them", r.method === "fields");
  ok("…giving the item 8 address", /1425 Cameron/.test(r.address), r.address);
  ok("…and the item 8 phone", r.phone === "626-555-0142", r.phone);
  ok("item 9 fields are never read",
    !/1050 Lakes/.test(r.address) && !/8889999/.test(r.phone.replace(/\D/g, "")));
  ok("the field names actually used are reported, so a wrong guess about the "
   + "form edition is visible on the first run",
    r.fieldsUsed && /Line8/.test(r.fieldsUsed.street), JSON.stringify(r.fieldsUsed));
  const empty = x.extract({ fields: [{ name: "Pt1Line8_Street[0]", value: "" }], text: PAGE1 });
  ok("empty form fields fall back to the text rather than returning blanks",
    empty.method === "text" && /1425 Cameron/.test(empty.address), empty.method);
}

console.log("\n── Phone normalising ───────────────────────────");
for (const [inp, want] of [
  ["(626) 555-0142", "6265550142"], ["626.555.0142", "6265550142"],
  ["1-626-555-0142", "6265550142"], ["6265550142", "6265550142"],
  ["555-0142", ""], ["not a phone", ""], ["", ""],
]) ok(`${JSON.stringify(inp)} → ${JSON.stringify(want)}`,
  x.normalizePhone(inp) === want, x.normalizePhone(inp));

console.log("\n── Which file is 'the most recent 589' ─────────");
{
  const files = [
    { name: "I-589 (2021).pdf", modified: "2021-03-01" },
    { name: "I-589 signed.pdf", modified: "2024-06-15" },
    { name: "I-589 DRAFT.pdf", modified: "2026-01-01" },
    { name: "Country conditions packet.pdf", modified: "2026-02-01" },
    { name: "I-589 instructions.docx", modified: "2026-03-01" },
  ];
  const pick = x.pickMostRecent(files);
  ok("the newest real I-589 wins", pick && pick.name === "I-589 signed.pdf", pick && pick.name);
  ok("a draft does not win just for being newer", pick.name !== "I-589 DRAFT.pdf");
  ok("an unrelated PDF is not mistaken for the form", pick.name !== "Country conditions packet.pdf");
  ok("a non-PDF is not chosen", !/\.docx$/i.test(pick.name));
  ok("a folder with no 589 returns nothing at all",
    x.pickMostRecent([{ name: "passport.pdf", modified: "2026-01-01" }]) === null);
  ok("a draft is used only when there is nothing else",
    x.pickMostRecent([{ name: "I-589 DRAFT.pdf", modified: "2026-01-01" }]).name === "I-589 DRAFT.pdf");
}

console.log("\n── Blanks are filled; differences are flagged ──");
{
  const found = { phone: "626-555-0142", address: "1425 Cameron Avenue, Apt 3B, West Covina, CA 91790" };
  const blank = x.decide({ current: { phone: "", address: "" }, found });
  ok("a blank phone is filled", blank.phone === found.phone);
  ok("a blank address is filled", blank.address === found.address);
  ok("nothing is flagged when there was nothing to disagree with", blank.conflicts.length === 0);

  const differs = x.decide({
    current: { phone: "626-999-1111", address: "9 Old Road, Azusa, CA 91702" }, found });
  ok("an existing phone is NOT overwritten", differs.phone === null);
  ok("an existing address is NOT overwritten", differs.address === null);
  ok("both differences are flagged for a human", differs.conflicts.length === 2);
  ok("the flag carries both values so the choice can be made", /999.?1111/.test(differs.conflicts[0].on_file));

  const same = x.decide({ current: { phone: "(626) 555-0142", address: found.address }, found });
  ok("the same phone written differently is not a conflict", same.conflicts.length === 0,
    JSON.stringify(same.conflicts));
}

console.log("\n── Which file in the folder is the form ───────");
{
  // Driven by what the vision reader reported from real folders: the newest
  // name match was the supplement-and-statement packet, and the base form was
  // beside it under a different name.
  const folder = [
    { name: "updated I-589 and Statement.pdf", modified: "2026-08-19" },
    { name: "I-589 signed.pdf",                modified: "2025-11-02" },
    { name: "asylum application form.pdf",     modified: "2025-10-01" },
    { name: "I-589 draft.pdf",                 modified: "2026-09-01" },
    { name: "medical records.pdf",             modified: "2026-09-10" },
    { name: "I-589 translation certificate.pdf", modified: "2026-09-12" },
  ];
  const ranked = x.rankCandidates(folder);

  ok("the plain signed form outranks the newer supplement packet",
    ranked[0].name === "I-589 signed.pdf", ranked.map(f => f.name).join(" | "));
  ok("the supplement packet is still a candidate, just not the first",
    ranked.some(f => /updated I-589 and Statement/.test(f.name)));
  ok("a folder whose form is called asylum application is no longer missed",
    x.scoreCandidate({ name: "asylum application form.pdf" }) > 0);
  ok("a draft never outranks a real one",
    x.scoreCandidate({ name: "I-589 draft.pdf" }) < x.scoreCandidate({ name: "I-589 signed.pdf" }));
  ok("unrelated documents are not offered at all",
    !ranked.some(f => /medical records/.test(f.name)));
  ok("a translation certificate ranks below the form",
    x.scoreCandidate({ name: "I-589 translation certificate.pdf" }) <
    x.scoreCandidate({ name: "I-589 signed.pdf" }));
  ok("only PDFs are considered", x.scoreCandidate({ name: "I-589 notes.docx" }) === 0);
  ok("the list is bounded, so a messy folder cannot cost a dozen model calls",
    x.rankCandidates(Array.from({ length: 30 }, (_, i) => ({ name: "I-589 copy " + i + ".pdf" }))).length <= 3);
  ok("pickMostRecent still returns one file for the callers that want one",
    x.pickMostRecent(folder).name === "I-589 signed.pdf");
  ok("...and still returns null for a folder with nothing matching",
    x.pickMostRecent([{ name: "passport.pdf" }]) === null);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL I-589 CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
