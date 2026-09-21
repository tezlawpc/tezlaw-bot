// Renders every admin page that emits inline JS, then checks the script the
// browser would actually receive: does it parse, and does any string literal
// run across a newline (the server-template-literal \n trap).
const express = require('express');
const Module = require('module');
const fs = require('fs');
const vm = require('vm');
const REPO = require('path').join(__dirname, '..');

const cdxStub = {
  DOC_CATEGORIES: [{ key: 'pleadings', label: 'Pleadings', color: '#D97706' }],
  listCaseFiles: async () => ([{ id: 7, name: "O'Brien Complaint.pdf", category: 'pleadings', relative_folder: 'Pleadings', size_bytes: 2097152, server_modified: '2026-03-01', archived: false, removed_at: null }]),
  categorySummary: async () => ([{ key: 'pleadings', label: 'Pleadings', color: '#D97706', count: 1 }]),
  browseFolders: async () => ({ path: '', parent: null, folders: [], file_count: 0 }),
  getCivilRoots: async () => ['/Civil'], rootsAreConfigured: async () => true,
};
const civilStub = {
  STAGES: [
    { key: 'intake', label: 'Intake / Assessment', color: '#7B5330' },
    { key: 'discovery', label: 'Discovery', color: '#B8891E' },
    { key: 'closed', label: 'Closed', color: '#166534' },
  ],
  STAGE_KEYS: new Set(['intake', 'discovery', 'closed']),
  kanban: async () => ({
    stages: civilStub.STAGES,
    counts: { intake: 1, discovery: 1, closed: 0 },
    cases_by_stage: {
      intake: [{ id: 1, case_name: "O'Brien v. Smith", our_role: 'plaintiff', stage: 'intake',
                 trial_date: '2026-11-02', statute_of_limitations: null, files_archived_at: null,
                 amount_in_controversy: 250000, updated_at: '2026-03-01' }],
      discovery: [{ id: 2, case_name: 'BZ v- Hernandez', our_role: 'defendant', stage: 'discovery',
                    trial_date: null, statute_of_limitations: null, files_archived_at: '2026-02-01',
                    amount_in_controversy: null, updated_at: '2026-03-01' }],
      closed: [],
    },
  }),
  CASE_TYPES: ['breach of contract'], OUR_ROLES: ['plaintiff'],
  listEvents: async () => [], listDeadlines: async () => [], listCommunications: async () => [],
  getCaseSummary: async () => ({ id: 1, case_name: "O'Brien v. Smith", client_key: 'obrien', stage: 'intake',
    billing_type: 'hourly', dropbox_path: "/Civil/O'Brien", dropbox_synced_at: '2026-03-02',
    files_archived_at: null, dropbox_sync_error: null }),
};
const origLoad = Module._load;
Module._load = function (r) {
  if (r === './civil-dropbox') return cdxStub;
  if (r === './civil-litigation') return civilStub;
  if (r === './hearing-notes') return { renderAdminChrome: ({ body }) => '<html>' + body + '</html>' };
  if (r === './client-profiles') return { aggregateClients: async () => ([{ key: 'obrien', client_name: "O'Brien" }]) };
  if (r === './db') return { query: async () => ({ rows: [] }) };
  return origLoad.apply(this, arguments);
};

