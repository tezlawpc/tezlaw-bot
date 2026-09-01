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
             judge_name, court_location, disposition, sent_to_paralegal_at, created_at
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
      court_location: row.court_location || null,
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
      ? `<span style="background:#B79C62; color:white; padding:2px 8px; border-radius:10px; font-size:11px;">Next: ${escapeHtml(c.upcoming[0].type)} ${new Date(c.upcoming[0].date).toLocaleDateString()}</span>`
      : "";
    const sourceTag = c.dropbox_only
      ? `<span style="background:#0061FF; color:white; padding:2px 6px; border-radius:8px; font-size:10px; margin-left:4px;" title="Imported from Dropbox — no hearings recorded yet">📦 Dropbox</span>`
      : "";
    const brokerCell = c.broker
      ? `<span style="color:#B79C62; font-weight:600; font-size:12px;">🤝 ${escapeHtml(c.broker)}</span>`
      : `<span style="color:#ccc;">—</span>`;
    return `
    <tr class="c-row"
        data-name="${escapeAttr((c.client_name || "").toLowerCase())}"
        data-anumber="${escapeAttr((c.a_number || "").toLowerCase().replace(/[-\s]/g, ""))}"
        data-email="${escapeAttr((c.client_email || "").toLowerCase())}"
        data-lang="${escapeAttr(c.client_language || "")}"
        data-hasupcoming="${c.upcoming.length ? "yes" : "no"}"
        data-casetypes="${escapeAttr(c.case_types.join(" | ").toLowerCase())}"
        data-broker="${escapeAttr((c.broker || "").toLowerCase())}"
        data-source="${c.dropbox_only ? "dropbox" : "hearings"}">
      <td><a href="/admin/clients/${c.key}" style="color:#B79C62; font-weight:600;">${escapeHtml(c.client_name || "(unnamed)")}</a>${sourceTag}</td>
      <td>${escapeHtml(c.a_number || "")}</td>
      <td>${escapeHtml(c.case_types.slice(0, 2).join(", ") || "-")}${c.case_types.length > 2 ? " +" + (c.case_types.length - 2) : ""}</td>
      <td>${c.hearing_count}</td>
      <td>${c.most_recent_date ? new Date(c.most_recent_date).toLocaleDateString() : "-"}</td>
      <td>${languageLabel(c.client_language)}</td>
      <td>${nextUp}</td>
      <td>${brokerCell}</td>
      <td><a href="/admin/clients/${c.key}" style="color:#0C1C36;">view →</a></td>
    </tr>`;
  }).join("") : `<tr><td colspan="9" style="text-align:center; color:#888;">No clients yet. Create a hearing note or bulk import from Dropbox to populate this list.</td></tr>`;

  const totalUpcoming = clients.filter(c => c.upcoming.length).length;
  const totalDropboxOnly = clients.filter(c => c.dropbox_only).length;

  const body = `
    <div class="page-header">
      <h1>👥 Client Profiles</h1>
      <div style="font-size:13px; color:#666;">${clients.length} clients · ${totalUpcoming} with upcoming hearings${totalDropboxOnly ? ` · ${totalDropboxOnly} from Dropbox` : ""}</div>
    </div>

    <div style="background:white; padding:15px; border-radius:4px; margin-bottom:15px; border:1px solid #eee;">
      <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
        <div style="flex:1; min-width:280px;">
          <input type="text" id="search-input" placeholder="🔍 Search by name, A-Number, email, or case type..."
                 onkeyup="filterRows()"
                 style="width:100%; padding:9px 12px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
        </div>
        <div>
          <select id="filter-upcoming" onchange="filterRows()" style="padding:9px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
            <option value="">All clients</option>
            <option value="yes">Has upcoming hearing</option>
            <option value="no">No upcoming hearing</option>
          </select>
        </div>
        <div>
          <select id="filter-lang" onchange="filterRows()" style="padding:9px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
            <option value="">All languages</option>
            <option value="en">English</option>
            <option value="zh">Chinese</option>
            <option value="es">Spanish</option>
            <option value="hi">Hindi</option>
            <option value="pa">Punjabi</option>
          </select>
        </div>
        <div>
          <button type="button" onclick="clearFilters()" style="padding:9px 14px; background:#eee; border:none; border-radius:4px; cursor:pointer; font-size:13px;">Clear</button>
        </div>
        <div style="border-left:1px solid #eee; padding-left:12px;">
          <button type="button" onclick="bulkImportDropbox(true)" title="Preview what would be imported (no changes)" style="padding:9px 14px; background:#eee; border:none; border-radius:4px; cursor:pointer; font-size:13px;">👁 Preview import</button>
          <button type="button" onclick="bulkImportDropbox(false)" title="Scan Dropbox and add all client folders as clients" style="padding:9px 14px; background:#0061FF; color:white; border:none; border-radius:4px; cursor:pointer; font-size:13px; margin-left:4px;">📥 Import from Dropbox</button>
        </div>
      </div>
      <div id="row-count" style="margin-top:10px; font-size:13px; color:#666;">Showing ${clients.length} client${clients.length === 1 ? "" : "s"}</div>
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
      function filterRows() {
        const search = document.getElementById("search-input").value.toLowerCase().replace(/[-\\s]/g, "");
        const upcoming = document.getElementById("filter-upcoming").value;
        const lang = document.getElementById("filter-lang").value;
        let visible = 0;
        document.querySelectorAll(".c-row").forEach(row => {
          const name = row.dataset.name || "";
          const anumber = row.dataset.anumber || "";
          const email = row.dataset.email || "";
          const casetypes = row.dataset.casetypes || "";
          const matchesSearch = !search || name.includes(search) || anumber.includes(search) || email.replace(/\\s/g,"").includes(search) || casetypes.replace(/\\s/g,"").includes(search);
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
      async function bulkImportDropbox(dryRun) {
        const status = document.getElementById("import-status");
        status.innerHTML = '<span style="color:#666;">⏳ Scanning Dropbox for client folders (this may take 20-90 seconds depending on folder count)…</span>';
        try {
          const url = "/admin/clients/bulk-import-dropbox" + (dryRun ? "?dry=1" : "");
          const resp = await fetch(url, { method: "POST" });
          const data = await resp.json();
          if (!data.ok) {
            status.innerHTML = '<span style="color:#c00;">❌ ' + (data.error || "Import failed") + '</span>';
            return;
          }
          const label = dryRun ? "Would import" : "✅ Imported";
          const foundList = (data.imported || []).slice(0, 20).map(c =>
            '<li style="font-family:monospace; font-size:12px;">' +
              (c.client_name || "(no name)") + (c.a_number ? " · " + c.a_number : "") +
              '<span style="color:#888;"> — ' + c.dropbox_path + '</span>' +
            '</li>'
          ).join("");
          const more = data.imported.length > 20 ? '<li style="color:#888;">…and ' + (data.imported.length - 20) + ' more</li>' : "";
          status.innerHTML =
            '<div style="background:#f0f8ff; padding:12px; border-radius:4px; border-left:3px solid #0061FF;">' +
              '<strong>' + label + ' ' + data.imported.length + ' clients</strong>' +
              (data.errors && data.errors.length ? '<div style="color:#c00; font-size:12px; margin-top:4px;">' + data.errors.length + ' errors — check console</div>' : "") +
              '<ul style="margin:8px 0 0 0; padding-left:20px;">' + foundList + more + '</ul>' +
              (!dryRun ? '<div style="margin-top:10px;"><a href="/admin/clients" style="background:#0061FF; color:white; padding:6px 12px; border-radius:4px; text-decoration:none; font-size:13px;">🔄 Reload page to see them</a></div>' : '') +
            '</div>';
        } catch (e) {
          status.innerHTML = '<span style="color:#c00;">❌ ' + e.message + '</span>';
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
    contactActions.push(`<a href="mailto:${escapeAttr(email)}" style="background:#0C1C36; color:white; padding:8px 14px; border-radius:4px; text-decoration:none; font-size:13px;">✉️ Email</a>`);
  }
  if (phoneDigits) {
    contactActions.push(`<a href="tel:+${phoneDigits}" style="background:#0C1C36; color:white; padding:8px 14px; border-radius:4px; text-decoration:none; font-size:13px;">📞 Call</a>`);
    contactActions.push(`<a href="https://wa.me/${phoneDigits}" target="_blank" rel="noopener" style="background:#25D366; color:white; padding:8px 14px; border-radius:4px; text-decoration:none; font-size:13px;">💬 WhatsApp</a>`);
  }

  // Hearing rows
  const hearingRows = client.hearings.length ? client.hearings.map(h => {
    const kindBadge = h.kind === "individual"
      ? `<span style="background:#0C1C36; color:#B79C62; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:bold;">INDIV</span>`
      : `<span style="background:#B79C62; color:white; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:bold;">MASTER</span>`;
    return `
      <tr>
        <td>${kindBadge}</td>
        <td>${escapeHtml(h.type_label || "-")}</td>
        <td>${h.hearing_date ? new Date(h.hearing_date).toLocaleString() : "-"}</td>
        <td>${escapeHtml(h.judge_name || "-")}</td>
        <td>${escapeHtml(h.disposition || "-")}</td>
        <td>${h.sent ? "✅" : "—"}</td>
        <td><a href="${h.edit_url}" style="color:#B79C62;">edit</a></td>
      </tr>`;
  }).join("") : `<tr><td colspan="7" style="text-align:center; color:#888;">No hearings recorded.</td></tr>`;

  // Upcoming hearings section
  const upcomingSection = client.upcoming.length ? `
    <div style="background:#fef8e7; border-left:4px solid #B79C62; padding:15px; border-radius:4px; margin:15px 0;">
      <h3 style="margin:0 0 8px 0; color:#0C1C36;">🗓️ Upcoming Hearings</h3>
      <ul style="margin:0; padding-left:20px;">
        ${client.upcoming.map(u => `<li><strong>${escapeHtml(u.type)}</strong> — ${new Date(u.date).toLocaleString()} <span style="color:#666; font-size:12px;">(from ${u.from_kind} note #${u.from_id})</span></li>`).join("")}
      </ul>
    </div>` : "";

  // Quick-create new hearing links (pre-filled)
  const createLinks = client.a_number
    ? `
      <a href="/admin/hearing/notes?prefill_a=${encodeURIComponent(client.a_number)}&prefill_name=${encodeURIComponent(client.client_name || "")}" style="background:#B79C62; color:white; padding:8px 14px; border-radius:4px; text-decoration:none; font-size:13px;">+ New Master Hearing</a>
      <a href="/admin/hearing/individual?prefill_a=${encodeURIComponent(client.a_number)}&prefill_name=${encodeURIComponent(client.client_name || "")}" style="background:#B79C62; color:white; padding:8px 14px; border-radius:4px; text-decoration:none; font-size:13px;">+ New Individual Hearing</a>`
    : `
      <a href="/admin/hearing/notes?prefill_name=${encodeURIComponent(client.client_name || "")}" style="background:#B79C62; color:white; padding:8px 14px; border-radius:4px; text-decoration:none; font-size:13px;">+ New Master Hearing</a>
      <a href="/admin/hearing/individual?prefill_name=${encodeURIComponent(client.client_name || "")}" style="background:#B79C62; color:white; padding:8px 14px; border-radius:4px; text-decoration:none; font-size:13px;">+ New Individual Hearing</a>`;

  const body = `
    <div class="page-header">
      <h1>${escapeHtml(client.client_name || "(unnamed)")}</h1>
      <a href="/admin/clients" class="back-link">← All clients</a>
    </div>

    <!-- Client info card -->
    <div style="background:white; padding:20px; border-radius:6px; border:1px solid #eee; margin-bottom:15px;">
      <div style="display:flex; gap:30px; flex-wrap:wrap;">
        <div style="flex:1; min-width:280px;">
          <h3 style="margin:0 0 12px 0; color:#B79C62; font-size:14px; text-transform:uppercase; letter-spacing:0.5px;">Client Info</h3>
          <div style="line-height:1.9;">
            <div><strong>Name:</strong> ${escapeHtml(client.client_name || "-")}</div>
            <div><strong>A-Number:</strong> ${escapeHtml(client.a_number || "-")}</div>
            <div><strong>Email:</strong> ${email ? `<a href="mailto:${escapeAttr(email)}">${escapeHtml(email)}</a>` : "-"}</div>
            <div><strong>Phone:</strong> ${phone ? escapeHtml(phone) : "-"}</div>
            <div><strong>Address:</strong> ${client.client_address ? escapeHtml(client.client_address).replace(/\n/g, "<br>") : "-"}</div>
            <div><strong>Language:</strong> ${languageLabel(client.client_language)}</div>
          </div>
        </div>
        <div style="flex:1; min-width:280px;">
          <h3 style="margin:0 0 12px 0; color:#B79C62; font-size:14px; text-transform:uppercase; letter-spacing:0.5px;">Case Info</h3>
          <div style="line-height:1.9;">
            <div><strong>Case type(s):</strong> ${client.case_types.length ? client.case_types.map(escapeHtml).join(", ") : "-"}</div>
            <div><strong>Judge(s):</strong> ${client.judges.length ? client.judges.map(escapeHtml).join(", ") : "-"}</div>
            <div><strong>Total hearings:</strong> ${client.hearing_count}</div>
            <div><strong>Last activity:</strong> ${client.most_recent_date ? new Date(client.most_recent_date).toLocaleDateString() : "-"}</div>
            <div><strong>Most recent disposition:</strong> ${escapeHtml(client.most_recent_disposition || "-")}</div>
          </div>
        </div>
      </div>
      ${contactActions.length ? `<div style="margin-top:15px; padding-top:15px; border-top:1px solid #eee; display:flex; gap:8px; flex-wrap:wrap;">${contactActions.join("")}</div>` : ""}
    </div>

    ${upcomingSection}

    <!-- Detected hearing notices from Dropbox scan -->
    <div style="background:white; padding:20px; border-radius:6px; border:1px solid #eee; margin-bottom:15px;" id="hearing-notices-section">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; flex-wrap:wrap; gap:10px;">
        <h3 style="margin:0; color:#0C1C36;">🗓️ Hearing Notices <span id="hn-count" style="color:#888; font-weight:normal; font-size:14px;"></span></h3>
        <button type="button" onclick="scanForNotices()" id="hn-scan-btn" style="background:#0C1C36; color:white; padding:8px 14px; border:none; border-radius:4px; cursor:pointer; font-size:13px;">🔍 Scan Dropbox for notices</button>
      </div>
      <div id="hn-status" style="font-size:13px; color:#666; margin-bottom:10px;">Click "Scan Dropbox" to detect hearing notices in this client's folder.</div>
      <div id="hn-list"></div>
    </div>

    ${require("./client-documents").renderDocumentsSection({ clientKey: client.key, documents, aNumber: client.a_number })}

    <!-- Dropbox Documents section (lazy-loaded via JS) -->
    <div style="background:white; padding:20px; border-radius:6px; border:1px solid #eee; margin-bottom:15px;" id="dropbox-section">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; flex-wrap:wrap; gap:10px;">
        <h3 style="margin:0; color:#0C1C36;">📦 Dropbox <span id="dbx-count" style="color:#888; font-weight:normal;"></span></h3>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button type="button" onclick="dbxToggleUpload()" id="dbx-upload-btn" style="background:#0061FF; color:white; padding:8px 14px; border:none; border-radius:4px; cursor:pointer; font-size:13px; display:none;">+ Upload to Dropbox</button>
          <button type="button" onclick="dbxChangeFolder()" style="background:#eee; color:#333; padding:8px 14px; border:none; border-radius:4px; cursor:pointer; font-size:13px;">📁 Change folder</button>
          <button type="button" onclick="dbxRefresh(true)" style="background:#eee; color:#333; padding:8px 14px; border:none; border-radius:4px; cursor:pointer; font-size:13px;">🔄 Refresh</button>
          <a href="/admin/clients/${client.key}/dropbox/debug" style="background:#eee; color:#333; padding:8px 14px; border:none; border-radius:4px; cursor:pointer; font-size:13px; text-decoration:none;">🔍 Debug</a>
        </div>
      </div>
      <div id="dbx-folder-info" style="font-size:12px; color:#666; margin-bottom:10px;"></div>

      <!-- Upload form (hidden) -->
      <div id="dbx-upload-form" style="display:none; background:#f5f9ff; padding:15px; border-radius:4px; margin-bottom:12px; border:1px dashed #0061FF;">
        <div id="dbx-dropzone"
             ondragover="dbxDragOver(event)" ondragleave="dbxDragLeave(event)" ondrop="dbxDropFile(event)"
             onclick="document.getElementById('dbx-file-input').click()"
             style="border:2px dashed #0061FF; padding:20px; border-radius:6px; text-align:center; background:white; margin-bottom:12px; cursor:pointer;">
          <div style="font-size:36px; margin-bottom:8px;">📦</div>
          <div><strong>Drop a file here or click to browse</strong></div>
          <div style="font-size:12px; color:#666; margin-top:4px;">Uploads directly to this client's Dropbox folder. Max 25 MB.</div>
          <input type="file" id="dbx-file-input" style="display:none;" onchange="dbxHandleFileSelected(this.files[0])">
          <div id="dbx-selected" style="margin-top:8px; font-size:13px; color:#0C1C36;"></div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <button type="button" onclick="dbxUpload()" id="dbx-upload-do-btn" style="background:#0061FF; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">📤 Upload to Dropbox</button>
          <button type="button" onclick="dbxToggleUpload()" style="background:#eee; color:#333; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Cancel</button>
          <span id="dbx-upload-status" style="font-size:13px;"></span>
        </div>
      </div>

      <div id="dbx-status" style="padding:20px; text-align:center; color:#666;">Loading Dropbox files…</div>
      <div id="dbx-files" style="display:none;">
        <table style="width:100%; font-size:13px;">
          <thead>
            <tr style="border-bottom:1px solid #eee;">
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
            status.innerHTML = '<span style="color:#c00;">❌ ' + dbxEscape(data.error || "Failed to load") + '</span>' +
              (data.error && data.error.includes("not authorized") ? '<br><br><a href="/admin/dropbox/setup" style="color:#0061FF;">→ Connect Dropbox first</a>' : "");
            return;
          }
          if (!data.resolved || !data.folder) {
            let suggHtml = '';
            const suggestions = data.suggestions || [];
            if (suggestions.length) {
              suggHtml = '<div style="margin-top:15px; text-align:left; max-width:520px; margin-left:auto; margin-right:auto;">' +
                '<div style="font-weight:600; margin-bottom:8px; color:#0C1C36;">💡 Did you mean one of these?</div>' +
                suggestions.map(function(s) {
                  const reason = s.reason ? '<span style="color:#888; font-size:11px; margin-left:6px;">(' + dbxEscape(s.reason) + ')</span>' : '';
                  const escapedPath = JSON.stringify(s.path).replace(/"/g,"&quot;");
                  return '<div style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; background:#f8f8f8; border-radius:4px; margin-bottom:4px;">' +
                    '<div style="font-family:monospace; font-size:12px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + dbxEscape(s.path) + reason + '</div>' +
                    '<button type="button" onclick="dbxUseSuggestion(' + escapedPath + '); return false;" style="background:#0061FF; color:white; border:none; padding:4px 10px; border-radius:3px; cursor:pointer; font-size:12px; margin-left:8px; flex-shrink:0;">Use this</button>' +
                    '</div>';
                }).join('') +
                '<div style="margin-top:10px; text-align:center;"><button type="button" onclick="dbxChangeFolder()" style="background:#eee; color:#333; padding:8px 14px; border:none; border-radius:4px; cursor:pointer; font-size:13px;">Or enter folder path manually</button></div>' +
                '</div>';
            } else {
              suggHtml = '<div style="margin-top:15px;"><button type="button" onclick="dbxChangeFolder()" style="background:#0061FF; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Set folder manually</button></div>';
            }
            status.innerHTML = '<span style="color:#ff9800;">⚠️ No exact match found for this client in configured branches.</span><br>' +
              '<span style="font-size:12px; color:#666;">Searched for "' +
              dbxEscape(${JSON.stringify(client.client_name || "")}) + '"' +
              (${JSON.stringify(client.a_number || "")} ? ' / A#' + dbxEscape(${JSON.stringify(client.a_number || "")}) : "") +
              '</span>' + suggHtml;
            countEl.textContent = "";
            uploadBtn.style.display = "none";
            return;
          }
          folderInfo.innerHTML = '📁 <code>' + dbxEscape(data.folder) + '</code>' + (data.cached ? ' <span style="color:#888;">(cached)</span>' : '');
          countEl.textContent = "(" + (data.files || []).length + ")";
          uploadBtn.style.display = "";
          if (data.folder_missing) {
            status.innerHTML = '<span style="color:#ff9800;">⚠️ Folder path is stored but doesn\\'t exist in Dropbox: ' + dbxEscape(data.folder) + '</span>';
            return;
          }
          const files = data.files || [];
          if (!files.length) {
            status.innerHTML = '<span style="color:#888;">Folder is empty. Upload to add files.</span>';
            return;
          }
          // Render files
          const tbody = document.getElementById("dbx-tbody");
          tbody.innerHTML = files.map(f =>
            '<tr>' +
              '<td style="width:30px; text-align:center; font-size:18px;">' + dbxIconFor(f.name) + '</td>' +
              '<td><a href="/admin/clients/' + encodeURIComponent(DBX_CLIENT_KEY) + '/dropbox/download?path=' + encodeURIComponent(f.path) + '" target="_blank" style="color:#0C1C36; text-decoration:none; font-weight:600;">' + dbxEscape(f.name) + '</a></td>' +
              '<td style="font-size:12px; color:#666; white-space:nowrap;">' + dbxFmtSize(f.size) + '</td>' +
              '<td style="font-size:12px; color:#666; white-space:nowrap;">' + (f.server_modified ? new Date(f.server_modified).toLocaleDateString() : "-") + '</td>' +
              '<td style="white-space:nowrap;">' +
                '<a href="/admin/clients/' + encodeURIComponent(DBX_CLIENT_KEY) + '/dropbox/download?path=' + encodeURIComponent(f.path) + '" target="_blank" style="color:#0061FF; font-size:13px;">📥</a>' +
                ' &nbsp; ' +
                '<a href="#" onclick="dbxDelete(' + JSON.stringify(f.path).replace(/"/g,"&quot;") + ', ' + JSON.stringify(f.name).replace(/"/g,"&quot;") + '); return false;" style="color:#c00; font-size:13px;">🗑️</a>' +
              '</td>' +
            '</tr>'
          ).join("");
          status.style.display = "none";
          filesDiv.style.display = "";
        } catch (e) {
          status.innerHTML = '<span style="color:#c00;">❌ ' + dbxEscape(e.message) + '</span>';
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
          document.getElementById("dbx-selected").innerHTML += ' <span style="color:#c00;">— exceeds 25MB limit</span>';
        }
      }
      function dbxDragOver(e) { e.preventDefault(); e.stopPropagation(); document.getElementById("dbx-dropzone").style.background = "#f0f8ff"; }
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
        status.style.color = "#666";
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
            status.style.color = "#4CAF50";
            setTimeout(() => { dbxToggleUpload(); dbxRefresh(true); }, 700);
          } else {
            btn.disabled = false;
            status.textContent = "❌ " + (data.error || "Upload failed");
            status.style.color = "#c00";
          }
        } catch (e) {
          btn.disabled = false;
          status.textContent = "❌ " + e.message;
          status.style.color = "#c00";
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

      // ── Hearing Notices ────────────────────────────────
      async function loadHearingNotices() {
        try {
          const resp = await fetch("/admin/clients/" + encodeURIComponent(DBX_CLIENT_KEY) + "/hearing-notices");
          const data = await resp.json();
          if (!data.ok) return;
          renderNotices(data.notices || []);
        } catch (e) { /* silent */ }
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
          const dt = n.hearing_date ? new Date(n.hearing_date) : null;
          const dateStr = dt && !isNaN(dt) ? dt.toLocaleString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "(date not confirmed)";
          const noticeTypeBadge = n.notice_type
            ? '<span style="background:#fdf7f0; color:#B79C62; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600;">' + dbxEscape(n.notice_type) + '</span>'
            : "";
          const confidenceBadge = n.confidence === "low"
            ? '<span style="background:#fff3e0; color:#e65100; padding:2px 6px; border-radius:8px; font-size:10px; margin-left:4px;">low confidence — verify</span>'
            : "";
          const notifiedBadge = n.notified_at
            ? '<span style="background:#e8f5e9; color:#2e7d32; padding:2px 6px; border-radius:8px; font-size:10px; margin-left:4px;">✓ notified ' + new Date(n.notified_at).toLocaleDateString() + '</span>'
            : "";
          const links = n.contact_links || {};
          const btn = (href, channel, label, color) => href
            ? '<a href="' + href + '" target="_blank" rel="noopener" onclick="markNotified(' + n.id + ', \\'' + channel + '\\')" style="background:' + color + '; color:white; padding:6px 12px; border-radius:4px; text-decoration:none; font-size:12px; margin-right:4px;">' + label + '</a>'
            : '<span style="background:#eee; color:#999; padding:6px 12px; border-radius:4px; font-size:12px; margin-right:4px;">' + label + ' (no contact)</span>';
          return '<div style="border-left:4px solid #B79C62; background:#fdf7f0; padding:12px; border-radius:4px; margin-bottom:8px;">' +
            '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">' +
              '<div style="flex:1; min-width:250px;">' +
                '<div style="font-size:15px; font-weight:600; color:#0C1C36;">' + dbxEscape(dateStr) + '</div>' +
                '<div style="margin-top:4px; font-size:13px; color:#333;">' + noticeTypeBadge + confidenceBadge + notifiedBadge + '</div>' +
                (n.court_name ? '<div style="font-size:12px; color:#666; margin-top:4px;">📍 ' + dbxEscape(n.court_name) + '</div>' : "") +
                (n.court_address ? '<div style="font-size:12px; color:#666;">📌 ' + dbxEscape(n.court_address) + '</div>' : "") +
                (n.judge_name ? '<div style="font-size:12px; color:#666;">⚖️ ' + dbxEscape(n.judge_name) + '</div>' : "") +
              '</div>' +
              '<div style="display:flex; gap:4px; flex-wrap:wrap;">' +
                btn(links.email,     "email",    "✉️ Email",      "#0C1C36") +
                btn(links.whatsapp,  "whatsapp", "💬 WhatsApp",    "#25D366") +
                btn(links.sms,       "sms",      "📱 SMS",         "#0061FF") +
                '<button type="button" onclick="dismissNotice(' + n.id + ')" title="Dismiss (hide this notice)" style="background:#eee; color:#666; padding:6px 10px; border:none; border-radius:4px; cursor:pointer; font-size:12px;">✕</button>' +
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
            status.innerHTML = '<span style="color:#c00;">❌ ' + dbxEscape(data.error || "Scan failed") + '</span>';
          }
        } catch (e) {
          status.innerHTML = '<span style="color:#c00;">❌ ' + dbxEscape(e.message) + '</span>';
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
    <div style="background:white; padding:20px; border-radius:6px; border:1px solid #eee; margin-bottom:15px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; flex-wrap:wrap; gap:10px;">
        <h3 style="margin:0; color:#0C1C36;">📚 All Hearings (${client.hearing_count})</h3>
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

// ── Exports ──────────────────────────────────────────────

module.exports = {
  aggregateClients,
  getClientByKey,
  clientKey,
  renderClientList,
  renderClientDetail,
};
