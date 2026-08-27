// ============================================================
//  TEZ LAW P.C. — CLIENT DOCUMENTS HUB
//  ─────────────────────────────────────────────────────────
//  Per-client document storage: passport, birth cert, I-94,
//  court orders, medical records, expert reports, etc. Docs
//  live at the client level (not per-hearing) so they carry
//  across all cases for that client.
//
//  Storage: PostgreSQL BYTEA. 25MB per file limit. Metadata
//  (filename, category, description, size, upload date) plus
//  the binary blob. Auto-backs up with the rest of the DB.
//
//  Access control: currently open (matches rest of admin panel).
// ============================================================

const db = require("./db");

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per document

// Common immigration-case document categories.
// Attorney can pick from these or type their own.
const CATEGORY_SUGGESTIONS = [
  "Passport",
  "National ID",
  "Birth Certificate",
  "Marriage Certificate",
  "Driver's License / State ID",
  "I-94",
  "I-797 Receipt",
  "NTA (Notice to Appear)",
  "Prior Court Order",
  "EAD Card",
  "Green Card",
  "Visa",
  "Medical Records",
  "Country Conditions Report",
  "Affidavit / Declaration",
  "Expert Report",
  "Photo Evidence",
  "Police Report / Criminal Records",
  "Tax Returns",
  "Bank Statements",
  "Employment Letter",
  "Lease / Utility Bill",
  "Family Photos",
  "Letters / Correspondence",
  "Retainer Agreement",
  "Other",
];

// ── Schema ───────────────────────────────────────────────

async function initTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS client_documents (
      id           SERIAL PRIMARY KEY,
      client_key   TEXT NOT NULL,
      client_name  TEXT,
      a_number     TEXT,
      filename     TEXT NOT NULL,
      mime_type    TEXT NOT NULL,
      size_bytes   INTEGER NOT NULL,
      category     TEXT,
      description  TEXT,
      file_data    BYTEA NOT NULL,
      uploaded_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_client_documents_client_key
      ON client_documents (client_key)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_client_documents_a_number
      ON client_documents (a_number)
  `);
}

// ── CRUD ─────────────────────────────────────────────────

async function uploadDocument({ clientKey, clientName, aNumber, filename, mimeType, buffer, category, description }) {
  await initTable();
  if (!clientKey) throw new Error("clientKey is required");
  if (!filename) throw new Error("filename is required");
  if (!buffer || !buffer.length) throw new Error("Empty file");
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(`File too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (max 25MB)`);
  }
  const r = await db.query(
    `INSERT INTO client_documents
      (client_key, client_name, a_number, filename, mime_type, size_bytes, category, description, file_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, uploaded_at`,
    [
      clientKey,
      clientName || null,
      aNumber || null,
      filename,
      mimeType || "application/octet-stream",
      buffer.length,
      category || null,
      description || null,
      buffer,
    ]
  );
  return { id: r.rows[0].id, uploaded_at: r.rows[0].uploaded_at };
}

// List documents for a client — MATCHES ON BOTH clientKey AND a_number.
// This way, if a client's URL key changes (e.g. name got fixed), docs
// still surface via A# match.
async function listDocuments(clientKey, aNumber = null) {
  await initTable();
  let q, params;
  if (aNumber) {
    const normalizedA = String(aNumber).toLowerCase().replace(/[^\w]/g, "");
    q = `SELECT id, client_key, client_name, a_number, filename, mime_type, size_bytes,
                category, description, uploaded_at
         FROM client_documents
         WHERE client_key = $1
            OR LOWER(REGEXP_REPLACE(COALESCE(a_number, ''), '[^\\w]', '', 'g')) = $2
         ORDER BY uploaded_at DESC`;
    params = [clientKey, normalizedA];
  } else {
    q = `SELECT id, client_key, client_name, a_number, filename, mime_type, size_bytes,
                category, description, uploaded_at
         FROM client_documents
         WHERE client_key = $1
         ORDER BY uploaded_at DESC`;
    params = [clientKey];
  }
  const r = await db.query(q, params);
  return r.rows;
}

async function getDocument(id) {
  await initTable();
  const r = await db.query(
    `SELECT id, client_key, client_name, a_number, filename, mime_type,
            size_bytes, category, description, file_data, uploaded_at
     FROM client_documents WHERE id = $1`,
    [id]
  );
  return r.rows[0];
}

async function deleteDocument(id) {
  await initTable();
  const r = await db.query(
    `DELETE FROM client_documents WHERE id = $1 RETURNING id, filename`,
    [id]
  );
  if (!r.rows.length) throw new Error(`Document ${id} not found`);
  return { id: r.rows[0].id, filename: r.rows[0].filename };
}

// Storage stats: total bytes used across all client docs
async function getStorageStats() {
  await initTable();
  const r = await db.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS total_bytes
     FROM client_documents`
  );
  return { count: parseInt(r.rows[0].count), total_bytes: parseInt(r.rows[0].total_bytes) };
}

