// ============================================================
//  TEZ LAW P.C. — CLIENT PROFILES
//  ─────────────────────────────────────────────────────────
//  Aggregated view of every client the firm has touched across
//  master and individual hearing notes. Provides:
//    - List of all unique clients (with search/filter)
//    - Detail page showing full case history, upcoming
//      hearings/deadlines, and quick-contact actions
//
//  Grouping identity: A-Number (preferred) or client name.
//  Read-only aggregation — no new tables required.
// ============================================================

const db = require("./db");
const hearingNotes = require("./hearing-notes");

// ── Stating a stored hearing date ────────────────────────
//
// court-calendar.js's contract: a hearing date is the date and time
// printed on the notice, stored with no zone, read back in UTC and never
// converted. Every other reader honours it -- storedDay() there,
// hearing-when.js, client-record.js.
//
// This file did not. It formatted hearing dates with a bare
// toLocaleDateString(), which reads them in whatever zone the process
// happens to be in. That is right on Render, which runs UTC, and a day
// early on a laptop in Los Angeles -- so the bug was invisible in
// production and would have appeared the first time anyone looked at a
// client's profile from a local server.
//
// Naming the zone makes it the same answer everywhere.
const STORED_DAY = { year: "numeric", month: "short", day: "numeric" };

function storedDayText(v) {
  if (!v) return "-";
  const d = new Date(v);
  return isNaN(d) ? "-" : d.toLocaleDateString("en-US", { timeZone: "UTC", ...STORED_DAY });
}

// A real instant -- when something HAPPENED, like a correction being saved
// -- shown in the office's own day.
//
// The opposite of storedDayText, and the distinction matters: a stored
// hearing date is read in UTC because it was written with no zone, and a
// true instant is read in Pacific because that is where the office is.
// Using one where the other belongs is how this page came to show a 10:00
// AM hearing as 3:00 AM.
function instantDayText(v) {
  if (!v) return "";
  const d = new Date(v);
  return isNaN(d) ? "" : d.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles", ...STORED_DAY,
  });
}

