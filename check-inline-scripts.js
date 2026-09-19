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
    const offenders = [];
    code.split('\n').forEach((l, n) => {
      const s = l.replace(/\\./g, '').replace(/\/\/.*$/, '');
      if ((s.match(/"/g) || []).length % 2 === 1 || (s.match(/'/g) || []).length % 2 === 1) {
        offenders.push((n + 1) + ': ' + l.trim().slice(0, 70));
      }
    });
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
    const app2 = mk('app.get("/admin/civil/new"', 'app.post("/admin/civil"');
    const s2 = app2.listen(0, async () => {
      audit('new-case-form', await (await fetch('http://127.0.0.1:' + s2.address().port + '/admin/civil/new')).text());
      console.log('\n' + '='.repeat(48) + `\n${total} script block(s), ${bad} problem(s)\n` + '='.repeat(48));
      s1.close(); s2.close(); process.exit(bad ? 1 : 0);
    });
  });
})();
