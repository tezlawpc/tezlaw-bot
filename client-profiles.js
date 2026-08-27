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
    return `
    <tr class="c-row"
        data-name="${escapeAttr((c.client_name || "").toLowerCase())}"
        data-anumber="${escapeAttr((c.a_number || "").toLowerCase().replace(/[-\s]/g, ""))}"
        data-email="${escapeAttr((c.client_email || "").toLowerCase())}"
        data-lang="${escapeAttr(c.client_language || "")}"
        data-hasupcoming="${c.upcoming.length ? "yes" : "no"}"
        data-casetypes="${escapeAttr(c.case_types.join(" | ").toLowerCase())}">
      <td><a href="/admin/clients/${c.key}" style="color:#B79C62; font-weight:600;">${escapeHtml(c.client_name || "(unnamed)")}</a></td>
      <td>${escapeHtml(c.a_number || "")}</td>
      <td>${escapeHtml(c.case_types.slice(0, 2).join(", ") || "-")}${c.case_types.length > 2 ? " +" + (c.case_types.length - 2) : ""}</td>
      <td>${c.hearing_count}</td>
      <td>${c.most_recent_date ? new Date(c.most_recent_date).toLocaleDateString() : "-"}</td>
      <td>${languageLabel(c.client_language)}</td>
      <td>${nextUp}</td>
      <td><a href="/admin/clients/${c.key}" style="color:#0C1C36;">view →</a></td>
    </tr>`;
  }).join("") : `<tr><td colspan="8" style="text-align:center; color:#888;">No clients yet. Create a hearing note to populate this list.</td></tr>`;

  const totalUpcoming = clients.filter(c => c.upcoming.length).length;

  const body = `
    <div class="page-header">
      <h1>👥 Client Profiles</h1>
      <div style="font-size:13px; color:#666;">${clients.length} clients · ${totalUpcoming} with upcoming hearings</div>
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
      </div>
      <div id="row-count" style="margin-top:10px; font-size:13px; color:#666;">Showing ${clients.length} client${clients.length === 1 ? "" : "s"}</div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Client</th><th>A#</th><th>Case Type</th><th>Hearings</th>
          <th>Last Activity</th><th>Language</th><th>Status</th><th></th>
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

    ${require("./client-documents").renderDocumentsSection({ clientKey: client.key, documents, aNumber: client.a_number })}

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