// The date, plus the time printed on the notice when there is one.
// Midnight is how "no time was given" is stored, so it is not a hearing at
// twelve at night.
function storedWhenText(v) {
  if (!v) return "-";
  const d = new Date(v);
  if (isNaN(d)) return "-";
  const day = d.toLocaleDateString("en-US", { timeZone: "UTC", ...STORED_DAY });
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return day;
  const h = d.getUTCHours();
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} at ${h % 12 || 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

// ── Aggregation ──────────────────────────────────────────

// Turn a client identity key into a URL-safe form
function clientKey({ aNumber, clientName }) {
  if (aNumber) return "a-" + String(aNumber).toLowerCase().replace(/[^\w]/g, "");
  const n = String(clientName || "").toLowerCase().trim().replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");
  return n ? "n-" + n : null;
}

// Match a row to a key
function rowKey(row) {
  return clientKey({ aNumber: row.a_number, clientName: row.client_name });
}

// Fetch every hearing note (master + individual) and group by client identity.
async function aggregateClients() {
  const [masterRes, indivRes] = await Promise.all([
    db.query(`
      SELECT id, client_name, a_number, client_language, client_email, client_phone,
             client_address, case_type, hearing_type, hearing_date,
             next_hearing_date, next_hearing_type,
             judge_name, disposition, sent_to_paralegal_at, created_at
      FROM hearing_notes
      ORDER BY COALESCE(hearing_date, created_at) DESC
    `),
    db.query(`
      SELECT id, client_name, a_number, client_language, client_email, client_phone,
             client_address, case_type, hearing_date,
             next_hearing_date, next_hearing_type,
             judge_name, court_location, court_address, disposition,
             sent_to_paralegal_at, created_at
      FROM individual_hearing_notes
      ORDER BY COALESCE(hearing_date, created_at) DESC
    `),
  ]);

  const clients = {};

  const ingest = (row, kind) => {
    const key = rowKey(row);
    if (!key) return;
    if (!clients[key]) {
      clients[key] = {
        key,
        client_name: row.client_name,
        a_number: row.a_number,
        client_email: row.client_email,
        client_phone: row.client_phone,
        client_address: row.client_address,
        client_language: row.client_language,
        case_types: new Set(),
        judges: new Set(),
        hearings: [],
        upcoming: [],
        deadlines: [],
        sent_count: 0,
      };
    }
    const c = clients[key];
    // Fill in missing contact info from most recent record (rows come newest-first)
    if (!c.client_email && row.client_email) c.client_email = row.client_email;
    if (!c.client_phone && row.client_phone) c.client_phone = row.client_phone;
    if (!c.client_address && row.client_address) c.client_address = row.client_address;
    if (!c.client_language && row.client_language) c.client_language = row.client_language;
    if (row.case_type) c.case_types.add(row.case_type);
    if (row.judge_name) c.judges.add(row.judge_name);
    c.hearings.push({
      id: row.id,
      kind,
      type_label: kind === "master" ? (row.hearing_type || "master") : "individual",
      hearing_date: row.hearing_date,
      judge_name: row.judge_name,
      case_type: row.case_type || null,
      court_location: row.court_location || null,
      court_address: row.court_address || null,
      disposition: row.disposition,
      sent: !!row.sent_to_paralegal_at,
      created_at: row.created_at,
      edit_url: kind === "master" ? `/admin/hearing/notes/${row.id}` : `/admin/hearing/individual/${row.id}`,
    });
    if (row.sent_to_paralegal_at) c.sent_count++;

    // Upcoming hearings (in the future only)
    if (row.next_hearing_date) {
      const nhd = new Date(row.next_hearing_date);
      if (!isNaN(nhd) && nhd.getTime() > Date.now()) {
        c.upcoming.push({
          date: row.next_hearing_date,
          type: row.next_hearing_type || "hearing",
          from_id: row.id,
          from_kind: kind,
        });
      }
    }
  };

  for (const row of masterRes.rows) ingest(row, "master");
  for (const row of indivRes.rows) ingest(row, "individual");

  // Pull EVERY client's Dropbox path (not just bulk-imported ones) so we can
  // extract broker/referral from the folder structure. Structure convention:
  //   /Branch/Broker/Client   → broker is second-to-last segment
  //   /Branch/Client          → no broker (direct intake)
  // Where "Branch" is anything matching DROPBOX_BRANCH_ROOTS (or its first segment).
  let branchPrefixes = [];
  try {
    const dbx = require("./dropbox-integration");
    const branches = (typeof dbx.getBranchRoots === "function") ? dbx.getBranchRoots() : [];
    branchPrefixes = branches.map(b => (b.startsWith("/") ? b : "/" + b).toLowerCase().replace(/\/+$/, ""));
  } catch {}

  const extractBrokerFromPath = (path) => {
    if (!path) return null;
    let rel = path;
    const lower = path.toLowerCase();
    // Strip any known branch prefix
    for (const prefix of branchPrefixes) {
      if (lower.startsWith(prefix + "/") || lower === prefix) {
        rel = path.substring(prefix.length);
        break;
      }
    }
    const segments = rel.split("/").filter(Boolean);
    // segments = [broker, client] means 2 → broker is segments[0]
    // segments = [client] means 1 → no broker
    // segments = [broker, sub, client] means 3+ → broker is second-to-last
    if (segments.length >= 2) {
      return segments[segments.length - 2];
    }
    return null;
  };

  // Also include clients that exist in client_dropbox_mapping but have no
  // hearing notes yet — these were bulk-imported from Dropbox.
  try {
    const dbxRes = await db.query(`
      SELECT client_key, client_name, a_number, dropbox_path, resolved_at
      FROM client_dropbox_mapping
      WHERE resolved_by = 'bulk_import'
    `);
    for (const row of dbxRes.rows) {
      if (clients[row.client_key]) continue;  // already have from hearing notes
      clients[row.client_key] = {
        key: row.client_key,
        client_name: row.client_name,
        a_number: row.a_number,
        client_email: null,
        client_phone: null,
        client_address: null,
        client_language: null,
        case_types: new Set(),
        judges: new Set(),
        hearings: [],
        upcoming: [],
        deadlines: [],
        sent_count: 0,
        dropbox_only: true,
        dropbox_path: row.dropbox_path,
        broker: extractBrokerFromPath(row.dropbox_path),
      };
    }
  } catch (e) {
    console.warn("[client-profiles] Dropbox-only client aggregation failed:", e.message);
  }

  // Also include contact-only clients — rows in the tasks table with
  // matter_type = 'Contact' inserted via the mobile app's "Add contact"
  // flow. These never appear in hearing_notes / individual_hearing_notes,
  // so without this merge they'd be invisible on the web /admin/clients
  // page even though the row exists.
  //
  // Matched by matter_type as well as by the 'contact-' key prefix. Opening
  // a civil matter creates the client's contact row under the key the
  // attorney typed on the form ("ruiz-ana"), which has no prefix — and a
  // prefix-only match made those clients invisible here even though the
  // row had been written. That was the "client profile is not created" bug.
  try {
    const contactRes = await db.query(`
      SELECT DISTINCT ON (client_key)
             client_key, client_name, a_number, client_phone, client_email,
             referral_source, description, assigned_to, created_at
      FROM tasks
      WHERE client_key IS NOT NULL AND (client_key LIKE 'contact-%' OR matter_type = 'Contact')
      ORDER BY client_key, created_at DESC
    `);
    for (const row of contactRes.rows) {
      if (clients[row.client_key]) continue;  // already covered by hearing notes / dropbox
      clients[row.client_key] = {
        key: row.client_key,
        client_name: row.client_name || row.client_key,
        a_number: row.a_number,
        client_email: row.client_email,
        client_phone: row.client_phone,
        client_address: null,
        client_language: null,
        case_types: new Set(["Contact"]),
        judges: new Set(),
        hearings: [],
        upcoming: [],
        deadlines: [],
        sent_count: 0,
        contact_only: true,
        broker: row.referral_source || null,
        _notes: row.description,
        _assigned_to: row.assigned_to,
        _created_at: row.created_at,
      };
    }
  } catch (e) {
    console.warn("[client-profiles] Contact-only client aggregation failed:", e.message);
  }

  // Enrich every client (including hearing-based ones) with dropbox_path + broker
  try {
    const allPaths = await db.query(
      `SELECT client_key, dropbox_path FROM client_dropbox_mapping WHERE dropbox_path IS NOT NULL`
    );
    const pathByKey = new Map(allPaths.rows.map(r => [r.client_key, r.dropbox_path]));
    for (const k of Object.keys(clients)) {
      const p = pathByKey.get(k);
      if (p) {
        clients[k].dropbox_path = p;
        clients[k].broker = extractBrokerFromPath(p);
      } else if (!clients[k].broker) {
        clients[k].broker = null;
      }
    }
  } catch (e) {
    console.warn("[client-profiles] Broker enrichment failed:", e.message);
  }

  // Convert to array, materialize sets, compute summary metrics
  const results = Object.values(clients).map(c => {
    // Sort hearings by date desc for display
    c.hearings.sort((a, b) => {
      const ad = new Date(a.hearing_date || a.created_at).getTime();
      const bd = new Date(b.hearing_date || b.created_at).getTime();
      return bd - ad;
    });
    // Upcoming: earliest first
    c.upcoming.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    return {
      ...c,
      case_types: [...c.case_types],
      judges: [...c.judges],
      hearing_count: c.hearings.length,
      most_recent_date: c.hearings[0]?.hearing_date || c.hearings[0]?.created_at || null,
      most_recent_disposition: c.hearings.find(h => h.disposition)?.disposition || null,
    };
  });

  // Stored contact details win over whatever a hearing note happened to
  // record. One query for the whole book, not one per client — this runs
  // over every client in the firm.
  try {
    const contacts = await require("./client-contacts").all();
    if (contacts.size) {
      const apply = require("./client-contacts").apply;
      for (const c of results) apply(c, contacts.get(c.key));
    }
  } catch (e) {
    // A contacts failure must not take the client list down; the page then
    // shows what the notes say, exactly as it did before this existed.
    console.warn("[client-profiles] contacts overlay:", e.message);
  }

  // Sort clients by most recent activity
  results.sort((a, b) => {
    const ad = new Date(a.most_recent_date || 0).getTime();
    const bd = new Date(b.most_recent_date || 0).getTime();
    return bd - ad;
  });
  return results;
}

async function getClientByKey(key) {
  const all = await aggregateClients();
  return all.find(c => c.key === key) || null;
}

// ── Rendering ────────────────────────────────────────────

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttr(s) { return escapeHtml(s); }

function languageLabel(code) {
  const labels = {
    en: "English", zh: "Chinese (中文)", es: "Spanish (Español)",
    hi: "Hindi (हिन्दी)", pa: "Punjabi (ਪੰਜਾਬੀ)",
  };
  return labels[code] || code || "-";
}

function renderClientList(clients) {
  const rows = clients.length ? clients.map(c => {
    const nextUp = c.upcoming[0]
      ? `<span style="background:#A34C00; color:white; padding:2px 8px; border-radius:10px; font-size:11px;">Next: ${escapeHtml(c.upcoming[0].type)} ${storedDayText(c.upcoming[0].date)}</span>`
      : "";
    const sourceTag = c.dropbox_only
      ? `<span style="background:#2B2523; color:white; padding:2px 6px; border-radius:8px; font-size:10px; margin-left:4px;" title="Imported from Dropbox — no hearings recorded yet">📦 Dropbox</span>`
      : "";
    const brokerCell = c.broker
      ? `<span style="color:#A34C00; font-weight:600; font-size:12px;">🤝 ${escapeHtml(c.broker)}</span>`
      : `<span style="color:#5E5854;">—</span>`;
    return `
    <tr class="c-row"
        data-name="${escapeAttr((c.client_name || "").toLowerCase())}"
        data-words="${escapeAttr(CS.nameWords(c.client_name).join(" "))}"
        data-anumber="${escapeAttr((c.a_number || "").toLowerCase().replace(/[-\s]/g, ""))}"
        data-email="${escapeAttr((c.client_email || "").toLowerCase())}"
        data-lang="${escapeAttr(c.client_language || "")}"
        data-hasupcoming="${c.upcoming.length ? "yes" : "no"}"
        data-casetypes="${escapeAttr(c.case_types.join(" | ").toLowerCase())}"
        data-broker="${escapeAttr((c.broker || "").toLowerCase())}"
        data-source="${c.dropbox_only ? "dropbox" : "hearings"}">
      <td><a href="/admin/clients/${c.key}" style="color:#A34C00; font-weight:600;">${escapeHtml(c.client_name || "(unnamed)")}</a>${sourceTag}</td>
      <td>${escapeHtml(c.a_number || "")}</td>
      <td>${escapeHtml(c.case_types.slice(0, 2).join(", ") || "-")}${c.case_types.length > 2 ? " +" + (c.case_types.length - 2) : ""}</td>
      <td>${c.hearing_count}</td>
      <td>${storedDayText(c.most_recent_date)}</td>
      <td>${languageLabel(c.client_language)}</td>
      <td>${nextUp}</td>
      <td>${brokerCell}</td>
      <td><a href="/admin/clients/${c.key}" style="color:#2B2523;">view →</a></td>
    </tr>`;
  }).join("") : `<tr><td colspan="9" style="text-align:center; color:#5E5854;">No clients yet. Create a hearing note or bulk import from Dropbox to populate this list.</td></tr>`;

  const totalUpcoming = clients.filter(c => c.upcoming.length).length;
  const totalDropboxOnly = clients.filter(c => c.dropbox_only).length;

  const body = `
    <div class="page-header">
      <h1>Client Profiles</h1>
      <div style="font-size:13px; color:#5E5854;">${clients.length} clients · ${totalUpcoming} with upcoming hearings${totalDropboxOnly ? ` · ${totalDropboxOnly} from Dropbox` : ""}</div>
    </div>

    <div style="background:white; padding:15px; border-radius:4px; margin-bottom:15px; border:1px solid #E8E3DC;">
      <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
        <div style="flex:1; min-width:280px;">
          <input type="text" id="search-input" placeholder="🔍 Search by name, A-Number, email, or case type..."
                 onkeyup="filterRows()"
                 style="width:100%; padding:9px 12px; border:1px solid #CFC8BE; border-radius:4px; font-size:14px;">
        </div>
        <div>
          <select id="filter-upcoming" onchange="filterRows()" style="padding:9px; border:1px solid #CFC8BE; border-radius:4px; font-size:14px;">
            <option value="">All clients</option>
            <option value="yes">Has upcoming hearing</option>
            <option value="no">No upcoming hearing</option>
          </select>
        </div>
        <div>
          <select id="filter-lang" onchange="filterRows()" style="padding:9px; border:1px solid #CFC8BE; border-radius:4px; font-size:14px;">
            <option value="">All languages</option>
            <option value="en">English</option>
            <option value="zh">Chinese</option>
            <option value="es">Spanish</option>
            <option value="hi">Hindi</option>
            <option value="pa">Punjabi</option>
          </select>
        </div>
        <div>
          <button type="button" onclick="clearFilters()" style="padding:9px 14px; background:#F3EFE9; border:none; border-radius:4px; cursor:pointer; font-size:13px;">Clear</button>
        </div>
        <div style="border-left:1px solid #E8E3DC; padding-left:12px;">
          <button type="button" onclick="showAddContactModal()" title="Add a new client contact record (no case yet)" style="padding:9px 14px; background:#FF7B00;color:#1E1B1A; border:none; border-radius:4px; cursor:pointer; font-size:13px; font-weight:600;">➕ Add Client</button>
          <a href="/admin/clients/i589" title="Read each client's address and phone from item 8 of their most recent I-589" style="padding:9px 14px; background:#fff; color:#2B2523; border:1px solid #E8E3DC; border-radius:4px; text-decoration:none; font-size:13px; font-weight:600; display:inline-block;">📄 I-589 addresses</a>
          <button type="button" onclick="bulkImportDropbox(true)" title="Preview what would be imported (no changes)" style="padding:9px 14px; background:#F3EFE9; border:none; border-radius:4px; cursor:pointer; font-size:13px; margin-left:4px;">👁 Preview import</button>
          <button type="button" onclick="bulkImportDropbox(false)" title="Scan Dropbox and add all client folders as clients" style="padding:9px 14px; background:#2B2523; color:white; border:none; border-radius:4px; cursor:pointer; font-size:13px; margin-left:4px;">📥 Import from Dropbox</button>
        </div>
      </div>
      <div id="row-count" style="margin-top:10px; font-size:13px; color:#5E5854;">Showing ${clients.length} client${clients.length === 1 ? "" : "s"}</div>
      <div id="import-status" style="margin-top:10px; font-size:13px;"></div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Client</th><th>A#</th><th>Case Type</th><th>Hearings</th>
          <th>Last Activity</th><th>Language</th><th>Status</th><th>Broker</th><th></th>
        </tr>
      </thead>
      <tbody id="rows-body">${rows}</tbody>
    </table>

    <script>
      const TOTAL = ${clients.length};
      // The words of what was typed, punctuation dropped. Same rule the server
      // uses in client-search.js, so this page and the API agree on a match.
      function queryWords(s) {
        return String(s || "").toLowerCase()
          .replace(/['\\u2018\\u2019\\u02bc\`]/g, "")
          .replace(/[^\\p{L}\\p{N}]+/gu, " ")
          .trim().split(/\\s+/).filter(Boolean);
      }
      function filterRows() {
        // Folders are named "WANG, BAOHONG", so the name carries a comma and
        // puts the surname first. Match word by word instead of as a string,
        // and every one of these finds her: "baohong", "wang baohong",
        // "baohong wang", "wang, baohong", "wang b".
        const raw = document.getElementById("search-input").value.trim();
        const digits = raw.replace(/\\D/g, "");
        const words = queryWords(digits.length >= 4 ? raw.replace(/[\\d\\-\\s]+/g, " ") : raw);
        const compact = raw.toLowerCase().replace(/[-\\s]/g, "");
        const upcoming = document.getElementById("filter-upcoming").value;
        const lang = document.getElementById("filter-lang").value;
        let visible = 0;
        document.querySelectorAll(".c-row").forEach(row => {
          const nameWords = (row.dataset.words || "").split(" ").filter(Boolean);
          const anumber = row.dataset.anumber || "";
          const email = row.dataset.email || "";
          const casetypes = row.dataset.casetypes || "";
          // Every word typed must begin one of the words in the name.
          const byName = words.length > 0 && nameWords.length > 0 &&
            words.every(w => nameWords.some(h => h.indexOf(w) === 0));
          // Four digits or more, so a stray "1" does not match half the firm.
          const byNumber = digits.length >= 4 && anumber.indexOf(digits) !== -1;
          const byOther = compact.length > 0 &&
            (email.replace(/\\s/g,"").indexOf(compact) !== -1 ||
             casetypes.replace(/\\s/g,"").indexOf(compact) !== -1);
          const matchesSearch = !raw || byName || byNumber || byOther;
          const matchesUpcoming = !upcoming || row.dataset.hasupcoming === upcoming;
          const matchesLang = !lang || row.dataset.lang === lang;
          const show = matchesSearch && matchesUpcoming && matchesLang;
          row.style.display = show ? "" : "none";
          if (show) visible++;
        });
        const count = document.getElementById("row-count");
        count.textContent = visible === TOTAL
          ? "Showing " + TOTAL + " client" + (TOTAL === 1 ? "" : "s")
          : "Showing " + visible + " of " + TOTAL + " clients";
      }
      function clearFilters() {
        document.getElementById("search-input").value = "";
        document.getElementById("filter-upcoming").value = "";
        document.getElementById("filter-lang").value = "";
        filterRows();
      }

      // ── Add Client (contact-only) modal ──────────────────────────
      function showAddContactModal() {
        const backdrop = document.createElement("div");
        backdrop.id = "addContactBackdrop";
        // overflow-y:auto on the backdrop AND a height cap on the panel below.
        // Without both, uploading an agreement makes the review section tall
        // enough to run off the top and bottom of the screen with nothing to
        // scroll — align-items:center centres an element taller than the
        // viewport by pushing its top out of reach.
        backdrop.style.cssText = "position:fixed;inset:0;background:rgba(26,16,8,0.55);z-index:9998;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto;overscroll-behavior:contain;";
        backdrop.onclick = (e) => { if (e.target === backdrop) closeAddContactModal(); };
        backdrop.innerHTML = ''
          + '<div style="background:#FAF8F5;border-radius:12px;padding:28px;max-width:520px;width:100%;max-height:calc(100vh - 40px);overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.4),0 0 0 1.5px #A34C00;">'
          +   '<h2 style="margin:0 0 6px 0;font-family:Montserrat,sans-serif;color:#2B2523;letter-spacing:2px;text-transform:uppercase;font-size:18px;">Add Client</h2>'
          +   '<p style="margin:0 0 20px 0;font-family:Georgia,serif;font-style:italic;color:#5E5854;font-size:13px;">Quick contact record — no case or matter needed. You can attach a case later.</p>'
          +   '<div id="addContactError" style="display:none;background:rgba(160,40,24,0.10);color:#9C2B1E;padding:10px 12px;border-radius:6px;border:1px solid #9C2B1E;margin-bottom:12px;font-size:13px;"></div>'
          +   '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
          +     '<div style="grid-column:1/-1;"><label style="display:block;font-size:11px;font-weight:600;color:#2B2523;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Client Name *</label><input id="ac_name" type="text" style="width:100%;padding:9px 12px;border:1px solid #E8E3DC;border-radius:6px;font-size:14px;" autofocus></div>'
          +     '<div><label style="display:block;font-size:11px;font-weight:600;color:#2B2523;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Phone</label><input id="ac_phone" type="tel" style="width:100%;padding:9px 12px;border:1px solid #E8E3DC;border-radius:6px;font-size:14px;" placeholder="626-555-0100"></div>'
          +     '<div><label style="display:block;font-size:11px;font-weight:600;color:#2B2523;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Email</label><input id="ac_email" type="email" style="width:100%;padding:9px 12px;border:1px solid #E8E3DC;border-radius:6px;font-size:14px;"></div>'
          +     '<div><label style="display:block;font-size:11px;font-weight:600;color:#2B2523;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">A-Number</label><input id="ac_anumber" type="text" style="width:100%;padding:9px 12px;border:1px solid #E8E3DC;border-radius:6px;font-size:14px;" placeholder="A200-000-000"></div>'
          +     '<div style="grid-column:1/-1;border-top:1px solid #E8E3DC;margin-top:4px;padding-top:12px;">'
          +       '<label style="display:block;font-size:11px;font-weight:600;color:#2B2523;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Signed retainer or fee agreement</label>'
          +       '<div style="font-size:12px;color:#5E5854;margin-bottom:8px;">Upload the PDF and the details are read off it for you to check. Nothing is saved until you tick it.</div>'
          +       '<input id="ac_file" type="file" accept="application/pdf" style="display:none;" onchange="acExtract(this)">'
          +       '<button type="button" id="ac_upload_btn" onclick="acPickFile()" style="width:100%;padding:10px;border:1.5px dashed #A34C00;border-radius:6px;background:rgba(184,137,30,0.07);color:#7A3900;cursor:pointer;font-size:13px;font-weight:600;">Choose a PDF</button>'
          +       '<div id="ac_review" style="display:none;margin-top:12px;"></div>'
          +     '</div>'
          +     '<div style="grid-column:1/-1;">'
          +       '<label style="display:block;font-size:11px;font-weight:600;color:#2B2523;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Practice area</label>'
          +       '<div style="font-size:12px;color:#5E5854;margin-bottom:6px;">Decides which Dropbox root the client folder goes under. Leave it blank if you are not sure - you will be asked rather than guessed at.</div>'
          +       '<div id="ac_branch_row">'
          +         '<button type="button" data-branch="immigration" onclick="acSetBranch(this)" style="padding:7px 16px;border:1px solid #E8E3DC;border-radius:999px;background:#FFF;color:#2B2523;cursor:pointer;font-size:13px;margin-right:8px;">Immigration</button>'
          +         '<button type="button" data-branch="civil" onclick="acSetBranch(this)" style="padding:7px 16px;border:1px solid #E8E3DC;border-radius:999px;background:#FFF;color:#2B2523;cursor:pointer;font-size:13px;">Civil</button>'
          +       '</div>'
          +     '</div>'
          +     '<div style="grid-column:1/-1;">'
          +       '<label style="display:block;font-size:11px;font-weight:600;color:#2B2523;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Broker</label>'
          +       '<div style="font-size:12px;color:#5E5854;margin-bottom:6px;">The client folder is created inside the broker&rsquo;s folder. Pick the practice area first.</div>'
          +       '<select id="ac_broker" style="width:100%;padding:9px 12px;border:1px solid #E8E3DC;border-radius:6px;font-size:14px;background:#FFF;" disabled>'
          +         '<option value="">— choose a practice area first —</option>'
          +       '</select>'
          +     '</div>'
          +     '<div style="grid-column:1/-1;"><label style="display:block;font-size:11px;font-weight:600;color:#2B2523;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Notes</label><textarea id="ac_notes" style="width:100%;padding:9px 12px;border:1px solid #E8E3DC;border-radius:6px;font-size:14px;min-height:60px;font-family:inherit;" placeholder="Anything you want to remember about this client..."></textarea></div>'
          +   '</div>'
          +   '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">'
          +     '<button type="button" onclick="closeAddContactModal()" style="padding:10px 20px;background:transparent;border:1.5px solid #A34C00;color:#7A3900;border-radius:6px;cursor:pointer;font-family:Montserrat,sans-serif;font-weight:500;letter-spacing:1px;text-transform:uppercase;font-size:12px;">Cancel</button>'
          +     '<button type="button" id="ac_submit" onclick="submitAddContact()" style="padding:10px 24px;background:#FF7B00;color:#1E1B1A;border:2px solid #9C2B1E;border-radius:6px;cursor:pointer;font-family:Montserrat,sans-serif;font-weight:700;letter-spacing:2px;text-transform:uppercase;font-size:12px;box-shadow:0 3px 10px rgba(184,66,0,0.3);">Save Client</button>'
          +   '</div>'
          + '</div>';
        document.body.appendChild(backdrop);
        // Reset per-client state, or the next client inherits this one's branch.
        acBranch = null; acFileName = ""; window.__acProposal = null;
        setTimeout(() => document.getElementById("ac_name").focus(), 50);
      }
      // ── Reading a retainer ────────────────────────────────────────
      // The server proposes; a person decides. Client details arrive ticked -
      // getting one wrong is obvious and the client corrects it on the phone.
      // Fee terms arrive UNTICKED, every one, each beside the sentence it was
      // read from, because a wrong fee amount sitting unchallenged in a file is
      // what fee disputes are made of. Nothing unticked is saved.
      var AC_LABELS = {
        client_name: "Client name", a_number: "A number", client_phone: "Phone",
        client_email: "Email", client_address: "Address", matter_type: "Matter type",
        opposing_party: "Opposing party", signed_date: "Signed",
        fee_structure: "Fee structure", fee_amount: "Fee amount", hourly_rate: "Hourly rate",
        retainer_deposit: "Retainer deposit", scope_included: "Scope - included",
        scope_excluded: "Scope - excluded", costs_responsibility: "Costs",
        payment_schedule: "Payment schedule"
      };
      var AC_UNREADABLE = {
        NO_TEXT_LAYER: "This PDF has no text in it - it looks like a scan or a photo of the agreement. Upload the original PDF if you have it, or type the details in.",
        IMAGE_UNSUPPORTED: "That is a photo, not a document. Upload the PDF of the agreement, or type the details in.",
        DOCX_UNSUPPORTED: "Word files cannot be read here yet. Save it as a PDF and upload that.",
        UNSUPPORTED: "That file type cannot be read. A PDF of the agreement works best."
      };
      var acBranch = null;
      var acFileName = "";
      function acLabel(k) { return AC_LABELS[k] || String(k).replace(/_/g, " "); }
      function acText(v) { return Array.isArray(v) ? v.filter(Boolean).join("; ") : String(v == null ? "" : v); }
      function acEsc(t) {
        return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;")
          .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }
      // Only fields that actually carry a QUOTED value are offered. A value the
      // server could not point at in the document never appears as a value.
      function acFilled(group) {
        var out = [];
        for (var k in (group || {})) {
          var c = group[k];
          if (!c) continue;
          var empty = c.value == null || c.value === "" || (Array.isArray(c.value) && !c.value.length);
          if (!empty && c.quote) out.push([k, c]);
        }
        return out;
      }
      function acSetBranch(btn) {
        var row = document.getElementById("ac_branch_row");
        var want = btn.getAttribute("data-branch");
        acBranch = (acBranch === want) ? null : want;
        Array.prototype.forEach.call(row.querySelectorAll("button"), function (b) {
          var on = b.getAttribute("data-branch") === acBranch;
          b.style.background = on ? "#FF7B00" : "#FFF";
          b.style.color = on ? "#FAF8F5" : "#2B2523";
          b.style.borderColor = on ? "#FF7B00" : "#E8E3DC";
        });
        acLoadBrokers();
      }
      // The brokers are real folders under the chosen root, not a typed name:
      // a typo would quietly create a second broker folder nobody looks in.
      // The broker folder IS the referral source: one question, asked once.
      // The select carries the folder PATH as its value, so the name comes
      // from the option text.
      function acBrokerName() {
        var sel = document.getElementById("ac_broker");
        if (!sel || !sel.value) return null;        // no folder chosen = direct
        var o = sel.options[sel.selectedIndex];
        var t = (o && o.text || "").trim();
        return t || null;
      }

      async function acLoadBrokers() {
        var sel = document.getElementById("ac_broker");
        if (!sel) return;
        if (!acBranch) {
          sel.disabled = true;
          sel.innerHTML = '<option value="">— choose a practice area first —</option>';
          return;
        }
        sel.disabled = true;
        sel.innerHTML = '<option value="">Loading…</option>';
        try {
          var r = await fetch("/admin/clients/brokers?branch=" + encodeURIComponent(acBranch), { credentials: "same-origin" });
          var d = await r.json();
          if (!r.ok || !d.ok) throw new Error(d.error || ("HTTP " + r.status));
          var html = '<option value="">Direct — no broker folder</option>';
          var likely = d.folders.filter(function (f) { return !f.looks_like_client; });
          var maybe = d.folders.filter(function (f) { return f.looks_like_client; });
          likely.forEach(function (f) { html += '<option value="' + acEsc(f.path) + '">' + acEsc(f.name) + '</option>'; });
          // Folders named "Last, First" are almost certainly clients filed at the
          // root, not brokers - shown last rather than hidden, in case one is.
          if (maybe.length) {
            html += '<optgroup label="These look like client folders">';
            maybe.forEach(function (f) { html += '<option value="' + acEsc(f.path) + '">' + acEsc(f.name) + '</option>'; });
            html += '</optgroup>';
          }
          sel.innerHTML = html;
          sel.disabled = false;
        } catch (err) {
          sel.innerHTML = '<option value="">Could not load brokers: ' + acEsc(err.message) + '</option>';
        }
      }
      // A named handler instead of an inline getElementById with nested quotes:
      // this HTML is built inside a template literal, so a backslash-escaped
      // quote here is eaten before the browser ever sees it.
      function acPickFile() {
        var f = document.getElementById("ac_file");
        if (f) f.click();
      }
      async function acExtract(inputEl) {
        var f = inputEl.files && inputEl.files[0];
        if (!f) return;
        acFileName = f.name || "agreement.pdf";
        var btn = document.getElementById("ac_upload_btn");
        var box = document.getElementById("ac_review");
        btn.disabled = true;
        btn.textContent = "Reading the agreement...";
        box.style.display = "none";
        try {
          var fd = new FormData();
          fd.append("file", f);
          var resp = await fetch("/admin/clients/extract-agreement", { method: "POST", body: fd, credentials: "same-origin" });
          var data = await resp.json();
          if (!resp.ok || !data.ok) {
            throw new Error((data.code && AC_UNREADABLE[data.code]) || data.error || ("HTTP " + resp.status));
          }
          acRenderReview(data.proposal);
        } catch (err) {
          var e = document.getElementById("addContactError");
          e.textContent = String(err.message || "Could not read that file");
          e.style.display = "block";
        } finally {
          btn.disabled = false;
          btn.textContent = "Choose a different PDF";
          inputEl.value = "";
        }
      }
      function acRenderReview(p) {
        var box = document.getElementById("ac_review");
        var ids = acFilled(p.identity), fees = acFilled(p.fee_terms);
        window.__acProposal = { identity: ids, fees: fees, file: acFileName };
        var html = '';
        if (p.concerns && p.concerns.length) {
          html += '<div style="background:rgba(240,120,0,0.10);border:1px solid #FF7B00;border-radius:6px;padding:10px;margin-bottom:10px;font-size:12px;color:#2B2523;">'
                + '<strong>Read this first</strong>';
          for (var i = 0; i < p.concerns.length; i++) html += '<div style="margin-top:4px;">' + acEsc(p.concerns[i]) + '</div>';
          html += '</div>';
        }
        if (p.dropped_unquoted && p.dropped_unquoted.length) {
          var names = p.dropped_unquoted.map(acLabel).join(", ");
          html += '<div style="background:rgba(240,120,0,0.10);border:1px solid #FF7B00;border-radius:6px;padding:10px;margin-bottom:10px;font-size:12px;color:#2B2523;">'
                + '<strong>Not offered - no quote in the document</strong><div style="margin-top:4px;">' + acEsc(names) + '</div>'
                + '<div style="margin-top:6px;color:#5E5854;">A value that cannot be pointed at in the document is not offered here. Read these off the agreement yourself.</div></div>';
        }
        if (!ids.length && !fees.length) {
          html += '<div style="font-size:13px;color:#5E5854;">Nothing could be read from this file. Enter the details by hand.</div>';
        }
        function rows(list, checked, title, sub) {
          if (!list.length) return '';
          var h = '<div style="font-size:11px;font-weight:600;color:#2B2523;letter-spacing:1px;text-transform:uppercase;margin:10px 0 2px;">' + title + '</div>'
                + '<div style="font-size:12px;color:#5E5854;margin-bottom:6px;">' + sub + '</div>';
          for (var i = 0; i < list.length; i++) {
            var k = list[i][0], c = list[i][1];
            h += '<label style="display:flex;gap:8px;align-items:flex-start;padding:8px;border:1px solid #E8E3DC;border-radius:6px;background:#FFF;margin-bottom:6px;cursor:pointer;">'
               +   '<input type="checkbox" data-ac-field="' + acEsc(k) + '"' + (checked ? ' checked' : '') + ' style="margin-top:3px;">'
               +   '<span style="flex:1;">'
               +     '<span style="display:block;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#5E5854;">' + acEsc(acLabel(k)) + '</span>'
               +     '<span style="display:block;font-size:14px;color:#2B2523;">' + acEsc(acText(c.value)) + '</span>'
               +     '<span style="display:block;font-size:12px;font-style:italic;color:#5E5854;margin-top:3px;">' + acEsc(c.quote) + '</span>'
               +   '</span>'
               + '</label>';
          }
          return h;
        }
        html += rows(ids, true, "Client details", "Ticked ones fill in the form. Untick anything that looks off.");
        html += rows(fees, false, "Fee terms", "Tick each one only after reading it against the quote. Unticked terms are not recorded.");
        if (ids.length || fees.length) {
          html += '<button type="button" onclick="acApply()" style="width:100%;margin-top:8px;padding:9px;background:#FF7B00;color:#1E1B1A;border:2px solid #9C2B1E;border-radius:6px;cursor:pointer;font-weight:700;font-size:12px;letter-spacing:1px;text-transform:uppercase;">Use ticked details</button>';
        }
        box.innerHTML = html;
        box.style.display = "block";
        if (p.suggested_branch && !acBranch) {
          var b = document.querySelector('#ac_branch_row button[data-branch="' + p.suggested_branch + '"]');
          if (b) acSetBranch(b);
        }
      }
      function acApply() {
        var prop = window.__acProposal || { identity: [], fees: [] };
        var box = document.getElementById("ac_review");
        var ticked = {};
        Array.prototype.forEach.call(box.querySelectorAll("input[data-ac-field]"), function (cb) {
          ticked[cb.getAttribute("data-ac-field")] = cb.checked;
        });
        var map = { client_name: "ac_name", client_phone: "ac_phone", client_email: "ac_email", a_number: "ac_anumber" };
        var extra = [], feeLines = [], skipped = 0;
        prop.identity.forEach(function (pair) {
          var k = pair[0], v = acText(pair[1].value);
          if (!ticked[k]) return;
          if (map[k]) { document.getElementById(map[k]).value = v; }
          else { extra.push(acLabel(k) + ": " + v); }
        });
        prop.fees.forEach(function (pair) {
          if (ticked[pair[0]]) feeLines.push(acLabel(pair[0]) + ": " + acText(pair[1].value));
          else skipped++;
        });
        // Whatever has no field of its own goes into the notes, with the file it
        // came from named, so the claim can be traced back to the document.
        var lines = extra.slice();
        if (feeLines.length) { lines.push("", "Fee terms confirmed against " + prop.file + ":"); feeLines.forEach(function (l) { lines.push("  " + l); }); }
        if (skipped > 0) {
          lines.push("", skipped + " of " + prop.fees.length + " fee term(s) in " + prop.file
            + " were not confirmed and are not recorded here. Read them off the agreement.");
        }
        if (lines.length) {
          var ta = document.getElementById("ac_notes");
          ta.value = (ta.value.trim() ? ta.value.trim() + "\\n\\n" : "") + lines.join("\\n");
        }
        box.innerHTML = '<div style="font-size:13px;color:#5E5854;">Read from ' + acEsc(prop.file) + '. Check the fields above before saving.</div>';
      }
      // Provisioning stopped short. The client exists; only the filing is open.
      // Either nobody said immigration or civil, or folders turned up that might
      // already BE this client - and creating a second one is how a client ends
      // up with two folders, the empty one being the one everybody finds first.
      function acFolderPrompt(key, name, folder) {
        var back = document.createElement("div");
        back.id = "acFolderBackdrop";
        back.style.cssText = "position:fixed;inset:0;background:rgba(26,16,8,0.55);z-index:9998;display:flex;align-items:center;justify-content:center;padding:20px;";
        var cands = folder.candidates || [];
        var branch = folder.branch || acBranch || null;
        var html = '<div style="background:#FAF8F5;border-radius:12px;padding:24px;max-width:560px;width:100%;max-height:80vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,0.4),0 0 0 1.5px #A34C00;">'
          + '<h2 style="margin:0 0 6px 0;font-family:Montserrat,sans-serif;color:#2B2523;letter-spacing:2px;text-transform:uppercase;font-size:17px;">Where does ' + acEsc(name) + ' go?</h2>'
          + '<p style="margin:0 0 14px 0;font-size:13px;color:#5E5854;">' + acEsc(name) + ' is saved. '
          + (folder.action === "needs_branch"
              ? 'The practice area was never set, so no folder was created yet.'
              : 'Folders that might already be this client turned up, so nothing was created yet.')
          + '</p>'
          + '<div id="acf_err" style="display:none;background:rgba(160,40,24,0.10);color:#9C2B1E;padding:9px 11px;border-radius:6px;border:1px solid #9C2B1E;margin-bottom:10px;font-size:13px;"></div>'
          + '<div style="font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#2B2523;margin-bottom:6px;">Practice area</div>'
          + '<div id="acf_branch">'
          +   '<button type="button" data-branch="immigration" onclick="acfSetBranch(this)" style="padding:7px 16px;border:1px solid #E8E3DC;border-radius:999px;background:#FFF;cursor:pointer;font-size:13px;margin-right:8px;">Immigration</button>'
          +   '<button type="button" data-branch="civil" onclick="acfSetBranch(this)" style="padding:7px 16px;border:1px solid #E8E3DC;border-radius:999px;background:#FFF;cursor:pointer;font-size:13px;">Civil</button>'
          + '</div>';
        if (cands.length) {
          html += '<div style="font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#2B2523;margin:14px 0 4px;">Is the client one of these?</div>'
                + '<div style="font-size:12px;color:#5E5854;margin-bottom:8px;">Closest first. Picking one files the client there.</div>';
          for (var i = 0; i < cands.length; i++) {
            html += '<button type="button" onclick="acfAdopt(this)" data-path="' + acEsc(cands[i].path) + '" style="display:block;width:100%;text-align:left;padding:9px 11px;border:1px solid #E8E3DC;border-radius:6px;background:#FFF;margin-bottom:6px;cursor:pointer;">'
                 +   '<span style="display:block;font-weight:600;color:#2B2523;font-size:14px;">' + acEsc(cands[i].name) + '</span>'
                 +   '<span style="display:block;font-size:11px;color:#5E5854;">' + acEsc(cands[i].path) + '</span>'
                 + '</button>';
          }
          html += '<button type="button" onclick="acfCreateNew()" style="width:100%;padding:9px;border:1px solid #E8E3DC;border-radius:6px;background:transparent;color:#5E5854;cursor:pointer;font-size:13px;margin-top:2px;">None of these - create a new folder</button>';
        } else {
          // acfResolve, NOT acfCreateNew: with no candidates on screen nobody has
          // reviewed anything, so the duplicate check must still run.
          html += '<button type="button" onclick="acfResolve()" style="width:100%;margin-top:14px;padding:10px;background:#FF7B00;color:#1E1B1A;border:2px solid #9C2B1E;border-radius:6px;cursor:pointer;font-weight:700;font-size:12px;letter-spacing:1px;text-transform:uppercase;">Find or create the folder</button>';
        }
        html += '<button type="button" onclick="acfSkip()" style="width:100%;margin-top:10px;padding:8px;background:transparent;border:none;color:#5E5854;cursor:pointer;font-size:12px;">Decide later - the client is already saved</button></div>';
        back.innerHTML = html;
        document.body.appendChild(back);
        window.__acf = { key: key, name: name, branch: branch };
        if (branch) {
          var b = back.querySelector('#acf_branch button[data-branch="' + branch + '"]');
          if (b) acfSetBranch(b);
        }
      }
      function acfSetBranch(btn) {
        var want = btn.getAttribute("data-branch");
        window.__acf.branch = (window.__acf.branch === want) ? null : want;
        Array.prototype.forEach.call(document.querySelectorAll("#acf_branch button"), function (b) {
          var on = b.getAttribute("data-branch") === window.__acf.branch;
          b.style.background = on ? "#FF7B00" : "#FFF";
          b.style.color = on ? "#FAF8F5" : "#2B2523";
          b.style.borderColor = on ? "#FF7B00" : "#E8E3DC";
        });
      }
      function acfErr(msg) {
        var e = document.getElementById("acf_err");
        e.textContent = msg; e.style.display = "block";
      }
      async function acfCall(body) {
        if (!window.__acf.branch) return acfErr("Choose immigration or civil first.");
        try {
          body.branch = window.__acf.branch;
          var r = await fetch("/admin/clients/" + encodeURIComponent(window.__acf.key) + "/provision-folder", {
            method: "POST", headers: { "Content-Type": "application/json" },
            credentials: "same-origin", body: JSON.stringify(body)
          });
          var d = await r.json();
          if (!r.ok || !d.ok) throw new Error(d.error || ("HTTP " + r.status));
          if (d.folder && (d.folder.action === "needs_review" || d.folder.action === "needs_branch")) {
            return acfErr(d.folder.reason || "Still needs a decision.");
          }
          acfSkip();
        } catch (err) { acfErr(String(err.message || "Could not create the folder")); }
      }
      function acfAdopt(btn) { acfCall({ adopt_path: btn.getAttribute("data-path") }); }
      // Normal provisioning: adopt a confident match, else offer candidates.
      function acfResolve() { acfCall({}); }
      // Only after a person has seen the candidates and rejected them all.
      function acfCreateNew() { acfCall({ create_new: true }); }
      function acfSkip() {
        var b = document.getElementById("acFolderBackdrop");
        if (b) b.remove();
        location.reload();
      }
      function closeAddContactModal() {
        const b = document.getElementById("addContactBackdrop");
        if (b) b.remove();
      }
      async function submitAddContact() {
        const btn = document.getElementById("ac_submit");
        const errBox = document.getElementById("addContactError");
        errBox.style.display = "none";
        const body = {
          client_name: document.getElementById("ac_name").value.trim(),
          client_phone: document.getElementById("ac_phone").value.trim() || null,
          client_email: document.getElementById("ac_email").value.trim() || null,
          a_number: document.getElementById("ac_anumber").value.trim() || null,
          referral_source: acBrokerName(),
          notes: document.getElementById("ac_notes").value.trim() || null,
          branch: acBranch || undefined,
          broker_folder: (document.getElementById("ac_broker") || {}).value || undefined,
        };
        if (!body.client_name) {
          errBox.textContent = "Client name is required.";
          errBox.style.display = "block";
          return;
        }
        btn.disabled = true;
        btn.textContent = "Saving...";
        try {
          const resp = await fetch("/admin/clients/add-contact", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await resp.json();
          if (!resp.ok || !data.ok) {
            throw new Error(data.error || "Save failed");
          }
          // The client is saved either way. Say what happened to their folder,
          // because "saved" with no folder is how a client ends up with nowhere
          // to put their paper and nobody noticing for a month.
          var f = data.folder;
          if (f && (f.action === "needs_review" || f.action === "needs_branch")) {
            closeAddContactModal();
            acFolderPrompt(data.client.client_key, data.client.client_name, f);
            return;
          }
          if (f && f.path && (f.action === "created" || f.action === "adopted" || f.action === "already_mapped")) {
            // Show where they landed before the list reloads under us.
            errBox.style.cssText = "background:rgba(120,160,90,0.12);color:#2B2523;padding:10px 12px;border-radius:6px;border:1px solid #7B9A4E;margin-bottom:12px;font-size:13px;";
            errBox.textContent = "Saved. Filed at " + f.path;
            errBox.style.display = "block";
            setTimeout(function () { closeAddContactModal(); location.reload(); }, 1600);
            return;
          }
          closeAddContactModal();
          // Reload so the new client appears in the list
          location.reload();
        } catch (err) {
          errBox.textContent = "❌ " + (err.message || "Save failed");
          errBox.style.display = "block";
          btn.disabled = false;
          btn.textContent = "Save Client";
        }
      }

      async function bulkImportDropbox(dryRun) {
        const status = document.getElementById("import-status");
        status.innerHTML = '<span style="color:#5E5854;">⏳ Scanning Dropbox for client folders (this may take 20-90 seconds depending on folder count)…</span>';
        try {
          const url = "/admin/clients/bulk-import-dropbox" + (dryRun ? "?dry=1" : "");
          const resp = await fetch(url, { method: "POST" });
          const data = await resp.json();
          if (!data.ok) {
            status.innerHTML = '<span style="color:#9C2B1E;">❌ ' + (data.error || "Import failed") + '</span>';
            return;
          }
          const label = dryRun ? "Would import" : "✅ Imported";
          const foundList = (data.imported || []).slice(0, 20).map(c =>
            '<li style="font-family:monospace; font-size:12px;">' +
              (c.client_name || "(no name)") + (c.a_number ? " · " + c.a_number : "") +
              '<span style="color:#5E5854;"> — ' + c.dropbox_path + '</span>' +
            '</li>'
          ).join("");
          const more = data.imported.length > 20 ? '<li style="color:#5E5854;">…and ' + (data.imported.length - 20) + ' more</li>' : "";
          status.innerHTML =
            '<div style="background:#F3EFE9; padding:12px; border-radius:4px; border-left:3px solid #A34C00;">' +
              '<strong>' + label + ' ' + data.imported.length + ' clients</strong>' +
              (data.errors && data.errors.length ? '<div style="color:#9C2B1E; font-size:12px; margin-top:4px;">' + data.errors.length + ' errors — check console</div>' : "") +
              '<ul style="margin:8px 0 0 0; padding-left:20px;">' + foundList + more + '</ul>' +
              (!dryRun ? '<div style="margin-top:10px;"><a href="/admin/clients" style="background:#2B2523; color:white; padding:6px 12px; border-radius:4px; text-decoration:none; font-size:13px;">🔄 Reload page to see them</a></div>' : '') +
            '</div>';
        } catch (e) {
          status.innerHTML = '<span style="color:#9C2B1E;">❌ ' + e.message + '</span>';
        }
      }
    </script>`;

  return hearingNotes.renderAdminChrome({
    title: "Client Profiles",
    body,
    activeItem: "clients",
  });
}

function renderClientDetail(client, { documents = [] } = {}) {
  if (!client) {
    const body = `
      <div class="page-header">
        <h1>Client Not Found</h1>
        <a href="/admin/clients" class="back-link">← Back to clients</a>
      </div>
      <p>No client matches that key.</p>`;
    return hearingNotes.renderAdminChrome({ title: "Not Found", body, activeItem: "clients" });
  }

  // Contact quick-actions
  const phone = client.client_phone || "";
  const phoneDigits = phone.replace(/[^\d]/g, "");
  const email = client.client_email || "";
  const contactActions = [];
  if (email) {
    contactActions.push(`<a href="mailto:${escapeAttr(email)}" style="background:#2B2523; color:white; padding:8px 14px; border-radius:4px; text-decoration:none; font-size:13px;">✉️ Email</a>`);
  }
  if (phoneDigits) {
    contactActions.push(`<a href="tel:+${phoneDigits}" style="background:#2B2523; color:white; padding:8px 14px; border-radius:4px; text-decoration:none; font-size:13px;">📞 Call</a>`);
    contactActions.push(`<a href="https://wa.me/${phoneDigits}" target="_blank" rel="noopener" style="background:#25D366; color:#1E1B1A; padding:8px 14px; border-radius:4px; text-decoration:none; font-size:13px;">💬 WhatsApp</a>`);
  }

  // Hearing rows
  const hearingRows = client.hearings.length ? client.hearings.map(h => {
    const kindBadge = h.kind === "individual"
      ? `<span style="background:#2B2523; color:#FF7B00; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:bold;">INDIV</span>`
      : `<span style="background:#A34C00; color:white; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:bold;">MASTER</span>`;
    return `
      <tr>
        <td>${kindBadge}</td>
        <td>${escapeHtml(h.type_label || "-")}</td>
        <td>${storedWhenText(h.hearing_date)}</td>
        <td>${escapeHtml(h.judge_name || "-")}</td>
        <td>${escapeHtml(h.disposition || "-")}</td>
        <td>${h.sent ? "✅" : "—"}</td>
        <td><a href="${h.edit_url}" style="color:#A34C00;">edit</a></td>
      </tr>`;
  }).join("") : `<tr><td colspan="7" style="text-align:center; color:#5E5854;">No hearings recorded.</td></tr>`;

  // Upcoming hearings section
  const upcomingSection = client.upcoming.length ? `
    <div style="background:#FAF8F5; border-left:4px solid #FF7B00; padding:15px; border-radius:4px; margin:15px 0;">
      <h3 style="margin:0 0 8px 0; color:#2B2523;">🗓️ Upcoming Hearings</h3>
      <ul style="margin:0; padding-left:20px;">
        ${client.upcoming.map(u => `<li><strong>${escapeHtml(u.type)}</strong> — ${storedWhenText(u.date)} <span style="color:#5E5854; font-size:12px;">(from ${u.from_kind} note #${u.from_id})</span></li>`).join("")}
      </ul>
    </div>` : "";

  // Quick-create new hearing links.
  //
  // `client` is the key the form routes resolve back into this same
  // aggregate, so the new note opens knowing the name, the A-Number, the
  // contact details, the language, the case type and the judge. See
  // hearing-prefill.js for what is carried and what is deliberately not.
  //
  // prefill_a / prefill_name stay on the link for anything that bookmarked
  // the old shape; the routes accept either.
  const createQuery = `client=${encodeURIComponent(client.key)}` +
    (client.a_number ? `&prefill_a=${encodeURIComponent(client.a_number)}` : "") +
    `&prefill_name=${encodeURIComponent(client.client_name || "")}`;
  const createBtn = "background:#A34C00; color:white; padding:8px 14px; border-radius:4px; text-decoration:none; font-size:13px;";
  const formsBtn = "background:#2B2523; color:white; padding:8px 14px; border-radius:4px; text-decoration:none; font-size:13px;";
  // "Forms" replaces the single "Form G-28" button.
  //
  // "its very weird how each form is being created with each client. So
  // each client portal should be able to pick its own forms individually,
  // not just combo." (JJ, 2026-10-09) One hardcoded form and one package
  // picker was the whole of it: a client needing an I-765 on its own had
  // nowhere to start from. Forms lists every tracked form, shows the ones
  // already started on this file, and the G-28 is reached through it like
  // any other rather than having a button of its own.
  const createLinks = `
      <a href="/admin/hearing/notes?${createQuery}" style="${createBtn}">+ New Master Hearing</a>
      <a href="/admin/hearing/individual?${createQuery}" style="${createBtn}">+ New Individual Hearing</a>
      <a href="/admin/clients/${encodeURIComponent(client.key)}/forms" style="${formsBtn}">Forms</a>
      <a href="/admin/clients/${encodeURIComponent(client.key)}/filing-package" style="${formsBtn}">Filing package</a>`;

  const body = `
    <div class="page-header">
      <h1>${escapeHtml(client.client_name || "(unnamed)")}</h1>
      <a href="/admin/clients" class="back-link">← All clients</a>
    </div>

    <!-- Client info card -->
    <div style="background:white; padding:20px; border-radius:6px; border:1px solid #E8E3DC; margin-bottom:15px;">
      <div style="display:flex; gap:30px; flex-wrap:wrap;">
        <div style="flex:1; min-width:280px;">
          <h3 style="margin:0 0 12px 0; color:#A34C00; font-size:14px; text-transform:uppercase; letter-spacing:0.5px;">Client Info</h3>
          <div style="line-height:1.9;">
            <div><strong>Name:</strong> ${escapeHtml(client.client_name || "-")}</div>
            <div><strong>A-Number:</strong> ${escapeHtml(client.a_number || "-")}</div>
            <div><strong>Email:</strong> ${email ? `<a href="mailto:${escapeAttr(email)}">${escapeHtml(email)}</a>` : "-"}</div>
            <div><strong>Phone:</strong> ${phone ? escapeHtml(phone) : "-"}</div>
            <div><strong>Address:</strong> ${client.client_address ? escapeHtml(client.client_address).replace(/\n/g, "<br>") : "-"}</div>
            ${client.contact_source && client.contact_source !== "manual" ? `
            <div style="font-size:11px; color:#5E5854; font-style:italic;">
              Phone and address read from ${escapeHtml(client.contact_source === "i589" ? "the client's I-589" : client.contact_source)}${client.contact_source_detail ? ` (${escapeHtml(String(client.contact_source_detail).split("/").pop())})` : ""} — not yet confirmed with the client.
            </div>` : ""}
            <div><strong>Language:</strong> ${languageLabel(client.client_language)}</div>

            <!-- Correcting the client's details.
                 Phone and address were the only two editable fields. Email
                 and language were shown and not editable, although
                 client_contacts could already store the email -- so a wrong
                 address could be fixed and a wrong email could not. All
                 four are editable now.
                 Name and A-Number stay read-only on purpose:
                 client-contacts.js WRITABLE explains why. -->
            <details style="margin-top:10px;" ${client.client_phone && client.client_address && client.client_email ? "" : "open"}>
              <summary style="cursor:pointer; font-size:12px; color:#A34C00; font-weight:600;">Edit these details</summary>
              <form method="POST" action="/admin/clients/${escapeAttr(client.key)}/contact"
                    style="margin-top:10px; display:grid; grid-template-columns:auto 1fr; gap:8px 10px; align-items:center; max-width:460px;">
                <label for="cc-phone" style="font-size:12px; color:#5E5854;">Phone</label>
                <input id="cc-phone" type="tel" name="phone" value="${escapeAttr(client.client_phone || "")}" placeholder="626-678-8677"
                       style="padding:6px 8px; border:1px solid #E8E3DC; border-radius:4px; font-size:13px;">

                <label for="cc-email" style="font-size:12px; color:#5E5854;">Email</label>
                <input id="cc-email" type="email" name="email" value="${escapeAttr(client.client_email || "")}" placeholder="name@example.com"
                       style="padding:6px 8px; border:1px solid #E8E3DC; border-radius:4px; font-size:13px;">

                <label for="cc-address" style="font-size:12px; color:#5E5854;">Address</label>
                <input id="cc-address" type="text" name="address" value="${escapeAttr(client.client_address || "")}" placeholder="Street, City, State ZIP"
                       style="padding:6px 8px; border:1px solid #E8E3DC; border-radius:4px; font-size:13px;">

                <label for="cc-language" style="font-size:12px; color:#5E5854;">Language</label>
                <select id="cc-language" name="language"
                        style="padding:6px 8px; border:1px solid #E8E3DC; border-radius:4px; font-size:13px;">
                  <option value="">(as recorded on the hearing notes)</option>
                  ${["en", "zh", "es", "hi", "pa"].map(c => `<option value="${c}"${client.client_language === c ? " selected" : ""}>${escapeHtml(languageLabel(c))}</option>`).join("")}
                </select>

                <span></span>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                  <button type="submit" style="padding:6px 14px; background:#FF7B00; color:#1E1B1A; border:1px solid #9C2B1E; border-radius:4px; cursor:pointer; font-size:13px; font-weight:600;">Save</button>
                  <span style="font-size:11px; color:#5E5854;">Leave a box empty to clear it.</span>
                </div>
              </form>
              <div style="margin-top:8px; font-size:11px; color:#5E5854; line-height:1.5; max-width:460px;">
                The name and the A-Number are what this file is filed under, so they
                are not edited here. ${client.contact_updated_at ? `Last corrected ${escapeHtml(instantDayText(client.contact_updated_at))}.` : ""}
              </div>
            </details>
          </div>
        </div>
        <div style="flex:1; min-width:280px;">
          <h3 style="margin:0 0 12px 0; color:#A34C00; font-size:14px; text-transform:uppercase; letter-spacing:0.5px;">Case Info</h3>
          <div style="line-height:1.9;">
            <div><strong>Case type(s):</strong> ${client.case_types.length ? client.case_types.map(escapeHtml).join(", ") : "-"}</div>
            <div><strong>Judge(s):</strong> ${client.judges.length ? client.judges.map(escapeHtml).join(", ") : "-"}</div>
            <div><strong>Total hearings:</strong> ${client.hearing_count}</div>
            <div><strong>Last activity:</strong> ${storedDayText(client.most_recent_date)}</div>
            <div><strong>Most recent disposition:</strong> ${escapeHtml(client.most_recent_disposition || "-")}</div>
          </div>
        </div>
      </div>
      ${contactActions.length ? `<div style="margin-top:15px; padding-top:15px; border-top:1px solid #E8E3DC; display:flex; gap:8px; flex-wrap:wrap;">${contactActions.join("")}</div>` : ""}
    </div>

    ${upcomingSection}

    <!-- Detected hearing notices from Dropbox scan -->
    <div style="background:white; padding:20px; border-radius:6px; border:1px solid #E8E3DC; margin-bottom:15px;" id="hearing-notices-section">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; flex-wrap:wrap; gap:10px;">
        <h3 style="margin:0; color:#2B2523;">🗓️ Hearing Notices <span id="hn-count" style="color:#5E5854; font-weight:normal; font-size:14px;"></span></h3>
        <button type="button" onclick="scanForNotices()" id="hn-scan-btn" style="background:#2B2523; color:white; padding:8px 14px; border:none; border-radius:4px; cursor:pointer; font-size:13px;">🔍 Scan Dropbox for notices</button>
      </div>
      <div id="hn-status" style="font-size:13px; color:#5E5854; margin-bottom:10px;">Click "Scan Dropbox" to detect hearing notices in this client's folder.</div>
      <div id="hn-list"></div>
    </div>

    <!-- Court email matched to this client — every one, hearing or not -->
    <div style="background:white; padding:20px; border-radius:6px; border:1px solid #E8E3DC; margin-bottom:15px;" id="court-mail-section">
      <h3 style="margin:0 0 12px; color:#2B2523;">📨 Court Mail <span id="cm-count" style="color:#5E5854; font-weight:normal; font-size:14px;"></span></h3>
      <div id="cm-status" style="font-size:13px; color:#5E5854;">Loading…</div>
      <div id="cm-list"></div>
    </div>

    <!-- Voice transcripts (transcripts.js) — drawn by transcripts-page.js -->
    <div style="background:white; padding:4px 20px 12px; border-radius:6px; border:1px solid #E8E3DC; margin-bottom:15px;">
      <div data-transcripts="client" data-client-key="${escapeAttr(client.key)}"></div>
    </div>
    ${require("./client-script").clientScriptTag("transcripts-page.js")}

    <!-- Documents out for e-signature (esign.js) — drawn by /static/esign-admin.js -->
    <div style="background:white; padding:4px 20px 12px; border-radius:6px; border:1px solid #E8E3DC; margin-bottom:15px;">
      <div data-esign="client" data-esign-client="${escapeAttr(client.key)}"></div>
    </div>
    ${require("./client-script").clientScriptTag("esign-admin.js")}

    ${require("./client-documents").renderDocumentsSection({ clientKey: client.key, documents, aNumber: client.a_number })}

    <!-- Dropbox Documents section (lazy-loaded via JS) -->
    <div style="background:white; padding:20px; border-radius:6px; border:1px solid #E8E3DC; margin-bottom:15px;" id="dropbox-section">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; flex-wrap:wrap; gap:10px;">
        <h3 style="margin:0; color:#2B2523;">📦 Dropbox <span id="dbx-count" style="color:#5E5854; font-weight:normal;"></span></h3>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button type="button" onclick="dbxToggleUpload()" id="dbx-upload-btn" style="background:#2B2523; color:white; padding:8px 14px; border:none; border-radius:4px; cursor:pointer; font-size:13px; display:none;">+ Upload to Dropbox</button>
          <button type="button" onclick="dbxChangeFolder()" style="background:#F3EFE9; color:#2B2523; padding:8px 14px; border:none; border-radius:4px; cursor:pointer; font-size:13px;">📁 Change folder</button>
          <button type="button" onclick="dbxRefresh(true)" style="background:#F3EFE9; color:#2B2523; padding:8px 14px; border:none; border-radius:4px; cursor:pointer; font-size:13px;">🔄 Refresh</button>
          <a href="/admin/clients/${client.key}/dropbox/debug" style="background:#F3EFE9; color:#2B2523; padding:8px 14px; border:none; border-radius:4px; cursor:pointer; font-size:13px; text-decoration:none;">🔍 Debug</a>
        </div>
      </div>
      <div id="dbx-folder-info" style="font-size:12px; color:#5E5854; margin-bottom:10px;"></div>

      <!-- Upload form (hidden) -->
      <div id="dbx-upload-form" style="display:none; background:#F3EFE9; padding:15px; border-radius:4px; margin-bottom:12px; border:1px dashed #A34C00;">
        <div id="dbx-dropzone"
             ondragover="dbxDragOver(event)" ondragleave="dbxDragLeave(event)" ondrop="dbxDropFile(event)"
             onclick="document.getElementById('dbx-file-input').click()"
             style="border:2px dashed #A34C00; padding:20px; border-radius:6px; text-align:center; background:white; margin-bottom:12px; cursor:pointer;">
          <div style="font-size:36px; margin-bottom:8px;">📦</div>
          <div><strong>Drop a file here or click to browse</strong></div>
          <div style="font-size:12px; color:#5E5854; margin-top:4px;">Uploads directly to this client's Dropbox folder. Max 25 MB.</div>
          <input type="file" id="dbx-file-input" style="display:none;" onchange="dbxHandleFileSelected(this.files[0])">
          <div id="dbx-selected" style="margin-top:8px; font-size:13px; color:#2B2523;"></div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <button type="button" onclick="dbxUpload()" id="dbx-upload-do-btn" style="background:#2B2523; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">📤 Upload to Dropbox</button>
          <button type="button" onclick="dbxToggleUpload()" style="background:#F3EFE9; color:#2B2523; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Cancel</button>
          <span id="dbx-upload-status" style="font-size:13px;"></span>
        </div>
      </div>

      <div id="dbx-status" style="padding:20px; text-align:center; color:#5E5854;">Loading Dropbox files…</div>
      <div id="dbx-files" style="display:none;">
        <table style="width:100%; font-size:13px;">
          <thead>
            <tr style="border-bottom:1px solid #E8E3DC;">
              <th></th>
              <th style="text-align:left;">Filename</th>
              <th style="text-align:left;">Size</th>
              <th style="text-align:left;">Modified</th>
              <th style="text-align:left;">Actions</th>
            </tr>
          </thead>
          <tbody id="dbx-tbody"></tbody>
        </table>
      </div>
    </div>

    <script>
      const DBX_CLIENT_KEY = ${JSON.stringify(client.key)};
      let dbxSelectedFile = null;

      function dbxIconFor(name) {
        const n = (name || "").toLowerCase();
        if (n.endsWith(".pdf")) return "📄";
        if (/\\.(jpg|jpeg|png|gif|webp|heic)$/.test(n)) return "🖼️";
        if (/\\.(docx?|txt|md|rtf)$/.test(n)) return "📝";
        if (/\\.(xlsx?|csv)$/.test(n)) return "📊";
        if (/\\.(mp4|mov|avi)$/.test(n)) return "🎬";
        if (/\\.(mp3|wav|m4a)$/.test(n)) return "🎵";
        if (/\\.(zip|rar|7z)$/.test(n)) return "🗜️";
        return "📎";
      }
      function dbxFmtSize(n) {
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
        return (n / 1024 / 1024).toFixed(1) + " MB";
      }
      function dbxEscape(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

      async function dbxRefresh(fresh) {
        const status = document.getElementById("dbx-status");
        const filesDiv = document.getElementById("dbx-files");
        const countEl = document.getElementById("dbx-count");
        const folderInfo = document.getElementById("dbx-folder-info");
        const uploadBtn = document.getElementById("dbx-upload-btn");
        status.style.display = "";
        status.textContent = "Loading Dropbox files…";
        filesDiv.style.display = "none";
        try {
          const resp = await fetch("/admin/clients/" + encodeURIComponent(DBX_CLIENT_KEY) + "/dropbox/files" + (fresh ? "?fresh=1" : ""));
          const data = await resp.json();
          if (!data.ok) {
            status.innerHTML = '<span style="color:#9C2B1E;">❌ ' + dbxEscape(data.error || "Failed to load") + '</span>' +
              (data.error && data.error.includes("not authorized") ? '<br><br><a href="/admin/dropbox/setup" style="color:#A34C00;">→ Connect Dropbox first</a>' : "");
            return;
          }
          if (!data.resolved || !data.folder) {
            let suggHtml = '';
            const suggestions = data.suggestions || [];
            if (suggestions.length) {
              suggHtml = '<div style="margin-top:15px; text-align:left; max-width:520px; margin-left:auto; margin-right:auto;">' +
                '<div style="font-weight:600; margin-bottom:8px; color:#2B2523;">💡 Did you mean one of these?</div>' +
                suggestions.map(function(s) {
                  const reason = s.reason ? '<span style="color:#5E5854; font-size:11px; margin-left:6px;">(' + dbxEscape(s.reason) + ')</span>' : '';
                  const escapedPath = JSON.stringify(s.path).replace(/"/g,"&quot;");
                  return '<div style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; background:#FAF8F5; border-radius:4px; margin-bottom:4px;">' +
                    '<div style="font-family:monospace; font-size:12px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + dbxEscape(s.path) + reason + '</div>' +
                    '<button type="button" onclick="dbxUseSuggestion(' + escapedPath + '); return false;" style="background:#2B2523; color:white; border:none; padding:4px 10px; border-radius:3px; cursor:pointer; font-size:12px; margin-left:8px; flex-shrink:0;">Use this</button>' +
                    '</div>';
                }).join('') +
                '<div style="margin-top:10px; text-align:center;"><button type="button" onclick="dbxChangeFolder()" style="background:#F3EFE9; color:#2B2523; padding:8px 14px; border:none; border-radius:4px; cursor:pointer; font-size:13px;">Or enter folder path manually</button></div>' +
                '</div>';
            } else {
              suggHtml = '<div style="margin-top:15px;"><button type="button" onclick="dbxChangeFolder()" style="background:#2B2523; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Set folder manually</button></div>';
            }
            status.innerHTML = '<span style="color:#A34C00;">⚠️ No exact match found for this client in configured branches.</span><br>' +
              '<span style="font-size:12px; color:#5E5854;">Searched for "' +
              dbxEscape(${JSON.stringify(client.client_name || "")}) + '"' +
              (${JSON.stringify(client.a_number || "")} ? ' / A#' + dbxEscape(${JSON.stringify(client.a_number || "")}) : "") +
              '</span>' + suggHtml;
            countEl.textContent = "";
            uploadBtn.style.display = "none";
            return;
          }
          folderInfo.innerHTML = '📁 <code>' + dbxEscape(data.folder) + '</code>' + (data.cached ? ' <span style="color:#5E5854;">(cached)</span>' : '');
          countEl.textContent = "(" + (data.files || []).length + ")";
          uploadBtn.style.display = "";
          if (data.folder_missing) {
            status.innerHTML = '<span style="color:#A34C00;">⚠️ Folder path is stored but doesn\\'t exist in Dropbox: ' + dbxEscape(data.folder) + '</span>';
            return;
          }
          const files = data.files || [];
          if (!files.length) {
            status.innerHTML = '<span style="color:#5E5854;">Folder is empty. Upload to add files.</span>';
            return;
          }
          // Render files
          const tbody = document.getElementById("dbx-tbody");
          tbody.innerHTML = files.map(f =>
            '<tr>' +
              '<td style="width:30px; text-align:center; font-size:18px;">' + dbxIconFor(f.name) + '</td>' +
              '<td><a href="/admin/clients/' + encodeURIComponent(DBX_CLIENT_KEY) + '/dropbox/download?path=' + encodeURIComponent(f.path) + '" target="_blank" style="color:#2B2523; text-decoration:none; font-weight:600;">' + dbxEscape(f.name) + '</a></td>' +
              '<td style="font-size:12px; color:#5E5854; white-space:nowrap;">' + dbxFmtSize(f.size) + '</td>' +
              '<td style="font-size:12px; color:#5E5854; white-space:nowrap;">' + (f.server_modified ? new Date(f.server_modified).toLocaleDateString() : "-") + '</td>' +
              '<td style="white-space:nowrap;">' +
                '<a href="/admin/clients/' + encodeURIComponent(DBX_CLIENT_KEY) + '/dropbox/download?path=' + encodeURIComponent(f.path) + '" target="_blank" style="color:#A34C00; font-size:13px;">📥</a>' +
                ' &nbsp; ' +
                '<a href="#" onclick="dbxDelete(' + JSON.stringify(f.path).replace(/"/g,"&quot;") + ', ' + JSON.stringify(f.name).replace(/"/g,"&quot;") + '); return false;" style="color:#9C2B1E; font-size:13px;">🗑️</a>' +
              '</td>' +
            '</tr>'
          ).join("");
          status.style.display = "none";
          filesDiv.style.display = "";
        } catch (e) {
          status.innerHTML = '<span style="color:#9C2B1E;">❌ ' + dbxEscape(e.message) + '</span>';
        }
      }

      function dbxToggleUpload() {
        const f = document.getElementById("dbx-upload-form");
        f.style.display = f.style.display === "none" ? "block" : "none";
        if (f.style.display === "none") {
          dbxSelectedFile = null;
          document.getElementById("dbx-file-input").value = "";
          document.getElementById("dbx-selected").textContent = "";
          document.getElementById("dbx-upload-status").textContent = "";
        }
      }
      function dbxHandleFileSelected(file) {
        if (!file) return;
        dbxSelectedFile = file;
        const sizeMB = (file.size / 1024 / 1024).toFixed(1);
        document.getElementById("dbx-selected").textContent = "✓ " + file.name + " (" + sizeMB + " MB)";
        if (file.size > 25 * 1024 * 1024) {
          document.getElementById("dbx-selected").innerHTML += ' <span style="color:#9C2B1E;">— exceeds 25MB limit</span>';
        }
      }
      function dbxDragOver(e) { e.preventDefault(); e.stopPropagation(); document.getElementById("dbx-dropzone").style.background = "#F3EFE9"; }
      function dbxDragLeave(e) { e.preventDefault(); e.stopPropagation(); document.getElementById("dbx-dropzone").style.background = "white"; }
      function dbxDropFile(e) {
        e.preventDefault(); e.stopPropagation();
        document.getElementById("dbx-dropzone").style.background = "white";
        if (e.dataTransfer.files[0]) dbxHandleFileSelected(e.dataTransfer.files[0]);
      }
      async function dbxUpload() {
        if (!dbxSelectedFile) { alert("Choose a file first"); return; }
        if (dbxSelectedFile.size > 25 * 1024 * 1024) { alert("File exceeds 25MB limit"); return; }
        const btn = document.getElementById("dbx-upload-do-btn");
        const status = document.getElementById("dbx-upload-status");
        btn.disabled = true;
        status.textContent = "⏳ Uploading to Dropbox...";
        status.style.color = "#5E5854";
        try {
          const fd = new FormData();
          const safeName = dbxSelectedFile.name.replace(/[^\\w.\\-]/g, "_");
          const fileForUpload = safeName !== dbxSelectedFile.name
            ? new File([dbxSelectedFile], safeName, { type: dbxSelectedFile.type })
            : dbxSelectedFile;
          fd.append("file", fileForUpload);
          fd.append("original_filename", dbxSelectedFile.name);
          const resp = await fetch("/admin/clients/" + encodeURIComponent(DBX_CLIENT_KEY) + "/dropbox/upload", { method: "POST", body: fd });
          const data = await resp.json();
          if (data.ok) {
            status.textContent = "✅ Uploaded";
            status.style.color = "#2F6B3F";
            setTimeout(() => { dbxToggleUpload(); dbxRefresh(true); }, 700);
          } else {
            btn.disabled = false;
            status.textContent = "❌ " + (data.error || "Upload failed");
            status.style.color = "#9C2B1E";
          }
        } catch (e) {
          btn.disabled = false;
          status.textContent = "❌ " + e.message;
          status.style.color = "#9C2B1E";
        }
      }
      async function dbxDelete(path, name) {
        if (!confirm("Delete " + name + " from Dropbox?\\n\\nThis DELETES the actual file in Dropbox. It cannot be undone.")) return;
        try {
          const resp = await fetch("/admin/clients/" + encodeURIComponent(DBX_CLIENT_KEY) + "/dropbox/delete", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "path=" + encodeURIComponent(path),
          });
          const data = await resp.json();
          if (data.ok) dbxRefresh(true);
          else alert("❌ " + (data.error || "Delete failed"));
        } catch (e) { alert("❌ " + e.message); }
      }
      async function dbxChangeFolder() {
        const currentPath = document.getElementById("dbx-folder-info").textContent.trim().replace(/^📁\\s*/, "").replace(/\\s*\\(cached\\)$/, "");
        const newPath = prompt("Enter the full Dropbox folder path for this client:\\n\\nExample: /ASYLUM_EOIR/Kong Xiangmin\\n\\nLeave blank to clear and re-auto-detect on next load.", currentPath || "");
        if (newPath === null) return;
        try {
          const resp = await fetch("/admin/clients/" + encodeURIComponent(DBX_CLIENT_KEY) + "/dropbox/mapping", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "path=" + encodeURIComponent(newPath.trim()),
          });
          const data = await resp.json();
          if (data.ok) dbxRefresh(true);
          else alert("❌ " + (data.error || "Failed"));
        } catch (e) { alert("❌ " + e.message); }
      }

      // Save a suggested folder as this client's Dropbox mapping (one-click "Use this")
      async function dbxUseSuggestion(path) {
        try {
          const resp = await fetch("/admin/clients/" + encodeURIComponent(DBX_CLIENT_KEY) + "/dropbox/mapping", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "path=" + encodeURIComponent(path),
          });
          const data = await resp.json();
          if (data.ok) dbxRefresh(true);
          else alert("❌ " + (data.error || "Failed to set folder"));
        } catch (e) { alert("❌ " + e.message); }
      }

      // Load on page ready
      dbxRefresh(false);

      // ── Court Mail ─────────────────────────────────────
      // Every court email matched to this client. An eFiling receipt with no
      // hearing and no attachment still belongs on the record.
      async function loadCourtMail() {
        const status = document.getElementById("cm-status");
        const list = document.getElementById("cm-list");
        const count = document.getElementById("cm-count");
        try {
          const resp = await fetch("/admin/clients/" + encodeURIComponent(DBX_CLIENT_KEY) + "/court-mail");
          const data = await resp.json();
          if (!data.ok) { status.textContent = data.error || "Could not load court mail."; return; }
          const mail = data.mail || [];
          count.textContent = mail.length ? "(" + mail.length + ")" : "";
          if (!mail.length) {
            status.textContent = "No court email has been matched to this client yet.";
            list.innerHTML = "";
            return;
          }
          status.style.display = "none";
          list.innerHTML = mail.map(function (m) {
            var when = m.received_at ? new Date(m.received_at) : null;
            var dateStr = when && !isNaN(when)
              ? when.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
              : "";
            var kind = m.kind
              ? '<span style="background:#F3EFE9; color:#2B2523; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600;">' + dbxEscape(m.kind) + '</span>'
              : "";
            var docs = (m.documents || []).length
              ? '<div style="margin-top:6px; font-size:12px; color:#5E5854;">📎 ' +
                (m.documents || []).map(function (d) { return dbxEscape(d.label || d.path || "document"); }).join("<br>📎 ") +
                '</div>'
              : '<div style="margin-top:6px; font-size:12px; color:#5E5854;">No attachment — the email itself was filed.</div>';
            var dated = (m.hearings || []).concat(m.deadlines || []);
            var datedHtml = dated.length
              ? '<div style="margin-top:6px; font-size:12px; color:#2F6B3F;">🗓️ ' + dated.map(dbxEscape).join(" · ") + '</div>'
              : "";
            var todo = (m.action_items || []).length
              ? '<div style="margin-top:6px; font-size:12px; color:#7A3900;">To do: ' +
                (m.action_items || []).map(dbxEscape).join("; ") + '</div>'
              : "";
            var needs = m.status === "needs_review"
              ? '<span style="background:#FFF3E6; color:#A34C00; padding:2px 6px; border-radius:8px; font-size:10px; margin-left:4px;">needs review</span>'
              : "";
            return '<div style="border-left:4px solid #2B2523; background:#FAF8F5; padding:12px; border-radius:4px; margin-bottom:8px;">' +
              '<div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:flex-start;">' +
                '<div style="font-weight:600; color:#2B2523; flex:1; min-width:200px;">' + dbxEscape(m.title) + needs + '</div>' +
                '<div style="font-size:12px; color:#5E5854; white-space:nowrap;">' + dateStr + ' ' + kind + '</div>' +
              '</div>' +
              (m.summary ? '<div style="margin-top:6px; font-size:13px; color:#2B2523; line-height:1.5;">' + dbxEscape(m.summary) + '</div>' : "") +
              datedHtml + docs + todo +
              '<div style="margin-top:8px;"><a href="' + dbxEscape(m.url) + '" style="font-size:12px; color:#A34C00; font-weight:600; text-decoration:none;">Open in Court Mail →</a></div>' +
            '</div>';
          }).join("");
        } catch (e) {
          status.textContent = "Could not load court mail.";
        }
      }
      loadCourtMail();

      // ── Hearing Notices ────────────────────────────────
      async function loadHearingNotices() {
        try {
          const resp = await fetch("/admin/clients/" + encodeURIComponent(DBX_CLIENT_KEY) + "/hearing-notices");
          const data = await resp.json();
          if (!data.ok) return;
          renderNotices(data.notices || []);
        } catch (e) { /* silent */ }
      }
      // A notice's date and time, stated the way the rest of the firm's
      // code states them.
      //
      // THE BUG THIS REPLACES. This panel called
      // toLocaleString(undefined, ...) with hour and minute. Two faults in
      // one line:
      //
      //   1. It rendered in the VIEWER'S zone. A notice's hearing_date is
      //      stored as the date and time printed on the notice with no
      //      zone, and every other reader -- court-calendar.js storedDay(),
      //      hearing-when.js, client-record.js -- reads it back in UTC and
      //      never converts it. Converting it to Pacific moved every
      //      hearing seven hours earlier: Pan, Ping's 10:00 AM individual
      //      hearing showed as "3:00 AM", and a notice with no time at all
      //      (stored at midnight) showed on the day BEFORE the hearing.
      //
      //   2. It computed the time from the timestamp instead of quoting
      //      hearing_time_text, which holds the notice's own words. That is
      //      the rule hearing-when.js exists to enforce: never compute a
      //      hearing time, quote it, because an invented time sends a
      //      client to court on the wrong morning.
      //
      // So: date in UTC, time quoted. This is the browser copy of
      // court-calendar.js's storedDay/storedTime, and it has to stay in
      // step with them.
      function noticeDay(v) {
        const d = v ? new Date(v) : null;
        if (!d || isNaN(d)) return "";
        return d.toLocaleDateString("en-US", {
          timeZone: "UTC", weekday: "short", year: "numeric",
          month: "short", day: "numeric",
        });
      }
      // The notice's own time text, in the wording the notices use.
      // "10:00" and "08:30" are unambiguously 24-hour and convert. A
      // one-digit "9:00" does NOT: it is 9 AM or 9 PM depending on the
      // notice, and picking one is exactly the guess that once told a
      // client noon for a 9:00 AM custody hearing. It is refused, and the
      // timestamp is used instead.
      function noticeTime(n) {
        const s = String(n.hearing_time_text || "").trim();
        // DOUBLED BACKSLASHES ON PURPOSE. This whole script is inside a
        // template literal in client-profiles.js, and a template literal
        // eats an unrecognised escape: a single \d reaches the browser as
        // a bare "d", so /^(\d{1,2})/ arrives as /^(d{1,2})/ and matches
        // nothing. check-notice-when.js pulls these functions out of the
        // SERVED page for exactly this reason.
        let m = s.match(/^(\\d{1,2})(?::(\\d{2}))?\\s*([ap])\\.?m\\.?$/i);
        if (m) {
          const h = parseInt(m[1], 10), mi = m[2] ? parseInt(m[2], 10) : 0;
          if (h >= 1 && h <= 12 && mi <= 59) {
            return h + ":" + String(mi).padStart(2, "0") + " " +
              (m[3].toLowerCase() === "a" ? "AM" : "PM");
          }
        }
        m = s.match(/^([01]\\d|2[0-3]):([0-5]\\d)$/);
        if (m) {
          const H = parseInt(m[1], 10);
          return (H % 12 || 12) + ":" + m[2] + " " + (H < 12 ? "AM" : "PM");
        }
        // No usable text. Fall back to the stored instant, read in UTC the
        // way it was written. Midnight means no time was on the notice.
        const d = n.hearing_date ? new Date(n.hearing_date) : null;
        if (!d || isNaN(d)) return null;
        if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return null;
        const h = d.getUTCHours();
        return (h % 12 || 12) + ":" + String(d.getUTCMinutes()).padStart(2, "0") +
          " " + (h < 12 ? "AM" : "PM");
      }
      function noticeWhen(n) {
        const day = noticeDay(n.hearing_date);
        if (!day) return "(date not confirmed)";
        const t = noticeTime(n);
        return t ? day + " at " + t : day + " \u2014 time not confirmed";
      }

      function renderNotices(notices) {
        const list = document.getElementById("hn-list");
        const count = document.getElementById("hn-count");
        const status = document.getElementById("hn-status");
        count.textContent = notices.length ? "(" + notices.length + ")" : "";
        if (!notices.length) {
          list.innerHTML = "";
          return;
        }
        status.style.display = "none";
        list.innerHTML = notices.map(n => {
          const dateStr = noticeWhen(n);
          const noticeTypeBadge = n.notice_type
            ? '<span style="background:#FAF8F5; color:#A34C00; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600;">' + dbxEscape(n.notice_type) + '</span>'
            : "";
          const confidenceBadge = n.confidence === "low"
            ? '<span style="background:#FFF3E6; color:#A34C00; padding:2px 6px; border-radius:8px; font-size:10px; margin-left:4px;">low confidence — verify</span>'
            : "";
          const notifiedBadge = n.notified_at
            ? '<span style="background:#EEF5EF; color:#2F6B3F; padding:2px 6px; border-radius:8px; font-size:10px; margin-left:4px;">✓ notified ' + new Date(n.notified_at).toLocaleDateString() + '</span>'
            : "";
          const links = n.contact_links || {};
          const btn = (href, channel, label, color) => href
            ? '<a href="' + href + '" target="_blank" rel="noopener" onclick="markNotified(' + n.id + ', \\'' + channel + '\\')" style="background:' + color + '; color:white; padding:6px 12px; border-radius:4px; text-decoration:none; font-size:12px; margin-right:4px;">' + label + '</a>'
            : '<span style="background:#F3EFE9; color:#5E5854; padding:6px 12px; border-radius:4px; font-size:12px; margin-right:4px;">' + label + ' (no contact)</span>';
          return '<div style="border-left:4px solid #FF7B00; background:#FAF8F5; padding:12px; border-radius:4px; margin-bottom:8px;">' +
            '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">' +
              '<div style="flex:1; min-width:250px;">' +
                '<div style="font-size:15px; font-weight:600; color:#2B2523;">' + dbxEscape(dateStr) + '</div>' +
                '<div style="margin-top:4px; font-size:13px; color:#2B2523;">' + noticeTypeBadge + confidenceBadge + notifiedBadge + '</div>' +
                (n.court_name ? '<div style="font-size:12px; color:#5E5854; margin-top:4px;">📍 ' + dbxEscape(n.court_name) + '</div>' : "") +
                (n.court_address ? '<div style="font-size:12px; color:#5E5854;">📌 ' + dbxEscape(n.court_address) + '</div>' : "") +
                (n.judge_name ? '<div style="font-size:12px; color:#5E5854;">⚖️ ' + dbxEscape(n.judge_name) + '</div>' : "") +
              '</div>' +
              '<div style="display:flex; gap:4px; flex-wrap:wrap;">' +
                btn(links.email,     "email",    "✉️ Email",      "#2B2523") +
                btn(links.whatsapp,  "whatsapp", "💬 WhatsApp",    "#25D366") +
                btn(links.sms,       "sms",      "📱 SMS",         "#A34C00") +
                '<button type="button" onclick="dismissNotice(' + n.id + ')" title="Dismiss (hide this notice)" style="background:#F3EFE9; color:#5E5854; padding:6px 10px; border:none; border-radius:4px; cursor:pointer; font-size:12px;">✕</button>' +
              '</div>' +
            '</div>' +
          '</div>';
        }).join("");
      }
      async function scanForNotices() {
        const btn = document.getElementById("hn-scan-btn");
        const status = document.getElementById("hn-status");
        btn.disabled = true;
        btn.textContent = "⏳ Scanning...";
        status.style.display = "";
        status.textContent = "Scanning Dropbox files for hearing notices (this can take 30-90 seconds)...";
        try {
          const resp = await fetch("/admin/clients/" + encodeURIComponent(DBX_CLIENT_KEY) + "/hearing-notices/scan", { method: "POST" });
          const data = await resp.json();
          if (data.ok) {
            const foundCount = (data.notices || []).length;
            status.textContent = "✅ Scanned " + (data.scanned || 0) + " new file(s), skipped " + (data.skipped || 0) + " already-scanned, found " + foundCount + " new notice(s)";
            await loadHearingNotices();
          } else {
            status.innerHTML = '<span style="color:#9C2B1E;">❌ ' + dbxEscape(data.error || "Scan failed") + '</span>';
          }
        } catch (e) {
          status.innerHTML = '<span style="color:#9C2B1E;">❌ ' + dbxEscape(e.message) + '</span>';
        } finally {
          btn.disabled = false;
          btn.textContent = "🔍 Scan Dropbox for notices";
        }
      }
      async function markNotified(id, channel) {
        try {
          await fetch("/admin/clients/" + encodeURIComponent(DBX_CLIENT_KEY) + "/hearing-notices/" + id + "/notified", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "channel=" + encodeURIComponent(channel),
          });
          // Refresh notices to show notified badge (small delay so link opens first)
          setTimeout(loadHearingNotices, 500);
        } catch (e) { /* silent */ }
      }
      async function dismissNotice(id) {
        if (!confirm("Dismiss this notice? (You can re-scan later to bring it back.)")) return;
        try {
          await fetch("/admin/clients/" + encodeURIComponent(DBX_CLIENT_KEY) + "/hearing-notices/" + id + "/dismiss", { method: "POST" });
          loadHearingNotices();
        } catch (e) { /* silent */ }
      }
      loadHearingNotices();
    </script>

    <!-- Hearings history -->
    <div style="background:white; padding:20px; border-radius:6px; border:1px solid #E8E3DC; margin-bottom:15px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; flex-wrap:wrap; gap:10px;">
        <h3 style="margin:0; color:#2B2523;">📚 All Hearings (${client.hearing_count})</h3>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">${createLinks}</div>
      </div>
      <table style="width:100%;">
        <thead>
          <tr>
            <th style="width:80px;"></th>
            <th>Type</th>
            <th>Date</th>
            <th>Judge</th>
            <th>Disposition</th>
            <th style="width:50px;">Sent</th>
            <th style="width:60px;"></th>
          </tr>
        </thead>
        <tbody>${hearingRows}</tbody>
      </table>
    </div>`;

  return hearingNotes.renderAdminChrome({
    title: `Client: ${client.client_name || client.key}`,
    body,
    activeItem: "clients",
  });
}

// ── Searching for a client ───────────────────────────────
//
// JJ: "i should be able to search client based on their A# and name with
// comma or no comma."
//
// Folders are named "WANG, BAOHONG", so the stored name is "Wang, Baohong".
// A plain substring search on that fails for "wang baohong" and for
// "baohong wang" — the comma and the word order both get in the way, and
// nobody types a client's name the way the folder spells it.
//
// So: split what was typed into words, and keep a client when EVERY word
// appears at the start of one of their name's words, in any order.
// Punctuation is ignored on both sides.
//
//   "baohong"       → Wang, Baohong          (one word, matches)
//   "wang baohong"  → Wang, Baohong          (both words, any order)
//   "baohong wang"  → Wang, Baohong          (order does not matter)
//   "wang, baohong" → Wang, Baohong          (the comma is ignored)
//   "bao"           → Wang, Baohong          (prefixes count)
//   "wang b"        → Wang, Baohong          (and initials)
//
// Digits are read as an A-number and matched against the client's, which
// is how a notice quoting "236-564-456" finds its client. Four digits or
// more, so a stray "1" does not match half the firm.
//
// The rules themselves live in client-search.js, which touches no database,
// so anything holding a list of clients searches it the same way.
const CS = require("./client-search");

async function searchClients(q, limit = 8) {
  return CS.rankClients(await aggregateClients(), q, limit);
}

// ── Exports ──────────────────────────────────────────────

module.exports = {
  aggregateClients,
  searchClients,
  nameWords: CS.nameWords,
  matchesQuery: CS.matchesQuery,
  getClientByKey,
  clientKey,
  renderClientList,
  renderClientDetail,
};
