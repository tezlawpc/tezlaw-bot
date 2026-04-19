

  function getCookie(name) {
    return document.cookie.split('; ').find(r => r.startsWith(name + '='))?.split('=')[1] || '';
  }

  async function api(path, options = {}) {
    const res = await fetch('/admin' + path, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'x-admin-token': getCookie('admin_token'), ...options.headers }
    });
    if (res.status === 401) { window.location.href = '/admin/login'; return null; }
    return res.json();
  }

  function platBadge(p) {
    const map = { telegram:'badge-tg', whatsapp:'badge-wa', website:'badge-web',
                  wechat:'badge-wc', messenger:'badge-ms' };
    return `<span class="badge ${map[p]||''}">${p}</span>`;
  }

  function showPage(name) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById('page-' + name).classList.add('active');
    document.getElementById('nav-' + name).classList.add('active');

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
  }

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
    ).join('') || '<p style="color:#999;font-size:13px">No data yet</p>';

    document.getElementById('caseTypeBar').innerHTML = data.weekIntakeTypes.length
      ? `<table><thead><tr><th>Case Type</th><th>Count</th></tr></thead><tbody>${
          data.weekIntakeTypes.map(r => `<tr><td>${r.case_type||'Unknown'}</td><td>${r.n}</td></tr>`).join('')
        }</tbody></table>`
      : '<p style="color:#999;font-size:13px">No intakes this week yet</p>';
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
      msg.style.color = '#cc0000';
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
      : '<p style="color:#999;font-size:13px;padding:12px">No intakes yet.</p>';
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
            <td><span style="font-size:11px;font-weight:bold;color:${r.role==='assistant'?'#B79C62':'#0C1C36'}">${r.role==='assistant'?'ZARA':'CLIENT'}</span></td>
            <td style="max-width:400px;font-size:13px">${r.content.substring(0,200)}${r.content.length>200?'…':''}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : '<p style="color:#999;font-size:13px;padding:12px">No messages yet.</p>';
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
            <td><span style="font-size:11px;font-weight:bold;padding:3px 8px;border-radius:12px;background:#fff0f0;color:${typeColors[r.violation_type]||'#cc0000'}">${r.violation_type}</span></td>
            <td style="max-width:260px;font-size:12px;color:#333" title="${(r.zara_response||'').replace(/"/g,'&quot;')}">${(r.zara_response||'').substring(0,120)}${(r.zara_response||'').length>120?'…':''}</td>
            <td style="max-width:220px;font-size:12px;color:#006600" title="${(r.correction_sent||'').replace(/"/g,'&quot;')}">${(r.correction_sent||'').substring(0,100)}${(r.correction_sent||'').length>100?'…':''}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : '<p style="color:#006600;font-size:13px;padding:12px">✅ No compliance violations logged. Zara is clean!</p>';
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
            <div style="font-size:11px;color:#999;margin-bottom:8px">Run at: ${new Date(entry.ranAt).toLocaleString('en-US')}</div>
            <div class="analytics-summary">${entry.summary}</div>
          </div>`).join('')
      : '<p style="color:#999;font-size:13px">No analytics runs yet.</p>';
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
      setTimeout(() => loadAnalytics(), 120000); // reload after 2 min
    }
  }

  async function logout() {
    await api('/api/logout', { method: 'POST' });
    document.cookie = 'admin_token=; path=/; max-age=0';
    window.location.href = '/admin/login';
  }

  // Load dashboard on start
  loadDashboard();

// Wave 1 functions appended below

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
  if (!data) { board.innerHTML = '<p style="color:#cc0000;padding:12px">Failed to load — check DB</p>'; return; }

  var byStage = {};
  STAGES.forEach(function(s){ byStage[s.key] = []; });
  data.forEach(function(lead){ if(byStage[lead.stage]) byStage[lead.stage].push(lead); });

  var html = '<div class="kanban-board">';
  STAGES.forEach(function(s) {
    var leads = byStage[s.key] || [];
    html += '<div class="kanban-col">';
    html += '<div class="kanban-col-header">' + s.label + ' <span class="kanban-count">' + leads.length + '</span></div>';
    if (!leads.length) html += '<p style="font-size:12px;color:#aaa;text-align:center;padding:8px">Empty</p>';
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
  if (!data.length) { el.innerHTML = '<p style="color:#999;font-size:13px;padding:12px">No conflicts yet.</p>'; return; }
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
          + '<td style="text-align:center;font-weight:bold;color:#B79C62">'+r.n+'</td>'
          + '<td style="font-size:11px">'+new Date(r.last_seen).toLocaleDateString('en-US')+'</td></tr>';
    });
    we.innerHTML = '<table><thead><tr><th>Question</th><th>Count</th><th>Last Seen</th></tr></thead><tbody>'+wr+'</tbody></table>';
  } else {
    we.innerHTML = '<p style="color:#006600;font-size:13px;padding:12px">No gaps this week!</p>';
  }
  if (all && all.length) {
    var ar = '';
    all.forEach(function(r){
      ar += '<tr><td style="font-size:11px">'+new Date(r.created_at).toLocaleDateString('en-US')+'</td>'
          + '<td>'+platBadge(r.platform)+'</td>'
          + '<td style="font-size:12px">'+r.question.substring(0,100)+(r.question.length>100?'...':'')+'</td>'
          + '<td style="font-size:11px;color:#999">'+(r.zara_response||'').substring(0,80)+'...</td>'
          + '<td><button class="action-btn" style="font-size:11px;padding:4px 10px" data-qid="'+r.id+'" onclick="resolveQuestion(this.getAttribute(\'data-qid\'),this)">Resolved</button></td></tr>';
    });
    ae.innerHTML = '<table><thead><tr><th>Date</th><th>Platform</th><th>Question</th><th>Zara Said</th><th>Action</th></tr></thead><tbody>'+ar+'</tbody></table>';
  } else {
    ae.innerHTML = '<p style="color:#006600;font-size:13px;padding:12px">No open questions!</p>';
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
  if (!data.length) { el.innerHTML = '<p style="color:#999;font-size:13px;padding:12px">No events yet.</p>'; return; }
  var rows = '';
  data.forEach(function(r) {
    var t = new Date(r.created_at).toLocaleString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    var ch = r.old_value && r.new_value ? r.old_value.substring(0,25)+' → '+r.new_value.substring(0,25) : (r.new_value||'').substring(0,40);
    rows += '<tr>'
      +'<td style="font-size:11px;white-space:nowrap">'+t+'</td>'
      +'<td style="font-weight:bold;font-size:12px">'+r.actor+'</td>'
      +'<td style="font-size:12px">'+r.action+'</td>'
      +'<td style="font-size:11px;color:#666">'+(r.target||'—')+'</td>'
      +'<td style="font-size:11px">'+ch+'</td>'
      +'<td style="font-size:10px;color:#aaa">'+(r.ip_address||'—')+'</td>'
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
  else { msg.style.color = '#cc0000'; msg.textContent = '❌ Failed to start'; }
}