// ── UI Fragment ──────────────────────────────────────────

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function iconFor(mimeType, filename) {
  const mime = (mimeType || "").toLowerCase();
  const name = (filename || "").toLowerCase();
  if (mime.includes("pdf") || /\.pdf$/i.test(name)) return "📄";
  if (mime.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp|heic)$/i.test(name)) return "🖼️";
  if (mime.includes("word") || /\.docx?$/i.test(name)) return "📝";
  if (mime.includes("excel") || mime.includes("spreadsheet") || /\.xlsx?$/i.test(name)) return "📊";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  if (/\.(zip|rar|7z|tar|gz)$/i.test(name)) return "🗜️";
  return "📎";
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttr(s) { return escapeHtml(s); }

// Render the documents section for embedding on the client profile page.
function renderDocumentsSection({ clientKey, documents, aNumber }) {
  const cats = [...new Set(documents.map(d => d.category).filter(Boolean))].sort();
  const catFilterOptions = cats.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");

  const rows = documents.length ? documents.map(d => `
    <tr class="doc-row" data-category="${escapeAttr(d.category || "")}">
      <td style="width:30px; text-align:center; font-size:18px;">${iconFor(d.mime_type, d.filename)}</td>
      <td>
        <div style="font-weight:600;">
          <a href="/admin/clients/${encodeURIComponent(clientKey)}/documents/${d.id}/download" style="color:#0C1C36; text-decoration:none;">${escapeHtml(d.filename)}</a>
        </div>
        ${d.description ? `<div style="font-size:12px; color:#666; margin-top:2px;">${escapeHtml(d.description)}</div>` : ""}
      </td>
      <td style="font-size:12px;">${d.category ? `<span style="background:#fdf7f0; color:#B79C62; padding:2px 8px; border-radius:10px; font-size:11px; white-space:nowrap;">${escapeHtml(d.category)}</span>` : "—"}</td>
      <td style="font-size:12px; color:#666; white-space:nowrap;">${formatBytes(d.size_bytes)}</td>
      <td style="font-size:12px; color:#666; white-space:nowrap;">${new Date(d.uploaded_at).toLocaleDateString()}</td>
      <td style="white-space:nowrap;">
        <a href="/admin/clients/${encodeURIComponent(clientKey)}/documents/${d.id}/download" style="color:#B79C62; font-size:13px;">📥</a>
        &nbsp;
        <a href="#" onclick="deleteDoc(${d.id}, ${JSON.stringify(d.filename).replace(/"/g, '&quot;')}); return false;" style="color:#c00; font-size:13px;">🗑️</a>
      </td>
    </tr>
  `).join("") : `<tr><td colspan="6" style="text-align:center; color:#888; padding:20px;">No documents yet. Upload the client's passport, birth certificate, court orders, etc. above.</td></tr>`;

  const categorySuggestions = CATEGORY_SUGGESTIONS.map(c => `<option value="${escapeAttr(c)}">`).join("");

  return `
    <div style="background:white; padding:20px; border-radius:6px; border:1px solid #eee; margin-bottom:15px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; flex-wrap:wrap; gap:10px;">
        <h3 style="margin:0; color:#0C1C36;">📁 Documents (${documents.length})</h3>
        <button type="button" onclick="toggleUploadForm()" style="background:#B79C62; color:white; padding:8px 14px; border:none; border-radius:4px; cursor:pointer; font-size:13px;">+ Upload Document</button>
      </div>

      <!-- Upload form (hidden by default) -->
      <div id="doc-upload-form" style="display:none; background:#fdf7f0; padding:15px; border-radius:4px; margin-bottom:12px; border:1px dashed #B79C62;">
        <div id="doc-dropzone" ondragover="dragOver(event)" ondragleave="dragLeave(event)" ondrop="dropFile(event)"
             style="border:2px dashed #B79C62; padding:20px; border-radius:6px; text-align:center; background:white; margin-bottom:12px; cursor:pointer;"
             onclick="document.getElementById('doc-file-input').click()">
          <div style="font-size:36px; margin-bottom:8px;">📄</div>
          <div><strong>Drop a file here or click to browse</strong></div>
          <div style="font-size:12px; color:#666; margin-top:4px;">PDF, images, Word docs, etc. Max 25 MB.</div>
          <input type="file" id="doc-file-input" style="display:none;" onchange="handleFileSelected(this.files[0])">
          <div id="doc-selected" style="margin-top:8px; font-size:13px; color:#0C1C36;"></div>
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
          <div style="flex:1; min-width:200px;">
            <label style="font-size:12px; color:#666; display:block; margin-bottom:2px;">Category (optional)</label>
            <input list="doc-cat-suggestions" id="doc-category" placeholder="e.g. Passport, I-94, Medical Records" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">
            <datalist id="doc-cat-suggestions">${categorySuggestions}</datalist>
          </div>
        </div>
        <div style="margin-bottom:10px;">
          <label style="font-size:12px; color:#666; display:block; margin-bottom:2px;">Notes (optional)</label>
          <textarea id="doc-description" rows="2" placeholder="e.g. Valid until 2028, filed with I-589" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; font-family:inherit;"></textarea>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <button type="button" onclick="uploadDoc()" id="doc-upload-btn" style="background:#B79C62; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">📤 Upload</button>
          <button type="button" onclick="toggleUploadForm()" style="background:#eee; color:#333; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Cancel</button>
          <span id="doc-upload-status" style="font-size:13px;"></span>
        </div>
      </div>

      <!-- Category filter -->
      ${cats.length > 1 ? `
      <div style="margin-bottom:10px;">
        <select id="doc-cat-filter" onchange="filterDocs()" style="padding:6px; border:1px solid #ccc; border-radius:4px; font-size:13px;">
          <option value="">All categories (${documents.length})</option>
          ${catFilterOptions}
        </select>
      </div>` : ""}

      <div style="overflow-x:auto;">
        <table style="width:100%; font-size:13px;">
          <thead>
            <tr style="border-bottom:1px solid #eee;">
              <th></th>
              <th style="text-align:left;">Filename</th>
              <th style="text-align:left;">Category</th>
              <th style="text-align:left;">Size</th>
              <th style="text-align:left;">Uploaded</th>
              <th style="text-align:left;">Actions</th>
            </tr>
          </thead>
          <tbody id="docs-tbody">${rows}</tbody>
        </table>
      </div>
    </div>

    <script>
      const CLIENT_KEY = ${JSON.stringify(clientKey)};
      let selectedFile = null;

      function toggleUploadForm() {
        const form = document.getElementById("doc-upload-form");
        form.style.display = form.style.display === "none" ? "block" : "none";
        if (form.style.display === "none") {
          selectedFile = null;
          document.getElementById("doc-file-input").value = "";
          document.getElementById("doc-selected").textContent = "";
          document.getElementById("doc-category").value = "";
          document.getElementById("doc-description").value = "";
          document.getElementById("doc-upload-status").textContent = "";
        }
      }
      function handleFileSelected(file) {
        if (!file) return;
        selectedFile = file;
        const sizeMB = (file.size / 1024 / 1024).toFixed(1);
        document.getElementById("doc-selected").textContent = "✓ " + file.name + " (" + sizeMB + " MB)";
        if (file.size > 25 * 1024 * 1024) {
          document.getElementById("doc-selected").innerHTML += ' <span style="color:#c00;">— exceeds 25MB limit</span>';
        }
      }
      function dragOver(e) { e.preventDefault(); e.stopPropagation(); document.getElementById("doc-dropzone").style.background = "#faedd5"; }
      function dragLeave(e) { e.preventDefault(); e.stopPropagation(); document.getElementById("doc-dropzone").style.background = "white"; }
      function dropFile(e) {
        e.preventDefault(); e.stopPropagation();
        document.getElementById("doc-dropzone").style.background = "white";
        if (e.dataTransfer.files[0]) handleFileSelected(e.dataTransfer.files[0]);
      }
      async function uploadDoc() {
        if (!selectedFile) { alert("Choose a file first"); return; }
        if (selectedFile.size > 25 * 1024 * 1024) { alert("File exceeds 25MB limit"); return; }
        const btn = document.getElementById("doc-upload-btn");
        const status = document.getElementById("doc-upload-status");
        btn.disabled = true;
        status.textContent = "⏳ Uploading...";
        status.style.color = "#666";
        try {
          const fd = new FormData();
          // Sanitize filename for HTTP header safety
          const safeName = selectedFile.name.replace(/[^\\w.\\-]/g, "_");
          const fileForUpload = safeName !== selectedFile.name
            ? new File([selectedFile], safeName, { type: selectedFile.type })
            : selectedFile;
          fd.append("file", fileForUpload);
          fd.append("original_filename", selectedFile.name);
          fd.append("category", document.getElementById("doc-category").value);
          fd.append("description", document.getElementById("doc-description").value);
          const resp = await fetch("/admin/clients/" + encodeURIComponent(CLIENT_KEY) + "/documents", {
            method: "POST", body: fd,
          });
          let data;
          try { data = await resp.json(); }
          catch { data = { ok: false, error: "Server returned invalid response (" + resp.status + ")" }; }
          if (data.ok) {
            status.textContent = "✅ Uploaded";
            status.style.color = "#4CAF50";
            setTimeout(() => window.location.reload(), 700);
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
      async function deleteDoc(id, filename) {
        if (!confirm("Delete " + filename + "? This cannot be undone.")) return;
        try {
          const resp = await fetch("/admin/clients/" + encodeURIComponent(CLIENT_KEY) + "/documents/" + id, {
            method: "DELETE",
          });
          const data = await resp.json();
          if (data.ok) { window.location.reload(); }
          else { alert("❌ " + (data.error || "Delete failed")); }
        } catch (e) { alert("❌ " + e.message); }
      }
      function filterDocs() {
        const val = document.getElementById("doc-cat-filter").value;
        document.querySelectorAll(".doc-row").forEach(r => {
          r.style.display = (!val || r.dataset.category === val) ? "" : "none";
        });
      }
    </script>
  `;
}

module.exports = {
  MAX_FILE_BYTES,
  CATEGORY_SUGGESTIONS,
  initTable,
  uploadDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  getStorageStats,
  renderDocumentsSection,
};
