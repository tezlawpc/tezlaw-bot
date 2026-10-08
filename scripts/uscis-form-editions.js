// Run by .github/workflows/update-uscis-forms.yml, weekly.
//
// In a file rather than inline in the YAML: an inline node -e with quotes
// and backslashes inside a YAML scalar is exactly how check-ci-file.js's
// three previous incidents started.
const fs = require("fs");
const path = require("path");
const F = require(path.join(__dirname, "..", "uscis-forms.js"));

let previous = {};
try { previous = require(path.join(__dirname, "..", "uscis-forms.json")); } catch { /* first run */ }

F.checkAll({ previous }).then((r) => {
  fs.writeFileSync(path.join(__dirname, "..", "uscis-forms.json"),
    JSON.stringify(r, null, 2) + "\n");
  console.log(F.report(r));
  // A form that could not be read keeps its last known edition, so a
  // silent failure looks exactly like no change. Say so loudly.
  if (r.failed.length) {
    console.log(`::warning::${r.failed.length} form(s) could not be read: ` +
      r.failed.map((f) => f.id).join(", "));
  }
}).catch((err) => { console.error(err); process.exit(1); });
