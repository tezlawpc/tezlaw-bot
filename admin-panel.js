// admin-panel.js — Tez Law P.C. | Zara Admin Panel Frontend
// Served from admin.js at GET /admin/panel.js

  function getCookie(name) {
    return document.cookie.split('; ').find(r => r.startsWith(name + '='))?.split('=')[1] || '';
  }

  async function api(path, options = {}) {
    try {
      const res = await fetch('/admin' + path, {
        ...options,
        headers: { 'Content-Type': 'application/json', 'x-admin-token': getCookie('admin_token'), ...options.headers }
      });
      if (res.status === 401) { window.location.href = '/admin/login'; return null; }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('API error ' + res.status + ' on ' + path + ':', err.error || 'unknown');
        return null;
      }
      return res.json();
    } catch(e) {
      console.error('API fetch error on ' + path + ':', e.message);
      return null;
    }
  }

  function platBadge(p) {
    const map = { telegram:'badge-tg', whatsapp:'badge-wa', website:'badge-web',
                  wechat:'badge-wc', messenger:'badge-ms' };
    return `<span class="badge ${map[p]||''}">${p}</span>`;
  }

  function showPage(name) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const pageEl = document.getElementById('page-' + name);
    const navEl = document.getElementById('nav-' + name);
    if (!pageEl) { console.warn('[showPage] page not found:', name); return; }
    pageEl.classList.add('active');
    if (navEl) navEl.classList.add('active');

    // Persist to URL hash for deep-linking
    if (window.location.hash !== '#' + name) {
      history.replaceState(null, '', '#' + name);
    }

    if (name === 'dashboard') loadDashboard();
    if (name === 'prompt') loadPrompt();
    if (name === 'intakes') loadIntakes();
    if (name === 'messages') loadMessages();
    if (name === 'compliance') loadCompliance();
    if (name === 'analytics') loadAnalytics();
    if (name === 'pipeline') loadPipeline();
    if (name === 'conflicts') loadConflicts();
    if (name === 'questions') loadQuestions();
    if (name === 'audit') loadAudit();
    if (name === 'poster') initPoster();
    if (name === 'scores') loadScores();
    if (name === 'sol') { loadSol(); }
    if (name === 'drip') loadDrip();
    if (name === 'prompt') loadPromptHistory();
    if (name === 'research') showResearchTab('caselaw');
    if (name === 'post') loadManualPost();
  }

  // Auto-open the right tab from URL hash (for deep-links from main sidebar)
  function openTabFromHash() {
    const hash = window.location.hash.replace('#', '').trim();
    if (!hash) return false;
    // Whitelist to avoid trying random hashes
    const valid = ['dashboard','prompt','intakes','messages','compliance','analytics',
                   'research','pipeline','conflicts','questions','audit','post','poster',
                   'scores','sol','drip'];
    if (valid.includes(hash)) {
      showPage(hash);
      return true;
    }
    return false;
  }
  window.addEventListener('DOMContentLoaded', () => setTimeout(openTabFromHash, 100));
  window.addEventListener('hashchange', openTabFromHash);

  // Dashboard
  async function loadDashboard() {
    const data = await api('/api/stats');
    if (!data) return;

    document.getElementById('statsGrid').innerHTML = `
      <div class="stat-card"><div class="stat-num">${data.totalMessages.toLocaleString()}</div><div class="stat-label">Total Messages</div></div>
      <div class="stat-card"><div class="stat-num">${data.totalClients.toLocaleString()}</div><div class="stat-label">Total Clients</div></div>
      <div class="stat-card"><div class="stat-num">${data.totalIntakes.toLocaleString()}</div><div class="stat-label">Total Intakes</div></div>
      <div class="stat-card"><div class="stat-num">${data.messagesToday.toLocaleString()}</div><div class="stat-label">Messages Today</div></div>
    `;

    document.getElementById('platformBar').innerHTML = data.byPlatform.map(p =>
      `<div class="platform-stat"><div class="n">${Number(p.messages).toLocaleString()}</div><div class="p">${p.platform}</div></div>`
    ).join('') || '<p style="color:#5E5854;font-size:13px">No data yet</p>';

    document.getElementById('caseTypeBar').innerHTML = data.weekIntakeTypes.length
      ? `<table><thead><tr><th>Case Type</th><th>Count</th></tr></thead><tbody>${
          data.weekIntakeTypes.map(r => `<tr><td>${r.case_type||'Unknown'}</td><td>${r.n}</td></tr>`).join('')
        }</tbody></table>`
      : '<p style="color:#5E5854;font-size:13px">No intakes this week yet</p>';
  }

  // Prompt editor
  async function loadPrompt() {
    const data = await api('/api/prompt');
    if (data) document.getElementById('promptEditor').value = data.prompt;
  }

  async function savePrompt() {
    const btn = document.getElementById('saveBtn');
    const msg = document.getElementById('saveMsg');
    const prompt = document.getElementById('promptEditor').value;
    btn.disabled = true;
    btn.textContent = 'Saving...';
    msg.textContent = '';

    const res = await api('/api/prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt })
    });

    btn.disabled = false;
    btn.textContent = '💾 Save & Apply Now';
    if (res?.ok) {
      msg.textContent = '✅ Saved and live!';
      setTimeout(() => msg.textContent = '', 3000);
    } else {
      msg.style.color = '#9C2B1E';
      msg.textContent = '❌ Save failed';
    }
  }

  // Intakes
  async function loadIntakes() {
    const data = await api('/api/intakes');
    if (!data) return;
    document.getElementById('intakesTable').innerHTML = data.length
      ? `<table>
          <thead><tr><th>Date</th><th>Platform</th><th>Name</th><th>Case Type</th><th>Contact</th><th>Issue</th></tr></thead>
          <tbody>${data.map(r => `<tr>
            <td style="white-space:nowrap">${new Date(r.created_at).toLocaleDateString('en-US')}</td>
            <td>${platBadge(r.platform)}</td>
            <td>${r.name||'—'}</td>
            <td>${r.case_type||'—'}</td>
            <td>${r.contact||'—'}</td>
            <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.issue||''}">${r.issue||'—'}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : '<p style="color:#5E5854;font-size:13px;padding:12px">No intakes yet.</p>';
  }

  // Messages
  async function loadMessages() {
    const data = await api('/api/messages');
    if (!data) return;
    document.getElementById('messagesTable').innerHTML = data.length
      ? `<table>
          <thead><tr><th>Time</th><th>Platform</th><th>Role</th><th>Message</th></tr></thead>
          <tbody>${data.map(r => `<tr>
            <td style="white-space:nowrap;font-size:11px">${new Date(r.created_at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</td>
            <td>${platBadge(r.platform)}</td>
            <td><span style="font-size:11px;font-weight:bold;color:${r.role==='assistant'?'#A34C00':'#2B2523'}">${r.role==='assistant'?'TARA':'CLIENT'}</span></td>
            <td style="max-width:400px;font-size:13px">${r.content.substring(0,200)}${r.content.length>200?'…':''}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : '<p style="color:#5E5854;font-size:13px;padding:12px">No messages yet.</p>';
  }

  // Compliance
  async function loadCompliance() {
    const data = await api('/api/compliance');
    if (!data) return;
    const typeColors = {
      DEFINITIVE_CONCLUSION: '#cc6600',
      LEGAL_GUARANTEE:       '#cc0000',
      UPL_RISK:              '#990099',
      UNAUTHORIZED_DIAGNOSIS:'#006699',
    };
    document.getElementById('complianceTable').innerHTML = data.length
      ? `<table>
          <thead><tr><th>Date</th><th>Platform</th><th>Type</th><th>Zara Said</th><th>Correction Sent</th></tr></thead>
          <tbody>${data.map(r => `<tr>
            <td style="white-space:nowrap;font-size:11px">${new Date(r.created_at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</td>
            <td>${platBadge(r.platform)}</td>
            <td><span style="font-size:11px;font-weight:bold;padding:3px 8px;border-radius:12px;background:#FBEDEA;color:${typeColors[r.violation_type]||'#9C2B1E'}">${r.violation_type}</span></td>
            <td style="max-width:260px;font-size:12px;color:#2B2523" title="${(r.zara_response||'').replace(/"/g,'&quot;')}">${(r.zara_response||'').substring(0,120)}${(r.zara_response||'').length>120?'…':''}</td>
            <td style="max-width:220px;font-size:12px;color:#2F6B3F" title="${(r.correction_sent||'').replace(/"/g,'&quot;')}">${(r.correction_sent||'').substring(0,100)}${(r.correction_sent||'').length>100?'…':''}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : '<p style="color:#2F6B3F;font-size:13px;padding:12px">✅ No compliance violations logged. Zara is clean!</p>';
  }

  // Analytics
  async function loadAnalytics() {
    const data = await api('/api/analytics');
    if (!data) return;
    const entries = Object.entries(data).reverse();
    document.getElementById('analyticsHistory').innerHTML = entries.length
      ? entries.map(([week, entry]) => `
          <div class="analytics-entry">
            <div class="analytics-week">📅 ${week.replace('-', ' ').replace('W', 'Week ')}</div>
            <div style="font-size:11px;color:#5E5854;margin-bottom:8px">Run at: ${new Date(entry.ranAt).toLocaleString('en-US')}</div>
            <div class="analytics-summary">${entry.summary}</div>
          </div>`).join('')
      : '<p style="color:#5E5854;font-size:13px">No analytics runs yet.</p>';
  }

  async function submitCustomPost() {
    var btn  = document.getElementById('customPostBtn');
    var msg  = document.getElementById('customPostMsg');
    var topic = document.getElementById('customTopic').value.trim();
    var area  = document.getElementById('customArea').value;
    var url   = document.getElementById('customUrl').value.trim();
    var notes = document.getElementById('customNotes').value.trim();

    if (!topic) {
      msg.style.color = '#9C2B1E';
      msg.textContent = '❌ Please enter a topic or headline.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Generating...';
    msg.style.color = '#2F6B3F';
    msg.textContent = '⏳ Writing and publishing — this takes ~1-2 minutes...';

    var res = await api('/api/autoposter/custom', {
      method: 'POST',
      body: JSON.stringify({ topic: topic, practiceArea: area, url: url, notes: notes })
    });

    btn.disabled = false;
    btn.textContent = '✍️ Generate & Publish Post';

    if (res && res.ok) {
      msg.textContent = '✅ ' + res.message;
      document.getElementById('customTopic').value = '';
      document.getElementById('customUrl').value = '';
      document.getElementById('customNotes').value = '';
      setTimeout(function(){ msg.textContent = ''; }, 15000);
    } else {
      msg.style.color = '#9C2B1E';
      msg.textContent = '❌ Failed to start. Check Render logs.';
    }
  }


// ── Manual Post ───────────────────────────────────────────

function initPoster() {
  var r = document.getElementById('posterResult');
  if (r) { r.style.display = 'none'; r.innerHTML = ''; }
  var m = document.getElementById('posterMsg');
  if (m) { m.textContent = ''; }
}

async function runAnalytics() {
    const btn = document.getElementById('runAnalyticsBtn');
    const msg = document.getElementById('analyticsMsg');
    btn.disabled = true;
    btn.textContent = 'Running...';

    const res = await api('/api/analytics/run', { method: 'POST' });
    btn.disabled = false;
    btn.textContent = '▶ Run Analytics Now';
    if (res?.ok) {
      msg.textContent = '✅ ' + res.message;
      setTimeout(() => loadAnalytics(), 120000);
    }
  }

  async function logout() {
    await api('/api/logout', { method: 'POST' });
    document.cookie = 'admin_token=; path=/; max-age=0';
    window.location.href = '/admin/login';
  }

  // Load dashboard on start
  loadDashboard();

// ── Wave 1: Lead Pipeline ─────────────────────────────────

var STAGES = [
  {key:'new_lead',         label:'New Lead'},
  {key:'qualified',        label:'Qualified'},
  {key:'consult_scheduled',label:'Consult Scheduled'},
  {key:'consult_held',     label:'Consult Held'},
  {key:'retainer_sent',    label:'Retainer Sent'},
  {key:'signed',           label:'Signed'},
  {key:'lost',             label:'Lost'},
];

async function loadPipeline() {
  var filterEl = document.getElementById('pipelineFilter');
  var filter = filterEl ? filterEl.value : 'active';
  var data = await api(filter === 'all' ? '/api/leads/all' : '/api/leads');
  var board = document.getElementById('pipelineBoard');
  if (!data) { board.innerHTML = '<p style="color:#9C2B1E;padding:12px">Failed to load — check DB</p>'; return; }

  var byStage = {};
  STAGES.forEach(function(s){ byStage[s.key] = []; });
  data.forEach(function(lead){ if(byStage[lead.stage]) byStage[lead.stage].push(lead); });

  var html = '<div class="kanban-board">';
  STAGES.forEach(function(s) {
    var leads = byStage[s.key] || [];
    html += '<div class="kanban-col">';
    html += '<div class="kanban-col-header">' + s.label + ' <span class="kanban-count">' + leads.length + '</span></div>';
    if (!leads.length) html += '<p style="font-size:12px;color:#5E5854;text-align:center;padding:8px">Empty</p>';
    leads.forEach(function(lead) {
      var hrs = parseFloat(lead.hours_in_stage || 0);
      var sc = hrs > 168 ? 'stale-crit' : hrs > 72 ? 'stale-warn' : '';
      var tc = hrs > 168 ? 'crit' : hrs > 72 ? 'warn' : '';
      var ac = (!lead.acknowledged_at && s.key === 'new_lead') ? 'unacknowledged' : '';
      var ts = hrs < 1 ? 'Just now' : (hrs < 24 ? Math.round(hrs)+'h' : Math.round(hrs/24)+'d');
      html += '<div class="lead-card '+sc+' '+ac+'" id="lead-'+lead.id+'">';
      html += '<div class="lead-name">'+(lead.name||'Unknown')+'</div>';
      html += '<div class="lead-meta">'+platBadge(lead.platform)+' '+(lead.contact||'')+'</div>';
      html += '<div class="lead-case">'+(lead.case_type||'General')+'</div>';
      html += '<div class="lead-time '+tc+'">&#9201; '+ts+' in stage</div>';
      if (!lead.acknowledged_at && s.key === 'new_lead') {
        html += '<button class="action-btn" style="font-size:11px;padding:4px 10px;margin-top:6px" data-leadid="'+lead.id+'" onclick="acknowledgeLead(this.getAttribute(\'data-leadid\'))">Acknowledge</button>';
      }
      var opts = '';
      STAGES.forEach(function(st){
        opts += '<option value="'+st.key+'"'+(st.key===lead.stage?' selected':'')+'>'+st.label+'</option>';
      });
      html += '<select class="stage-select" data-leadid="'+lead.id+'" onchange="moveLead(this.getAttribute(\'data-leadid\'),this.value)">'+opts+'</select>';
      html += '</div>';
    });
    html += '</div>';
  });
  html += '</div>';
  board.innerHTML = html;
}

async function moveLead(id, stage) {
  var res = await api('/api/leads/'+id+'/stage', {method:'PATCH', body:JSON.stringify({stage:stage})});
  if (res && res.ok) { setTimeout(loadPipeline, 300); }
  else { alert('Failed to update stage'); loadPipeline(); }
}

async function acknowledgeLead(id) {
  await api('/api/leads/'+id+'/acknowledge', {method:'POST'});
  loadPipeline();
}

// ── Wave 1: Conflict Checks ───────────────────────────────

async function loadConflicts() {
  var data = await api('/api/conflicts');
  var el = document.getElementById('conflictsTable');
  if (!data) return;
  if (!data.length) { el.innerHTML = '<p style="color:#5E5854;font-size:13px;padding:12px">No conflicts yet.</p>'; return; }
  var dc = {pending:'disp-pending',possible:'disp-possible',cleared:'disp-cleared',denied:'disp-denied'};
  var rows = '';
  data.forEach(function(r) {
    var m = []; try { m = Array.isArray(r.matches)?r.matches:JSON.parse(r.matches||'[]'); } catch(e){}
    var ms = !m.length ? 'None' : m.map(function(x){ return (x.name||'')+'('+(x.case_type||'?')+')'; }).join(', ');
    rows += '<tr>'
      +'<td style="font-size:11px">'+new Date(r.checked_at).toLocaleDateString('en-US')+'</td>'
      +'<td style="font-weight:bold">'+(r.search_name||'—')+'</td>'
      +'<td>'+(r.intake_case_type||'—')+'</td>'
      +'<td style="font-size:12px">'+ms+'</td>'
      +'<td><span class="badge '+(dc[r.disposition]||'')+'">'+r.disposition+'</span></td>'
      +'<td>'
      +'<button class="disp-btn disp-cleared" data-cid="'+r.id+'" onclick="setDisposition(this.getAttribute(\'data-cid\'),\'cleared\')">Clear</button>'
      +'<button class="disp-btn disp-denied" data-cid="'+r.id+'" onclick="setDisposition(this.getAttribute(\'data-cid\'),\'denied\')">Deny</button>'
      +'</td></tr>';
  });
  el.innerHTML = '<table><thead><tr><th>Date</th><th>Name</th><th>Case</th><th>Matches</th><th>Status</th><th>Action</th></tr></thead><tbody>'+rows+'</tbody></table>';
}

async function setDisposition(id, disp) {
  await api('/api/conflicts/'+id+'/disposition', {method:'PATCH', body:JSON.stringify({disposition:disp})});
  loadConflicts();
}

// ── Wave 1: Knowledge Gaps ────────────────────────────────

async function loadQuestions() {
  var weekly = await api('/api/questions/weekly');
  var all    = await api('/api/questions');
  var we = document.getElementById('questionsWeekly');
  var ae = document.getElementById('questionsTable');
  if (weekly && weekly.length) {
    var wr = '';
    weekly.forEach(function(r){
      wr += '<tr><td style="font-size:13px">'+r.question.substring(0,120)+(r.question.length>120?'...':'')+'</td>'
          + '<td style="text-align:center;font-weight:bold;color:#A34C00">'+r.n+'</td>'
          + '<td style="font-size:11px">'+new Date(r.last_seen).toLocaleDateString('en-US')+'</td></tr>';
    });
    we.innerHTML = '<table><thead><tr><th>Question</th><th>Count</th><th>Last Seen</th></tr></thead><tbody>'+wr+'</tbody></table>';
  } else {
    we.innerHTML = '<p style="color:#2F6B3F;font-size:13px;padding:12px">No gaps this week!</p>';
  }
  if (all && all.length) {
    var ar = '';
    all.forEach(function(r){
      ar += '<tr><td style="font-size:11px">'+new Date(r.created_at).toLocaleDateString('en-US')+'</td>'
          + '<td>'+platBadge(r.platform)+'</td>'
          + '<td style="font-size:12px">'+r.question.substring(0,100)+(r.question.length>100?'...':'')+'</td>'
          + '<td style="font-size:11px;color:#5E5854">'+(r.zara_response||'').substring(0,80)+'...</td>'
          + '<td><button class="action-btn" style="font-size:11px;padding:4px 10px" data-qid="'+r.id+'" onclick="resolveQuestion(this.getAttribute(\'data-qid\'),this)">Resolved</button></td></tr>';
    });
    ae.innerHTML = '<table><thead><tr><th>Date</th><th>Platform</th><th>Question</th><th>Zara Said</th><th>Action</th></tr></thead><tbody>'+ar+'</tbody></table>';
  } else {
    ae.innerHTML = '<p style="color:#2F6B3F;font-size:13px;padding:12px">No open questions!</p>';
  }
}

async function resolveQuestion(id, btn) {
  btn.disabled = true; btn.textContent = 'Done';
  await api('/api/questions/'+id+'/resolve', {method:'PATCH'});
  btn.closest('tr').style.opacity = '0.4';
}

// ── Wave 1: Audit Log ─────────────────────────────────────

async function loadAudit() {
  var data = await api('/api/audit');
  var el = document.getElementById('auditTable');
  if (!data) return;
  if (!data.length) { el.innerHTML = '<p style="color:#5E5854;font-size:13px;padding:12px">No events yet.</p>'; return; }
  var rows = '';
  data.forEach(function(r) {
    var t = new Date(r.created_at).toLocaleString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    var ch = r.old_value && r.new_value ? r.old_value.substring(0,25)+' → '+r.new_value.substring(0,25) : (r.new_value||'').substring(0,40);
    rows += '<tr>'
      +'<td style="font-size:11px;white-space:nowrap">'+t+'</td>'
      +'<td style="font-weight:bold;font-size:12px">'+r.actor+'</td>'
      +'<td style="font-size:12px">'+r.action+'</td>'
      +'<td style="font-size:11px;color:#5E5854">'+(r.target||'—')+'</td>'
      +'<td style="font-size:11px">'+ch+'</td>'
      +'<td style="font-size:10px;color:#5E5854">'+(r.ip_address||'—')+'</td>'
      +'</tr>';
  });
  el.innerHTML = '<table><thead><tr><th>Time (PT)</th><th>Actor</th><th>Action</th><th>Target</th><th>Change</th><th>IP</th></tr></thead><tbody>'+rows+'</tbody></table>';
}

// ── Autoposter button ─────────────────────────────────────

async function runAutoposter() {
  var btn = document.getElementById('runAutoposterBtn');
  var msg = document.getElementById('autoposterMsg');
  btn.disabled = true; btn.textContent = 'Running...'; msg.textContent = '';
  var res = await api('/api/autoposter/run', {method:'POST'});
  btn.disabled = false; btn.textContent = '▶ Run Auto-Poster Now';
  if (res && res.ok) { msg.textContent = '✅ ' + res.message; setTimeout(function(){ msg.textContent=''; }, 10000); }
  else { msg.style.color = '#9C2B1E'; msg.textContent = '❌ Failed to start'; }
}

// ── Wave 2: Conversation Scores ───────────────────────────

function scoreColor(n) {
  if (n >= 8) return 'score-high';
  if (n >= 6) return 'score-mid';
  return 'score-low';
}

function scoreBadge(n, label) {
  return '<span class="score-badge ' + scoreColor(n) + '">' + label + ': ' + n + '</span> ';
}

async function loadScores() {
  var flagged = await api('/api/scores/flagged');
  var all     = await api('/api/scores');

  var fe = document.getElementById('scoresFlagged');
  var ae = document.getElementById('scoresAll');
  if (!flagged && !all) { fe.innerHTML = '<p style="color:#5E5854;font-size:13px;padding:12px">Setting up — will populate after first conversations.</p>'; ae.innerHTML = ''; return; }

  if (flagged && flagged.length) {
    var fr = '';
    flagged.forEach(function(r) {
      fr += '<tr class="needs-review">'
        + '<td style="font-size:11px;white-space:nowrap">' + new Date(r.created_at).toLocaleDateString('en-US') + '</td>'
        + '<td>' + platBadge(r.platform) + '</td>'
        + '<td>' + scoreBadge(r.score_accuracy,'Acc') + scoreBadge(r.score_tone,'Tone') + scoreBadge(r.score_disclaimer,'Disc') + '</td>'
        + '<td><span class="score-badge score-low">UPL: ' + r.score_upl_risk + '</span></td>'
        + '<td><span class="score-badge ' + scoreColor(r.score_overall) + '">Overall: ' + r.score_overall + '</span></td>'
        + '<td style="font-size:12px;max-width:300px;color:#2B2523">' + (r.summary||'').substring(0,150) + '</td>'
        + '</tr>';
    });
    fe.innerHTML = '<table><thead><tr><th>Date</th><th>Platform</th><th>Scores</th><th>UPL</th><th>Overall</th><th>Summary</th></tr></thead><tbody>' + fr + '</tbody></table>';
  } else {
    fe.innerHTML = '<p style="color:#2F6B3F;font-size:13px;padding:12px">✅ No conversations flagged for review!</p>';
  }

  if (all && all.length) {
    var ar = '';
    all.slice(0, 50).forEach(function(r) {
      ar += '<tr>'
        + '<td style="font-size:11px;white-space:nowrap">' + new Date(r.created_at).toLocaleDateString('en-US') + '</td>'
        + '<td>' + platBadge(r.platform) + '</td>'
        + '<td style="font-size:11px">' + r.message_count + ' msgs</td>'
        + '<td>' + scoreBadge(r.score_accuracy,'Acc') + scoreBadge(r.score_tone,'Tone') + scoreBadge(r.score_disclaimer,'Disc') + '</td>'
        + '<td><span class="score-badge ' + scoreColor(r.score_overall) + '">' + r.score_overall + '/10</span></td>'
        + '<td style="font-size:12px;max-width:200px;color:#5E5854">' + (r.summary||'').substring(0,100) + '</td>'
        + '</tr>';
    });
    ae.innerHTML = '<table><thead><tr><th>Date</th><th>Platform</th><th>Msgs</th><th>Scores</th><th>Overall</th><th>Summary</th></tr></thead><tbody>' + ar + '</tbody></table>';
  } else {
    ae.innerHTML = '<p style="color:#5E5854;font-size:13px;padding:12px">No scored conversations yet — scores generate automatically after each session ends.</p>';
  }
}

// ── Wave 2: SOL Tracker ───────────────────────────────────

async function loadSol() {
  var data = await api('/api/sol');
  var el = document.getElementById('solTable');
  if (!data) { el.innerHTML = '<p style="color:#5E5854;font-size:13px;padding:12px">Setting up — DB tables initializing on next deploy.</p>'; return; }
  if (!data.length) {
    el.innerHTML = '<p style="color:#5E5854;font-size:13px;padding:12px">No deadlines tracked yet. Add one above or they auto-create from intake.</p>';
    return;
  }
  var rows = '';
  data.forEach(function(r) {
    var days = Math.ceil((new Date(r.deadline_date) - new Date()) / (1000*60*60*24));
    var urgency = days <= 7 ? 'score-low' : days <= 30 ? 'score-mid' : 'score-high';
    var expired = days < 0;
    rows += '<tr>'
      + '<td style="font-weight:bold">' + (r.client_name||'—') + '</td>'
      + '<td style="font-size:12px">' + (r.case_type||'—') + '</td>'
      + '<td style="font-size:12px">' + (r.incident_date ? new Date(r.incident_date).toLocaleDateString('en-US') : '—') + '</td>'
      + '<td style="font-weight:bold">' + (r.deadline_date ? new Date(r.deadline_date).toLocaleDateString('en-US') : '—') + '</td>'
      + '<td><span class="score-badge ' + (expired ? 'score-low' : urgency) + '">' + (expired ? '⚠️ EXPIRED' : days + ' days') + '</span></td>'
      + '<td style="font-size:11px">'
      + (r.alerted_90 ? '✅' : '⬜') + '90d '
      + (r.alerted_30 ? '✅' : '⬜') + '30d '
      + (r.alerted_7  ? '✅' : '⬜') + '7d '
      + (r.alerted_1  ? '✅' : '⬜') + '1d'
      + '</td>'
      + '<td style="font-size:11px;color:#5E5854">' + (r.notes||'') + '</td>'
      + '<td><button class="action-btn" style="font-size:11px;padding:3px 10px;background:#9C2B1E" data-sid="' + r.id + '" onclick="deleteSol(this.getAttribute(\'data-sid\'))">Delete</button></td>'
      + '</tr>';
  });
  el.innerHTML = '<table><thead><tr><th>Client</th><th>Case Type</th><th>Incident</th><th>Deadline</th><th>Time Left</th><th>Alerts</th><th>Notes</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
}

async function addSolDeadline() {
  var name      = document.getElementById('solName').value.trim();
  var caseType  = document.getElementById('solType').value;
  var date      = document.getElementById('solDate').value;
  var notes     = document.getElementById('solNotes').value.trim();
  var resultEl  = document.getElementById('solResult');

  if (!name || !date) { resultEl.innerHTML = '<span style="color:#9C2B1E">Please fill in client name and incident date.</span>'; return; }

  var res = await api('/api/sol', { method: 'POST', body: JSON.stringify({ clientName: name, caseType, incidentDate: date, notes }) });
  if (res && res.ok) {
    resultEl.innerHTML = '<span style="color:#2F6B3F">✅ Deadline added: <strong>' + res.deadline + '</strong> (' + res.years + ' yr SOL, ' + res.daysLeft + ' days left)</span>';
    document.getElementById('solName').value = '';
    document.getElementById('solDate').value = '';
    document.getElementById('solNotes').value = '';
    loadSol();
  } else {
    resultEl.innerHTML = '<span style="color:#9C2B1E">❌ Failed to add deadline</span>';
  }
}

async function deleteSol(id) {
  if (!confirm('Delete this deadline?')) return;
  await api('/api/sol/' + id, { method: 'DELETE' });
  loadSol();
}

// ── Wave 2: Drip Campaigns ────────────────────────────────

async function loadDrip() {
  var data = await api('/api/drip');
  var el = document.getElementById('dripTable');
  if (!data) { el.innerHTML = '<p style="color:#5E5854;font-size:13px;padding:12px">Setting up — DB tables initializing on next deploy.</p>'; return; }
  if (!data.length) {
    el.innerHTML = '<p style="color:#5E5854;font-size:13px;padding:12px">No drip campaigns yet — they start automatically after intake completion.</p>';
    return;
  }
  var rows = '';
  data.forEach(function(r) {
    var statusColor = r.status === 'active' ? '#2F6B3F' : '#5E5854';
    var sentPct = r.total_msgs > 0 ? Math.round((r.sent_msgs / r.total_msgs) * 100) : 0;
    rows += '<tr>'
      + '<td style="font-weight:bold">' + (r.client_name||'Unknown') + '</td>'
      + '<td style="font-size:12px">' + (r.case_type||'—') + '</td>'
      + '<td>' + platBadge(r.platform) + '</td>'
      + '<td><span style="color:' + statusColor + ';font-weight:bold;font-size:12px">' + r.status.toUpperCase() + '</span></td>'
      + '<td style="font-size:12px">' + r.sent_msgs + ' / ' + r.total_msgs + ' sent (' + sentPct + '%)</td>'
      + '<td style="font-size:11px;white-space:nowrap">' + new Date(r.started_at).toLocaleDateString('en-US') + '</td>'
      + '<td style="font-size:11px;color:#5E5854">' + (r.stop_reason||'') + '</td>'
      + '<td>' + (r.status === 'active'
        ? '<button class="action-btn" style="font-size:11px;padding:3px 10px;background:#9C2B1E" data-did="' + r.id + '" onclick="stopDrip(this.getAttribute(\'data-did\'))">Stop</button>'
        : '') + '</td>'
      + '</tr>';
  });
  el.innerHTML = '<table><thead><tr><th>Client</th><th>Case Type</th><th>Platform</th><th>Status</th><th>Progress</th><th>Started</th><th>Stop Reason</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
}

async function stopDrip(id) {
  if (!confirm('Stop this drip campaign?')) return;
  await api('/api/drip/' + id + '/stop', { method: 'POST' });
  loadDrip();
}

// ── Wave 2: Prompt Version History (in System Prompt page) ──

async function loadPromptHistory() {
  var data = await api('/api/prompt/history');
  var el = document.getElementById('promptHistory');
  if (!el) return;
  if (!data || !data.length) {
    el.innerHTML = '<p style="color:#5E5854;font-size:13px">No version history yet.</p>';
    return;
  }
  var rows = '';
  data.forEach(function(r) {
    var time = new Date(r.updated_at).toLocaleString('en-US', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    rows += '<tr>'
      + '<td style="font-size:11px;white-space:nowrap">' + time + '</td>'
      + '<td style="font-size:11px;color:#5E5854">' + (r.updated_by||'admin') + '</td>'
      + '<td style="font-size:12px;max-width:400px;font-family:monospace">' + (r.preview||'').substring(0,120) + '...</td>'
      + '<td><button class="action-btn" style="font-size:11px;padding:3px 10px" data-vid="' + r.id + '" onclick="rollbackPrompt(this.getAttribute(\'data-vid\'))">Restore</button></td>'
      + '</tr>';
  });
  el.innerHTML = '<table><thead><tr><th>Saved At</th><th>By</th><th>Preview</th><th>Action</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

async function rollbackPrompt(id) {
  if (!confirm('Restore this version? It will become the live prompt immediately.')) return;
  var res = await api('/api/prompt/rollback/' + id, { method: 'POST' });
  if (res && res.ok) {
    document.getElementById('promptEditor').value = res.prompt;
    document.getElementById('saveMsg').textContent = '✅ Rolled back to version ' + id + ' — live now!';
    setTimeout(function(){ document.getElementById('saveMsg').textContent = ''; }, 4000);
    loadPromptHistory();
  }
}

// ── Manual Post Creator ───────────────────────────────────

var _previewPost = null;
var _postDoc = null;          // { name, text, html, truncated } from /api/post/extract

// Like api(), but keeps the server's error text so it can be shown.
async function postApi(path, body) {
  try {
    var res = await fetch('/admin' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': getCookie('admin_token') },
      body: JSON.stringify(body)
    });
    if (res.status === 401) { window.location.href = '/admin/login'; return { ok: false, error: 'Signed out' }; }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) return { ok: false, error: data.error || ('Server error ' + res.status) };
    return data;
  } catch (e) { return { ok: false, error: e.message }; }
}

function postSay(text, color) {
  var msg = document.getElementById('postMsg');
  msg.style.color = color || '#5E5854'; msg.textContent = text || '';
}

function onPostMode() {
  var own = document.getElementById('postMode').value === 'as_written';
  document.getElementById('postOwnWrap').style.display = own ? 'block' : 'none';
}

function clearPostFile() {
  _postDoc = null;
  document.getElementById('postFile').value = '';
  document.getElementById('postFileMsg').textContent = '';
  document.getElementById('postFileClear').style.display = 'none';
}

function onPostFile(input) {
  var f = input.files && input.files[0];
  var note = document.getElementById('postFileMsg');
  _postDoc = null;
  document.getElementById('postFileClear').style.display = 'none';
  if (!f) { note.textContent = ''; return; }
  if (f.size > 15 * 1024 * 1024) {
    note.style.color = '#9C2B1E';
    note.textContent = 'That file is ' + (f.size / 1048576).toFixed(1) + ' MB. The limit is 15 MB.';
    input.value = ''; return;
  }
  note.style.color = '#5E5854'; note.textContent = 'Reading ' + f.name + '...';
  var reader = new FileReader();
  reader.onerror = function () { note.style.color = '#9C2B1E'; note.textContent = 'Could not read the file from your computer.'; };
  reader.onload = async function () {
    var b64 = String(reader.result || '');
    b64 = b64.substring(b64.indexOf(',') + 1);
    var res = await postApi('/api/post/extract', { filename: f.name, content_base64: b64 });
    if (!res.ok) {
      note.style.color = '#9C2B1E'; note.textContent = res.error || 'Could not read that file.';
      input.value = ''; return;
    }
    _postDoc = { name: res.name, text: res.text, html: res.html || '', truncated: !!res.truncated };
    note.style.color = '#2F6B3F';
    note.textContent = 'Read ' + res.name + ': ' + Number(res.chars).toLocaleString('en-US') + ' characters'
      + (res.pages ? ', ' + res.pages + ' page' + (res.pages === 1 ? '' : 's') : '') + '.'
      + (res.warning ? ' ' + res.warning : '');
    document.getElementById('postFileClear').style.display = 'inline-block';
  };
  reader.readAsDataURL(f);
}

// Everything the generate route needs, or a reason it cannot run yet.
function postPayload() {
  var topic   = document.getElementById('postTopic').value.trim();
  var mode    = document.getElementById('postMode').value;
  var ownText = document.getElementById('postOwnText').value.trim();
  if (mode === 'as_written') {
    if (!ownText && !_postDoc) return { error: 'Paste your article, or upload it as a Word or text file.' };
  } else if (!topic && !_postDoc) {
    return { error: 'Enter a topic or link, or upload a document to write from.' };
  }
  return {
    topic: topic,
    practiceArea: document.getElementById('postArea').value,
    context: document.getElementById('postContext').value.trim(),
    // With a document, the document is the source: no web search unless a topic link was also given.
    useSearch: _postDoc ? false : document.getElementById('postSearch').value === 'true',
    mode: mode,
    source: _postDoc,
    ownText: ownText,
    anonymize: document.getElementById('postAnon').checked
  };
}

function showPostPreview(post, issues, privacy) {
  _previewPost = post;
  var head = '';
  if (privacy && privacy.length) head += 'PRIVACY CHECK - these details from the document appear in the draft, so it will be saved to WordPress as a DRAFT, not published. Remove them there, or untick "Leave out names" if this is a public decision:\n  - ' + privacy.join('\n  - ') + '\n';
  if (post.asWritten) head += 'YOUR ARTICLE, AS WRITTEN - wording unchanged.\n';
  if (post.fromDocument) head += 'WRITTEN FROM: ' + post.fromDocument
    + (document.getElementById('postAnon').checked ? ' - names and identifying details left out.' : ' - party names kept.') + '\n';
  if (post.fromDocument) head += 'Check it against the document before publishing: every statement about the matter should be in the document.\n';
  if (issues && issues.length) head += 'RULE 7.1 CHECK - this would be saved as a DRAFT, not published:\n  - ' + issues.join('\n  - ') + '\n';
  if (head) head += '\n';
  var body = String(post.content || '');
  var cut = body.indexOf('<style>.tez-ab{');
  if (cut > 0) body = body.substring(0, cut);
  document.getElementById('postPreviewContent').textContent = head +
    '📌 TITLE: ' + (post.title || '(no title)') + '\n\n' +
    '🏷 CATEGORY: ' + (post.category || '') + '\n\n' +
    '📝 CONTENT:\n' + body.replace(/<\/(p|h2|h3|li|ul|ol|div)>/g, '\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n') + '\n\n' +
    '🔍 META: ' + (post.metaDescription || '');
  document.getElementById('postPreviewCard').style.display = 'block';
  document.getElementById('postPreviewCard').scrollIntoView({ behavior: 'smooth' });
}

// What happened, in words: which language went live, which was held, and
// whether the social drafts are on their way to Telegram.
function describePublish(res) {
  var parts = (res.results || []).map(function (r) {
    return r.lang + (r.status === 'publish' ? ' published' : ' saved as a draft for your review') + ' (ID ' + r.id + ')';
  });
  var out = parts.join(', ') + '.';
  if (res.social) {
    if (res.social.queued) out += ' ' + res.social.queued + ' social draft' + (res.social.queued === 1 ? '' : 's') + ' sent to Telegram for your approval.';
    else out += ' No social drafts' + (res.social.notes && res.social.notes.length ? ': ' + res.social.notes[0] : '.');
  }
  return out;
}

function resetPostForm() {
  document.getElementById('postTopic').value = '';
  document.getElementById('postContext').value = '';
  document.getElementById('postOwnText').value = '';
  clearPostFile();
}

async function previewManualPost() {
  var btn = document.getElementById('previewBtn');
  var payload = postPayload();
  if (payload.error) { postSay(payload.error, '#9C2B1E'); return; }

  btn.disabled = true; btn.textContent = '⏳ Generating...';
  postSay(payload.mode === 'as_written' ? 'Preparing your article...'
    : (payload.source ? 'Reading the document and writing the post - this can take a minute...' : 'Writing post - usually takes 15-30 seconds...'));
  document.getElementById('postPreviewCard').style.display = 'none';

  var res = await postApi('/api/post/generate', payload);

  btn.disabled = false; btn.textContent = '👁 Preview First';
  if (!res.ok) { postSay('❌ ' + (res.error || 'Generation failed.'), '#9C2B1E'); return; }
  postSay('');
  showPostPreview(res.post, res.issues, res.privacy);
}

async function publishPreview() {
  if (!_previewPost) return;
  var btn  = document.getElementById('publishBtn');
  var area = document.getElementById('postArea').value;
  var lang = document.getElementById('postLang').value;
  var topic = document.getElementById('postTopic').value.trim() || _previewPost.title || '';

  btn.disabled = true; btn.textContent = '⏳ Publishing...';

  var res = await postApi('/api/post/publish', { post: _previewPost, topic: topic, practiceArea: area, languages: lang });

  btn.disabled = false; btn.textContent = '✅ Publish Now';

  if (res.ok) {
    postSay('✅ ' + describePublish(res), '#2F6B3F');
    document.getElementById('postPreviewCard').style.display = 'none';
    resetPostForm();
    _previewPost = null;
    loadManualPost();
  } else {
    postSay('❌ Publish failed: ' + (res.error || 'unknown error'), '#9C2B1E');
  }
}

async function submitManualPost() {
  var btn = document.getElementById('postBtn');
  var payload = postPayload();
  if (payload.error) { postSay(payload.error, '#9C2B1E'); return; }

  // Anything built from an uploaded document or from your own text is shown
  // to you first. One click must not put a client's order on the website.
  if (payload.source || payload.mode === 'as_written') {
    postSay('Showing you the draft first - publish it from the preview below.');
    return previewManualPost();
  }

  var lang = document.getElementById('postLang').value;
  btn.disabled = true; btn.textContent = '⏳ Generating & Publishing...';
  postSay('Writing post - usually takes 15-30 seconds...');

  var genRes = await postApi('/api/post/generate', payload);
  if (!genRes.ok) {
    btn.disabled = false; btn.textContent = '🚀 Generate & Publish';
    postSay('❌ ' + (genRes.error || 'Generation failed'), '#9C2B1E');
    return;
  }

  postSay('✍️ Post written! Publishing to WordPress...');
  var pubRes = await postApi('/api/post/publish', { post: genRes.post, topic: payload.topic, practiceArea: payload.practiceArea, languages: lang });

  btn.disabled = false; btn.textContent = '🚀 Generate & Publish';
  if (pubRes.ok) {
    postSay('✅ ' + describePublish(pubRes), '#2F6B3F');
    resetPostForm();
    loadManualPost();
  } else {
    postSay('❌ Publish failed: ' + (pubRes.error || 'unknown error'), '#9C2B1E');
  }
}

function cancelPreview() {
  _previewPost = null;
  document.getElementById('postPreviewCard').style.display = 'none';
}

async function loadManualPost() {
  api('/api/post/init', { method: 'POST' }).catch(function(){});

  var data = await api('/api/post/history');
  var el = document.getElementById('postHistory');
  if (!data || !data.length) {
    el.innerHTML = '<p style="color:#5E5854;font-size:13px;padding:12px">No manual posts yet. Create your first one above!</p>';
    return;
  }
  var rows = '';
  data.forEach(function(r) {
    var ids = [];
    try { ids = JSON.parse(r.wp_post_ids || '[]'); } catch(e) {}
    rows += '<tr>'
      + '<td style="font-size:11px;white-space:nowrap">' + new Date(r.created_at).toLocaleDateString('en-US') + '</td>'
      + '<td style="font-weight:bold;font-size:13px">' + (r.title || '—') + '</td>'
      + '<td style="font-size:12px">' + (r.practice_area || '—') + '</td>'
      + '<td style="font-size:12px;max-width:250px;color:#5E5854">' + (r.topic || '').substring(0, 80) + '</td>'
      + '<td style="font-size:11px">' + ids.length + ' post(s)</td>'
      + '</tr>';
  });
  el.innerHTML = '<table><thead><tr><th>Date</th><th>Title</th><th>Area</th><th>Topic</th><th>Published</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

// ============================================================
//  RESEARCH TAB — Case Law, Statutes, Immigration, Verify, Cache
// ============================================================

function showResearchTab(tab) {
  var tabs = ['caselaw','statutes','immigration','verify','cache','judges'];
  tabs.forEach(function(t) {
    var sub = document.getElementById('rsub-' + t);
    if (sub) sub.style.display = t === tab ? 'block' : 'none';
    var btn = document.getElementById('rtab-' + t);
    if (btn) btn.style.opacity = t === tab ? '1' : '.6';
  });
  if (tab === 'cache') loadCacheStats();
  if (tab === 'judges') loadJudgesIndex();
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                       .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── CourtListener case law search ───────────────────────────
async function runAdminCLSearch() {
  var qEl     = document.getElementById('cl-query');
  var areaEl  = document.getElementById('cl-area');
  var dateEl  = document.getElementById('cl-date');
  var sortEl  = document.getElementById('cl-sort');

  var q     = qEl ? qEl.value.trim() : '';
  var court = areaEl ? areaEl.value : '';
  var date  = dateEl ? dateEl.value : '2020-01-01';
  var sort  = sortEl ? sortEl.value : 'score';

  if (!q) {
    var resultsEl = document.getElementById('cl-results');
    if (resultsEl) resultsEl.innerHTML = '<p style="color:#9C2B1E;font-size:13px;padding:12px">Please enter a search query.</p>';
    return;
  }

  var loadingEl = document.getElementById('cl-loading');
  var resultsEl = document.getElementById('cl-results');
  var warningEl = document.getElementById('cl-warning');

  if (loadingEl) loadingEl.style.display = 'block';
  if (resultsEl) resultsEl.innerHTML = '';
  if (warningEl) warningEl.style.display = 'none';

  try {
    var params = new URLSearchParams({
      q: q,
      type: 'o',
      stat_Published: 'on',
      court: court,
      filed_after: date,
      order_by: sort,
      page_size: '8'
    });
    var headers = {};
    var savedToken = localStorage.getItem('cl_token');
    if (savedToken) headers['Authorization'] = 'Token ' + savedToken;

    var resp = await fetch('https://www.courtlistener.com/api/rest/v4/search/?' + params, { headers: headers });
    if (resp.status === 429) throw new Error('Rate limited — add a free CourtListener API token in Settings');
    var data = await resp.json();
    var results = data.results || [];

    if (warningEl) warningEl.style.display = results.length ? 'block' : 'none';
    if (resultsEl) {
      resultsEl.innerHTML = results.length
        ? results.map(function(r) { return renderCaseCard(r); }).join('')
        : '<p style="color:#5E5854;font-size:13px;padding:12px">No results. Try broader terms.</p>';
    }
  } catch(err) {
    if (resultsEl) resultsEl.innerHTML = '<p style="color:#9C2B1E;font-size:13px;padding:12px">❌ ' + err.message + '</p>';
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
  }
}

// ── Immigration search (9th Circuit + BIA) ──────────────────
async function runAdminImmSearch() {
  var qEl = document.getElementById('imm-query');
  var q = qEl ? qEl.value.trim() : '';
  if (!q) return;

  var loadingEl = document.getElementById('imm-loading');
  var resultsEl = document.getElementById('imm-results');

  if (loadingEl) loadingEl.style.display = 'block';
  if (resultsEl) resultsEl.innerHTML = '';

  try {
    var params = new URLSearchParams({
      q: q,
      type: 'o',
      stat_Published: 'on',
      court: 'ca9,bia',
      filed_after: '2005-01-01',
      order_by: 'score',
      page_size: '8'
    });
    var headers = {};
    var savedToken = localStorage.getItem('cl_token');
    if (savedToken) headers['Authorization'] = 'Token ' + savedToken;

    var resp = await fetch('https://www.courtlistener.com/api/rest/v4/search/?' + params, { headers: headers });
    var data = await resp.json();
    var results = data.results || [];

    if (resultsEl) {
      resultsEl.innerHTML = results.length
        ? results.map(function(r) { return renderCaseCard(r); }).join('')
        : '<p style="color:#5E5854;font-size:13px;padding:12px">No results found.</p>';
    }
  } catch(err) {
    if (resultsEl) resultsEl.innerHTML = '<p style="color:#9C2B1E;font-size:13px">❌ ' + err.message + '</p>';
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
  }
}

// ── Render individual case card ─────────────────────────────
function renderCaseCard(r) {
  var name     = esc(r.caseName || r.case_name || 'Unknown');
  var citation = esc((r.citation || []).join(', ') || 'No citation');
  var court    = esc(r.court || '');
  var date     = r.dateFiled || r.date_filed || '';
  var snippet  = esc((r.snippet || '').replace(/<[^>]+>/g, ' ').substring(0, 250));
  var url      = r.absolute_url ? 'https://www.courtlistener.com' + r.absolute_url : '#';

  return '<div style="background:#fff;border:1px solid #E8E3DC;border-radius:8px;padding:14px;margin-bottom:12px">'
    + '<div style="font-weight:bold;color:#2B2523;font-size:14px;margin-bottom:4px">' + name + '</div>'
    + '<div style="font-size:12px;color:#5E5854;margin-bottom:6px">' + citation + ' • ' + court + ' • ' + (date ? new Date(date).toLocaleDateString('en-US') : '') + '</div>'
    + (snippet ? '<div style="font-size:13px;color:#2B2523;margin-bottom:8px;line-height:1.4">' + snippet + '...</div>' : '')
    + '<a href="' + url + '" target="_blank" style="color:#A34C00;font-size:12px;font-weight:bold;text-decoration:none">📄 Read full opinion →</a>'
    + '</div>';
}

// ── CA Statute lookup ───────────────────────────────────────
async function runStatuteSearch() {
  var codeEl    = document.getElementById('stat-code');
  var sectionEl = document.getElementById('stat-section');

  var code    = codeEl    ? codeEl.value : 'CCP';
  var section = sectionEl ? sectionEl.value.trim() : '';

  if (!section) return;

  var loadingEl = document.getElementById('stat-loading');
  var resultsEl = document.getElementById('stat-results');

  if (loadingEl) loadingEl.style.display = 'block';
  if (resultsEl) resultsEl.innerHTML = '';

  try {
    var res = await api('/api/research/statute?code=' + encodeURIComponent(code) + '&section=' + encodeURIComponent(section));
    if (resultsEl) {
      if (res && res.text) {
        resultsEl.innerHTML = '<div style="background:#fff;border:1px solid #E8E3DC;border-radius:8px;padding:16px">'
          + '<div style="font-weight:bold;color:#2B2523;font-size:15px;margin-bottom:8px">' + esc(code) + ' § ' + esc(section) + '</div>'
          + '<div style="font-size:13px;color:#2B2523;line-height:1.5;white-space:pre-wrap">' + esc(res.text) + '</div>'
          + (res.url ? '<a href="' + esc(res.url) + '" target="_blank" style="display:inline-block;margin-top:10px;color:#A34C00;font-size:12px;font-weight:bold;text-decoration:none">📄 View on leginfo.ca.gov →</a>' : '')
          + '</div>';
      } else {
        resultsEl.innerHTML = '<p style="color:#5E5854;font-size:13px;padding:12px">Statute not found. Verify the code and section number.</p>';
      }
    }
  } catch(err) {
    if (resultsEl) resultsEl.innerHTML = '<p style="color:#9C2B1E;font-size:13px">❌ ' + err.message + '</p>';
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
  }
}

// ── Citation verifier ───────────────────────────────────────
async function verifyCitation() {
  var inputEl = document.getElementById('verify-input');
  var citation = inputEl ? inputEl.value.trim() : '';
  if (!citation) return;

  var loadingEl = document.getElementById('verify-loading');
  var resultsEl = document.getElementById('verify-results');

  if (loadingEl) loadingEl.style.display = 'block';
  if (resultsEl) resultsEl.innerHTML = '';

  try {
    var res = await api('/api/research/verify', {
      method: 'POST',
      body: JSON.stringify({ citation: citation })
    });

    if (resultsEl) {
      if (res && res.found) {
        var statusColor = res.valid ? '#2F6B3F' : '#A34C00';
        var statusIcon = res.valid ? '✅' : '⚠️';
        resultsEl.innerHTML = '<div style="background:#fff;border:1px solid #E8E3DC;border-radius:8px;padding:16px">'
          + '<div style="font-size:15px;font-weight:bold;color:' + statusColor + ';margin-bottom:8px">' + statusIcon + ' ' + esc(res.status || 'Found') + '</div>'
          + '<div style="font-size:14px;color:#2B2523;font-weight:bold;margin-bottom:6px">' + esc(res.caseName || citation) + '</div>'
          + (res.court ? '<div style="font-size:12px;color:#5E5854;margin-bottom:4px">Court: ' + esc(res.court) + '</div>' : '')
          + (res.date ? '<div style="font-size:12px;color:#5E5854;margin-bottom:4px">Decided: ' + esc(res.date) + '</div>' : '')
          + (res.treatment ? '<div style="font-size:12px;color:#5E5854;margin-bottom:8px">Subsequent treatment: ' + esc(res.treatment) + '</div>' : '')
          + (res.url ? '<a href="' + esc(res.url) + '" target="_blank" style="color:#A34C00;font-size:12px;font-weight:bold">📄 Read opinion →</a>' : '')
          + '</div>';
      } else {
        resultsEl.innerHTML = '<div style="background:#FBEDEA;border:1px solid #FBEDEA;border-radius:8px;padding:16px"><span style="color:#9C2B1E;font-weight:bold">⚠️ Citation not found</span><br><span style="font-size:13px;color:#5E5854">Verify the citation manually before relying on it.</span></div>';
      }
    }
  } catch(err) {
    if (resultsEl) resultsEl.innerHTML = '<p style="color:#9C2B1E;font-size:13px">❌ ' + err.message + '</p>';
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
  }
}

// ── Answer cache statistics ─────────────────────────────────
async function loadCacheStats() {
  var el = document.getElementById('cacheStats');
  if (!el) return;

  var data = await api('/api/research/cache-stats');
  if (!data) {
    el.innerHTML = '<p style="color:#5E5854;font-size:13px;padding:12px">Cache stats not available.</p>';
    return;
  }

  var hitRate = data.totalLookups > 0 ? Math.round((data.cacheHits / data.totalLookups) * 100) : 0;
  el.innerHTML =
    '<div class="stats-grid">'
    +   '<div class="stat-card"><div class="stat-num">' + (data.totalCached || 0) + '</div><div class="stat-label">Cached Answers</div></div>'
    +   '<div class="stat-card"><div class="stat-num">' + (data.totalLookups || 0) + '</div><div class="stat-label">Total Lookups</div></div>'
    +   '<div class="stat-card"><div class="stat-num">' + (data.cacheHits || 0) + '</div><div class="stat-label">Cache Hits</div></div>'
    +   '<div class="stat-card"><div class="stat-num">' + hitRate + '%</div><div class="stat-label">Hit Rate</div></div>'
    + '</div>'
    + (data.estimatedSavings ? '<div style="background:#FAF8F5;border:1px solid #E8E3DC;border-radius:8px;padding:12px;margin-top:14px"><strong>💰 Estimated savings:</strong> $' + data.estimatedSavings.toFixed(2) + ' this month</div>' : '')
    + (data.recentEntries && data.recentEntries.length
        ? '<h3 style="margin-top:16px;font-size:14px;color:#2B2523">Recent Cache Entries</h3>'
          + '<table style="margin-top:8px"><thead><tr><th>Question</th><th>Practice Area</th><th>Hits</th><th>Last Used</th></tr></thead><tbody>'
          + data.recentEntries.slice(0,15).map(function(r) {
              return '<tr><td style="font-size:12px;max-width:300px">' + esc((r.question||'').substring(0,80)) + '</td>'
                + '<td style="font-size:12px">' + esc(r.practice_area||'—') + '</td>'
                + '<td style="text-align:center;font-weight:bold">' + (r.hit_count||0) + '</td>'
                + '<td style="font-size:11px;color:#5E5854">' + (r.last_used ? new Date(r.last_used).toLocaleDateString('en-US') : '—') + '</td></tr>';
            }).join('')
          + '</tbody></table>'
        : '');
}

// ── Judge Profile Index ─────────────────────────────────────
async function loadJudgesIndex() {
  var el = document.getElementById('judgesIndex');
  if (!el) return;

  el.innerHTML = '<p style="color:#5E5854;font-size:13px;padding:12px">Loading judge database...</p>';

  var data = await api('/api/research/judges');
  if (!data) {
    el.innerHTML = '<p style="color:#5E5854;font-size:13px;padding:12px">Judge database not yet populated. Run: <code>node judge-scanner.js --scan-all</code></p>';
    return;
  }

  var html = '<div class="stats-grid">'
    + '<div class="stat-card"><div class="stat-num">' + (data.totalJudges || 0) + '</div><div class="stat-label">Judges Indexed</div></div>'
    + '<div class="stat-card"><div class="stat-num">' + (data.totalRulings || 0) + '</div><div class="stat-label">Rulings Analyzed</div></div>'
    + '<div class="stat-card"><div class="stat-num">' + (data.totalInsights || 0) + '</div><div class="stat-label">Insights Built</div></div>'
    + '</div>';

  html += '<div style="margin-top:16px;display:flex;gap:8px">'
    + '<input type="text" id="judge-search-input" placeholder="Search by judge name (e.g. Wardlaw, Kronstadt)" style="flex:1;padding:8px 12px;border:1px solid #CFC8BE;border-radius:6px;font-size:13px" onkeydown="if(event.key===\'Enter\')searchJudge()" />'
    + '<button class="action-btn" onclick="searchJudge()" style="font-size:12px;padding:8px 16px">🔍 Look Up</button>'
    + '</div>';

  html += '<div id="judge-search-results" style="margin-top:14px"></div>';

  if (data.topJudges && data.topJudges.length) {
    html += '<h3 style="margin-top:20px;font-size:14px;color:#2B2523">Most-Indexed Judges</h3>';
    html += '<table style="margin-top:8px"><thead><tr><th>Judge</th><th>Court</th><th>Rulings</th><th>Last Updated</th></tr></thead><tbody>';
    data.topJudges.slice(0, 25).forEach(function(j) {
      html += '<tr style="cursor:pointer" onclick="lookupJudgeFromTable(\'' + esc(j.judge_name).replace(/'/g, "\\'") + '\')">';
      html += '<td style="font-weight:bold;color:#2B2523">' + esc(j.judge_name) + '</td>';
      html += '<td style="font-size:12px">' + esc(j.court) + '</td>';
      html += '<td style="text-align:center;font-weight:bold;color:#A34C00">' + (j.total_rulings || 0) + '</td>';
      html += '<td style="font-size:11px;color:#5E5854">' + (j.last_updated ? new Date(j.last_updated).toLocaleDateString('en-US') : '—') + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
  }

  el.innerHTML = html;
}

async function searchJudge() {
  var inputEl = document.getElementById('judge-search-input');
  var name = inputEl ? inputEl.value.trim() : '';
  if (!name) return;

  var resultsEl = document.getElementById('judge-search-results');
  if (!resultsEl) return;

  resultsEl.innerHTML = '<p style="color:#5E5854;font-size:13px;padding:12px">Looking up ' + esc(name) + '...</p>';

  var data = await api('/api/research/judges/' + encodeURIComponent(name));
  if (!data || !data.found) {
    resultsEl.innerHTML = '<div style="background:#FBEDEA;border:1px solid #FBEDEA;border-radius:8px;padding:16px"><span style="color:#9C2B1E;font-weight:bold">No profile found for "' + esc(name) + '"</span><br><span style="font-size:13px;color:#5E5854;margin-top:8px;display:block">The judge may not yet be indexed. Continue running the scanner: <code>node judge-scanner.js --scan-all</code></span></div>';
    return;
  }

  var profile = data.profile || '';
  resultsEl.innerHTML = '<div style="background:#fff;border:1px solid #E8E3DC;border-radius:8px;padding:16px;font-family:monospace;white-space:pre-wrap;font-size:12px;line-height:1.5">' + esc(profile) + '</div>';
}

function lookupJudgeFromTable(name) {
  var inputEl = document.getElementById('judge-search-input');
  if (inputEl) inputEl.value = name;
  searchJudge();
}

// ── CourtListener API token storage ─────────────────────────
function saveClToken() {
  var input = document.getElementById('cl-token-input');
  if (!input) return;
  var token = input.value.trim();
  if (token) {
    localStorage.setItem('cl_token', token);
    alert('CourtListener API token saved to your browser. You will no longer hit rate limits.');
  } else {
    localStorage.removeItem('cl_token');
    alert('Token cleared.');
  }
}

function loadClToken() {
  var input = document.getElementById('cl-token-input');
  if (input) {
    var saved = localStorage.getItem('cl_token');
    if (saved) input.value = saved;
  }
}