let bad = 0, total = 0;
function audit(label, html) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (!blocks.length) { console.log('  --    ' + label + ': no inline script'); return; }
  blocks.forEach((code, i) => {
    total++;
    const tag = label + ' #' + (i + 1);
    // 1. does it parse?
    try { new vm.Script(code); }
    catch (e) { bad++; console.log('  FAIL  ' + tag + ' parse: ' + e.message); return; }
    // 2. any string literal crossing a newline?
    //
    // This is the check that matters: the server-template-literal traps all
    // end the same way — a \n or \' that the server consumes reaches the
    // browser as a real newline or a bare quote, and a '...' or "..." string
    // ends up spanning lines.
    //
    // Doing it per line, statelessly, produced two kinds of false positive:
    // an apostrophe inside a double-quoted string ("didn't"), and an
    // apostrophe inside a BROWSER-side template literal that legitimately
    // spans lines ("don't" inside a `...` block). So the scan carries its
    // state across lines and understands three things: which delimiter it is
    // inside, escapes, and ${ } expressions within a template literal, where
    // ordinary quoting rules resume.
    const offenders = [];
    {
      let quote = null;          // null | ' | " | `
      let tmplDepth = 0;         // how many ${ } we are inside
      const stack = [];          // template literals suspended by a ${
      const lines = code.split('\n');
      for (let n = 0; n < lines.length; n++) {
        const l = lines[n];
        let esc = false;
        for (let i = 0; i < l.length; i++) {
          const ch = l[i];
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }

          if (quote === '`') {
            if (ch === '`') { quote = null; continue; }
            if (ch === '$' && l[i + 1] === '{') {   // into an expression
              stack.push('`'); quote = null; tmplDepth++; i++; continue;
            }
            continue;
          }
          if (quote) { if (ch === quote) quote = null; continue; }

          if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
          if (ch === '}' && tmplDepth > 0) {        // back out to the literal
            tmplDepth--; quote = stack.pop() || null; continue;
          }
          if (ch === '/' && l[i + 1] === '/') break;   // comment to end of line
        }
        // A backtick may legitimately stay open across lines. A quoted string
        // may not — that is the bug this whole file exists to catch.
        if (quote === '"' || quote === "'") {
          offenders.push((n + 1) + ': ' + l.trim().slice(0, 70));
          quote = null;   // resync so one break does not cascade
        }
      }
    }
    if (offenders.length) { bad++; console.log('  FAIL  ' + tag + ' unterminated string at line ' + offenders[0]); return; }
    // 3. every onclick handler defined?
    console.log('  PASS  ' + tag + ' (' + code.length + ' chars)');
  });
  const all = blocks.join('\n');
  const handlers = [...new Set([...html.matchAll(/onclick="([a-zA-Z_$][\w$]*)\(/g)].map(m => m[1]))];
  const missing = handlers.filter(h => !new RegExp('function\\s+' + h + '\\b').test(all));
  if (missing.length) { bad++; console.log('  FAIL  ' + label + ' undefined handlers: ' + missing.join(', ')); }
  else if (handlers.length) console.log('  PASS  ' + label + ' all ' + handlers.length + ' handlers defined');
}

(async () => {
  const ui = require(REPO + '/civil-litigation-ui.js');
  console.log('\n=== inline script audit ===');

  // The admin chrome carries the largest inline script in the app — the nav,
  // the permission filter, the drawer and the active-link highlighting — and
  // it was EXEMPT from this check, because line ~47 stubs renderAdminChrome
  // out to keep the page bodies small. That exemption let a real instance of
  // the exact bug this file exists to catch ship to production: a regex
  // literal written as /\/+$/ inside a server-side template literal reached
  // the browser as //+$/, commenting out the rest of the block and silently
  // disabling the whole script. Audited from the real module, unstubbed.
  {
    const Module = require('module');
    const keep = Module._load;
    Module._load = function (r, ...rest) {
      if (r === './db') return { query: async () => ({ rows: [] }) };
      return keep.call(this, r, ...rest);
    };
    let chrome = null;
    try { chrome = require(REPO + '/hearing-notes.js'); } catch (e) {
      bad++; console.log('  FAIL  admin-chrome could not be loaded: ' + e.message);
    }
    Module._load = keep;
    if (chrome && chrome.renderAdminChrome) {
      audit('admin-chrome', chrome.renderAdminChrome({ title: 'T', body: '<div></div>', activeItem: 'civil' }));
    }
  }

  audit('case-detail', await ui.renderCaseDetail(1));

  // Wave B: the new panels are mounted by /static/civil-admin.js, so the page
  // must carry the host attribute, every mount point, every action button, and
  // the cache-busted script tag.
  const detail = await ui.renderCaseDetail(1);
  const needDetail = [
    ['data-case-id host', /data-case-id="1"/],
    ['docket panel', /data-civil-panel="docket"/],
    ['team panel', /data-civil-panel="team"/],
    ['discovery panel', /data-civil-panel="discovery"/],
    ['depos panel', /data-civil-panel="depos"/],
    ['financials panel', /data-civil-panel="financials"/],
    ['edit-case button', /data-civil-action="edit-case"/],
    ['log-event button', /data-civil-action="log-event"/],
    ['log-comm button', /data-civil-action="log-comm"/],
    ['add-deadline button', /data-civil-action="add-deadline"/],
    ['regenerate button', /data-civil-action="regenerate-deadlines"/],
    ['static script tag', /<script src="\/static\/civil-admin\.js\?v=[a-z0-9]+" defer><\/script>/],
  ];
  needDetail.forEach(([what, re]) => {
    if (re.test(detail)) console.log('  PASS  case-detail ' + what);
    else { bad++; console.log('  FAIL  case-detail ' + what + ' MISSING'); }
  });

  const board = await ui.renderKanban();
  audit('kanban', board);
  // The drag wiring is only useful if the markup it targets actually exists.
  const need = [
    ['draggable cards', /class="civil-card"[\s\S]*?data-case-id="\d+"/],
    ['drop columns', /class="civil-col" data-stage="[a-z_]+"/],
    ['move-stage post', /\/move-stage/],
  ];
  need.forEach(([what, re]) => {
    if (re.test(board)) console.log('  PASS  kanban ' + what);
    else { bad++; console.log('  FAIL  kanban ' + what + ' missing'); }
  });

  const src = fs.readFileSync(REPO + '/server.js', 'utf8');
  const mk = (from, to) => { const a = express(); a.use(express.json()); const i = src.indexOf(from); new Function('app', 'require', src.slice(i, src.indexOf(to, i)))(a, require); return a; };
  const app1 = mk('// ── Civil ⇄ Dropbox: admin-side actions', 'app.post("/admin/civil", async (req, res) => {');
  const s1 = app1.listen(0, async () => {
    audit('dropbox-console', await (await fetch('http://127.0.0.1:' + s1.address().port + '/admin/civil/dropbox')).text());
    // End the slice at the very next route, not at the create-case POST:
    // between them now sit routes that close over module-level things this
    // harness does not have (the multer instance the document intake uses),
    // and evaluating those throws before the form is ever rendered.
    const app2 = mk('app.get("/admin/civil/new"', 'app.get("/admin/civil/triage"');
    const s2 = app2.listen(0, async () => {
      audit('new-case-form', await (await fetch('http://127.0.0.1:' + s2.address().port + '/admin/civil/new')).text());
      console.log('\n' + '='.repeat(48) + `\n${total} script block(s), ${bad} problem(s)\n` + '='.repeat(48));
      s1.close(); s2.close(); process.exit(bad ? 1 : 0);
    });
  });
})();
