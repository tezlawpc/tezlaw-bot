// ============================================================
//  TEZ LAW FIRM — CONSULTANT PORTAL
//  ─────────────────────────────────────────────────────────
//  A limited, self-contained portal for external referral partners
//  (consultants) who bring leads/matters to the firm.
//
//  What they can do:
//   • Send the firm a task (and the documents that go with it)
//   • Track every task they have sent, stage by stage
//   • See the timeline: decisions, firm notes, assignments
//   • Add follow-up notes and documents
//
//  What they CANNOT do:
//   • See any firm-wide data (other clients, hearings, PI, accounting)
//   • See internal firm notes marked "hidden from submitter"
//   • See or interact with anyone else's submissions
//
//  Consultants have their own UI chrome (no firm sidebar); everything
//  they see lives at /consultant/*.
//
//  A task is a REQUEST until an attorney or manager approves it
//  (work-orders.js). The pages here say which stage each one is at.
// ============================================================

const theme = require("./tez-theme");
const { esc } = theme;

// ── Words ───────────────────────────────────────────────────
// What a consultant sends the firm is called a TASK on every screen and in
// every message. It was "work order"; JJ: "word work order seems weird. tez
// is a law firm after all, maybe revise to task or case?" Task, because that
// is what the firm already calls it once approved (the firm's Task list), and
// because much of what is sent concerns a client the firm already has — a
// document to collect is not a "case". The code keeps its old names
// (work-orders.js, wo_approved): those are never shown to anyone.
//
// Two languages. Many of the firm's consultants work in Chinese, and JJ's
// rule for anything the firm publishes in Chinese is Simplified characters.
// Every phrase a person reads is in STR, once per language, so a page cannot
// come out half translated: a key missing from zh falls back to English and
// scripts/check-consultant-clients.js fails on it.
const STR = {
  en: {
    portal: "Consultant Portal", firm: "TEZ Law Firm", signedIn: "Signed in as", signOut: "Sign out", sections: "Sections",
    switchTo: "中文", switchLabel: "切换到中文",
    nav_tasks: "Tasks", nav_new: "New task", nav_clients: "My clients", nav_add: "Add client", nav_alerts: "Alerts",
    foot: "Questions about a client or a task: 626-678-8677 · jj@tezlawfirm.com",

    st_pending_approval: "Awaiting approval", st_open: "Approved", st_pending: "In the queue", st_in_progress: "In progress",
    st_completed: "Completed", st_rejected: "Not accepted", st_cancelled: "Cancelled",
    stl_pending_approval: "Waiting for an attorney or manager at the firm to approve it. Nothing has been started.",
    stl_open: "Approved and in the firm's queue.", stl_pending: "In the firm's queue.", stl_in_progress: "The firm is working on it.",
    stl_completed: "The firm has finished this.", stl_rejected: "The firm did not accept this task.", stl_cancelled: "This task was cancelled.",

    pr_urgent: "Urgent", pr_high: "High", pr_normal: "Normal", pr_low: "Low",
    m_immigration: "Immigration", m_pi: "Personal injury", m_business: "Business litigation", m_ll_tenant: "Landlord / tenant",
    m_estate: "Estate planning", m_tm: "Trademarks / patents", m_real_estate: "Real estate", m_admin: "General / other",

    dash_h1: "Tasks",
    dash_sub: "What you have sent to the firm and where each one stands. An attorney or manager approves a task before the firm starts on it.",
    tile_waiting: "Awaiting approval", tile_firm: "With the firm", tile_done: "Completed", tile_no: "Not accepted",
    dash_current: "Current tasks", dash_new: "New task",
    dash_empty: "You have not sent the firm any tasks yet.", dash_first: "Send your first one",
    with: "With {name}", due: "Due {date}", sent: "Sent {date}",

    new_h1: "New task",
    new_sub: "Tell the firm what is needed. An attorney or manager reviews it first; once it is approved the firm starts work, and you are told at each step.",
    f_title: "What do you need the firm to do? *", f_title_ph: "New client — auto accident on Aug 12", f_title_hint: "One line. The details go below.",
    f_client: "Client name", f_client_ph: "Last, First", f_matter: "Matter type *", f_choose: "Choose one",
    f_phone: "Client phone, if known", f_email: "Client email, if known",
    f_urgency: "Urgency", u_normal: "Normal — standard timeline", u_high: "High — deadline within 30 days",
    u_urgent: "Urgent — imminent deadline or detained client", u_low: "Low — no rush",
    f_due: "Deadline or court date, if known", f_details: "Details *",
    f_details_ph: "What happened, what the client needs, key dates, and which documents you already have.",
    f_files: "Documents (optional)", f_files_hint: "PDF, photos, Word or Excel. Up to 15 MB each. The firm sees them with the task.",
    f_send: "Send for approval", f_cancel: "Cancel",
    js_sending: "Sending", js_uploading: "Uploading documents", js_failed: "That did not go through. Please try again.",
    js_server: "The server answered with HTTP ", js_network: "Could not reach the server: ",
    js_some_files: "The task was sent, but a document could not be attached: ",

    back_all: "All tasks",
    wait_sent: "Sent. ", wait_title: "Waiting for approval.",
    wait_body: "An attorney or manager at the firm reviews every task before any work starts. You will be told as soon as they decide.",
    rej_title: "The firm did not accept this task.", rej_again: "If something has changed, send a new task.",
    appr_by: "Approved by {name}.", appr: "Approved.", appr_queue: "It is in the firm's queue.", appr_queue_with: "It is in the firm's queue with {name}.",
    progress: "Progress", steps_of: "{done} of {total} steps · {pct}%", in_progress: "In progress", not_needed: "(not needed)",
    done_on: "Done {date}", target: "Target {date}",
    a_created: "Task sent to the firm", a_approved: "Approved", a_rejected: "Not accepted",
    a_status: "Status changed from {from} to {to}", a_assigned: "Assigned to {name}", a_unassigned: "Unassigned",
    a_your_note: "Your note", a_firm_note: "Note from the firm", a_completed: "Marked complete", a_reopened: "Reopened",
    a_updated: "Updated", a_updated_fromto: "Updated: {from} → {to}", a_file: "Document added: {name}", a_none: "No activity yet.",
    fact_client: "Client", fact_matter: "Matter type", fact_urgency: "Urgency", fact_deadline: "Deadline", fact_with: "With", fact_sent: "Sent",
    what_you_sent: "What you sent", activity: "Activity",
    docs: "Documents", docs_none: "No documents attached.", docs_add: "Add a document", docs_btn: "Attach", docs_download: "Download",
    docs_closed: "This task is closed, so nothing more can be attached.",
    docs_hint: "PDF, photos, Word or Excel. Up to 15 MB each.", docs_choose: "Choose a file first.",
    note_h: "Add a note for the firm", note_label: "Your note", note_ph: "Anything new the firm should know about this task.",
    note_send: "Send note", note_first: "Write a note first.",

    cl_list_h: "My clients",
    cl_list_sub: "Clients filed under you at the firm, clients the firm assigned to you, and clients you entered. Search by name, phone, email or A-number.",
    cl_new_h: "Add a client", cl_new_sub: "Enter a new client's details. The firm is notified and the client appears in your list right away.",
    cl_view_h: "Client",

    al_h1: "Alerts", al_sub: "What has happened on your clients and tasks, and how you hear about it.",
    al_saved: "Saved.", al_linked: "Telegram is linked. Alerts will go to that chat.",
    al_recent: "Recent", al_new: "New", al_open: "Open", al_task_no: "Task #{id}", al_a_client: "A client of yours",
    al_empty: "Nothing yet. When something happens on one of your clients or tasks, it is listed here.",
    al_told_h: "What you will be told",
    al_told_p: "A new court notice, a hearing scheduled or rescheduled, a deadline coming up, a change in case status, or an update the firm sends you — for your clients only. And every decision on a task you sent: approved, not accepted, updated, completed.",
    al_rule_b: "The alert itself says only what happened and for which client.",
    al_rule: "Dates, documents, A-numbers and the substance of a notice are never sent by email, text or app notification — you sign in here to read them. That is deliberate: an email gets forwarded and a phone gets lost.",
    al_where_h: "Where to reach you", al_where_hint: "Ask the firm to change your email or phone number.",
    ch_app: "Tara app on your phone", ch_app_ok: "This account is signed in on a phone",
    ch_app_no: "Not signed in on a phone yet — open the Tara app and sign in with this account.", ch_app_note: "A notification on your lock screen.",
    ch_email: "Email", ch_email_no: "No email address on file — ask the firm to add one.",
    ch_sms: "Text message", ch_sms_no: "No phone number on file — ask the firm to add one.", ch_sms_note: "Standard message rates apply.",
    ch_tg: "Telegram", ch_tg_ok: "Linked", ch_tg_no: "Not linked yet — use the box below.",
    ch_nowhere: "Turned on, but there is nowhere to send — you will not be alerted on this channel.",
    al_lang: "Language for alerts and this portal", al_save: "Save",
    tg_h: "Link Telegram", tg_p: "Telegram will not let us message you until you message the bot first.",
    tg_with: "Open Telegram, start a chat with @TEZJJBot, and send it this code:",
    tg_without: "Generate a code, then send it to @TEZJJBot on Telegram.",
    tg_once: "The code works once. Come back to this page afterwards to confirm.", tg_gen: "Generate a code", tg_regen: "Generate a new code",
    down_h: "Not available right now",
    down_p: "The firm has not set up {what} on the server yet, so those alerts will queue rather than send. Nothing is lost — they go out once it is switched on, and everything is listed above in the meantime.",
    down_email: "email", down_sms: "text message", down_tg: "Telegram", down_or: " or ",
  },
  zh: {
    portal: "顾问门户", firm: "TEZ 律师事务所", signedIn: "当前登录：", signOut: "退出登录", sections: "栏目",
    switchTo: "English", switchLabel: "Switch to English",
    nav_tasks: "任务", nav_new: "新建任务", nav_clients: "我的客户", nav_add: "添加客户", nav_alerts: "提醒",
    foot: "关于客户或任务的问题，请联系：626-678-8677 · jj@tezlawfirm.com",

    st_pending_approval: "待审批", st_open: "已批准", st_pending: "已排队", st_in_progress: "处理中",
    st_completed: "已完成", st_rejected: "未受理", st_cancelled: "已取消",
    stl_pending_approval: "正在等待本所律师或经理批准，尚未开始处理。",
    stl_open: "已批准，已进入本所的工作队列。", stl_pending: "已进入本所的工作队列。", stl_in_progress: "本所正在处理。",
    stl_completed: "本所已完成此任务。", stl_rejected: "本所未受理此任务。", stl_cancelled: "此任务已取消。",

    pr_urgent: "紧急", pr_high: "较急", pr_normal: "普通", pr_low: "不急",
    m_immigration: "移民", m_pi: "人身伤害", m_business: "商业诉讼", m_ll_tenant: "房东与租客",
    m_estate: "遗产规划", m_tm: "商标与专利", m_real_estate: "房地产", m_admin: "一般事务 / 其他",

    dash_h1: "任务",
    dash_sub: "您提交给本所的任务及各自的进展。任务须经律师或经理批准后，本所才会开始处理。",
    tile_waiting: "待审批", tile_firm: "本所处理中", tile_done: "已完成", tile_no: "未受理",
    dash_current: "当前任务", dash_new: "新建任务",
    dash_empty: "您还没有向本所提交过任务。", dash_first: "提交第一个任务",
    with: "负责人：{name}", due: "期限：{date}", sent: "提交于 {date}",

    new_h1: "新建任务",
    new_sub: "请告诉本所需要办理的事项。律师或经理会先行审核；批准后本所开始处理，每一步都会通知您。",
    f_title: "需要本所办理什么？*", f_title_ph: "新客户：8 月 12 日车祸", f_title_hint: "用一句话概括，详情请写在下方。",
    f_client: "客户姓名", f_client_ph: "姓，名", f_matter: "案件类型 *", f_choose: "请选择",
    f_phone: "客户电话（如有）", f_email: "客户电子邮箱（如有）",
    f_urgency: "紧急程度", u_normal: "普通：按正常时间处理", u_high: "较急：30 天内有期限",
    u_urgent: "紧急：期限迫近或客户被羁押", u_low: "不急",
    f_due: "期限或开庭日期（如有）", f_details: "详细情况 *",
    f_details_ph: "发生了什么、客户需要什么、重要日期，以及您手头已有哪些文件。",
    f_files: "文件（可选）", f_files_hint: "PDF、照片、Word 或 Excel，每个不超过 15 MB。本所会连同任务一并看到。",
    f_send: "提交审批", f_cancel: "取消",
    js_sending: "正在提交", js_uploading: "正在上传文件", js_failed: "提交未成功，请重试。",
    js_server: "服务器返回 HTTP ", js_network: "无法连接服务器：",
    js_some_files: "任务已提交，但有文件未能附上：",

    back_all: "全部任务",
    wait_sent: "已提交。", wait_title: "等待审批。",
    wait_body: "本所律师或经理会在开始任何工作之前审核每一项任务。一有决定就会通知您。",
    rej_title: "本所未受理此任务。", rej_again: "如情况有变，请重新提交任务。",
    appr_by: "已由 {name} 批准。", appr: "已批准。", appr_queue: "已进入本所的工作队列。", appr_queue_with: "已进入本所的工作队列，负责人：{name}。",
    progress: "进度", steps_of: "共 {total} 步，已完成 {done} 步 · {pct}%", in_progress: "处理中", not_needed: "（无需办理）",
    done_on: "完成于 {date}", target: "预计 {date}",
    a_created: "任务已提交给本所", a_approved: "已批准", a_rejected: "未受理",
    a_status: "状态由“{from}”变为“{to}”", a_assigned: "已分配给 {name}", a_unassigned: "已取消分配",
    a_your_note: "您的留言", a_firm_note: "本所留言", a_completed: "已标记为完成", a_reopened: "已重新开启",
    a_updated: "已更新", a_updated_fromto: "已更新：{from} → {to}", a_file: "已添加文件：{name}", a_none: "暂无记录。",
    fact_client: "客户", fact_matter: "案件类型", fact_urgency: "紧急程度", fact_deadline: "期限", fact_with: "负责人", fact_sent: "提交日期",
    what_you_sent: "您提交的内容", activity: "动态",
    docs: "文件", docs_none: "尚未附上文件。", docs_add: "添加文件", docs_btn: "上传", docs_download: "下载",
    docs_closed: "此任务已结束，不能再添加文件。",
    docs_hint: "PDF、照片、Word 或 Excel，每个不超过 15 MB。", docs_choose: "请先选择文件。",
    note_h: "给本所留言", note_label: "留言内容", note_ph: "关于此任务，本所还需要了解的新情况。",
    note_send: "发送留言", note_first: "请先填写留言。",

    cl_list_h: "我的客户",
    cl_list_sub: "归在您名下的客户、本所分配给您的客户，以及您自行录入的客户。可按姓名、电话、邮箱或 A 号码搜索。",
    cl_new_h: "添加客户", cl_new_sub: "录入新客户的资料。本所会收到通知，该客户会立即出现在您的列表中。",
    cl_view_h: "客户",

    al_h1: "提醒", al_sub: "您的客户和任务的最新动态，以及通知您的方式。",
    al_saved: "已保存。", al_linked: "Telegram 已绑定，提醒将发送到该聊天。",
    al_recent: "最近动态", al_new: "新", al_open: "查看", al_task_no: "任务 #{id}", al_a_client: "您的一位客户",
    al_empty: "暂无动态。您的客户或任务有新情况时，会显示在这里。",
    al_told_h: "我们会通知您的内容",
    al_told_p: "新的法院通知、开庭已排期或改期、期限临近、案件状态变化，或本所发给您的更新（仅限您的客户）；以及您提交的任务的每一项决定：已批准、未受理、有更新、已完成。",
    al_rule_b: "提醒本身只说明发生了什么事、涉及哪位客户。",
    al_rule: "日期、文件、A 号码以及通知的具体内容，绝不会通过电子邮件、短信或手机通知发送，您需要登录这里查看。这是有意为之：邮件可能被转发，手机可能遗失。",
    al_where_h: "通知方式", al_where_hint: "如需更改邮箱或电话，请联系本所。",
    ch_app: "手机上的 Tara 应用", ch_app_ok: "此账号已在手机上登录",
    ch_app_no: "尚未在手机上登录。请打开 Tara 应用，用此账号登录。", ch_app_note: "在锁屏上显示通知。",
    ch_email: "电子邮件", ch_email_no: "尚未登记电子邮箱，请联系本所添加。",
    ch_sms: "短信", ch_sms_no: "尚未登记电话号码，请联系本所添加。", ch_sms_note: "运营商可能收取短信费用。",
    ch_tg: "Telegram", ch_tg_ok: "已绑定", ch_tg_no: "尚未绑定，请使用下方的方法绑定。",
    ch_nowhere: "已开启，但没有可发送的地址，此方式不会收到提醒。",
    al_lang: "提醒和本门户使用的语言", al_save: "保存",
    tg_h: "绑定 Telegram", tg_p: "您需要先给机器人发一条消息，Telegram 才允许我们给您发消息。",
    tg_with: "打开 Telegram，与 @TEZJJBot 开始对话，并把下面的代码发给它：",
    tg_without: "先生成一个代码，然后在 Telegram 上发给 @TEZJJBot。",
    tg_once: "代码只能使用一次。发送后请回到本页面确认。", tg_gen: "生成代码", tg_regen: "重新生成代码",
    down_h: "暂时无法使用",
    down_p: "本所尚未在服务器上开通{what}，这些提醒会先排队，开通后发出，不会丢失；在此期间，所有动态都会显示在上方。",
    down_email: "电子邮件", down_sms: "短信", down_tg: "Telegram", down_or: "或",
  },
};

const langOf = (user) => (user && (user.lang === "zh" || user.lang === "zh-CN") ? "zh" : "en");
// t("key", { name: … }) → the phrase in this language, with {name} filled in.
function words(lang) {
  const d = STR[lang] || STR.en;
  return (key, vars) => {
    let s = d[key] != null ? d[key] : (STR.en[key] != null ? STR.en[key] : key);
    if (vars) for (const k of Object.keys(vars)) s = s.split("{" + k + "}").join(vars[k] == null ? "" : String(vars[k]));
    return s;
  };
}

// ── Look ────────────────────────────────────────────────────
// JJ, signed in as a consultant: "keep the design theme similar to tez."
// The colours, type and shield come from tez-theme.js (the brand guide);
// nothing on these pages sets its own. No emoji: the guide rules them out
// as icons, and a status is a word with a dot beside it.
const STATUS_DOT = {
  pending_approval: "var(--orange)", open: "var(--good)", pending: "var(--good)", in_progress: "var(--charcoal)",
  completed: "var(--stone)", rejected: "var(--bad)", cancelled: "var(--stone)",
};
const KNOWN_STATUS = Object.keys(STATUS_DOT);
const statusWord = (t, s) => KNOWN_STATUS.includes(s) ? t("st_" + s) : (String(s || "").replace(/_/g, " ") || "—");
const statusLong = (t, s) => KNOWN_STATUS.includes(s) ? t("stl_" + s) : "";
const badge = (t, s) => `<span class="status-badge" style="--dot:${STATUS_DOT[s] || "var(--stone)"};">${esc(statusWord(t, s))}</span>`;

const MATTERS = ["immigration", "pi", "business", "ll_tenant", "estate", "tm", "real_estate", "admin"];
const matterLabel = (t, m) => MATTERS.includes(m) ? t("m_" + m) : String(m || "").replace(/_/g, " ");
const priorityLabel = (t, p) => ["urgent", "high", "normal", "low"].includes(p) ? t("pr_" + p) : (p || "");

// Dates. A DATE column arrives as local midnight, so it is read with local
// getters; a timestamp is shown in Pacific time, where the firm is — the
// server's own clock is UTC, which put evening submissions on the next day.
const PT = "America/Los_Angeles";
const locale = (lang) => (lang === "zh" ? "zh-CN" : "en-US");
function fmtDay(v, lang = "en") {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(String(v).length <= 10 ? `${v}T12:00:00` : v);
  return isNaN(d) ? "" : d.toLocaleDateString(locale(lang), { month: "short", day: "numeric", year: "numeric" });
}
function fmtWhen(v, withTime = false, lang = "en") {
  const d = v ? new Date(v) : null;
  if (!d || isNaN(d)) return "";
  return d.toLocaleString(locale(lang), withTime
    ? { timeZone: PT, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }
    : { timeZone: PT, month: "short", day: "numeric", year: "numeric" });
}
const nameOf = (user) => (user && (user.n || user.u || user.name || user.username)) || "Consultant";
const fmtBytes = (n) => { const b = Number(n) || 0; return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; };

// Render the consultant portal chrome (self-contained — no firm sidebar).
function renderChrome({ title = "Consultant Portal", body, activeTab = "dashboard", user = {} }) {
  const lang = langOf(user), t = words(lang);
  // One button: the OTHER language, named in that language.
  const switcher = `<form method="POST" action="/consultant/lang" style="margin:0;">
          <input type="hidden" name="lang" value="${lang === "zh" ? "en" : "zh"}">
          <button type="submit" class="tez-signout" lang="${lang === "zh" ? "en" : "zh-Hans"}" aria-label="${esc(t("switchLabel"))}">${esc(t("switchTo"))}</button>
        </form>`;
  // The browser tab: the section's own name in the page's language. A task's
  // page keeps the task's title, which is whatever the consultant wrote.
  const tabTitle = { dashboard: t("nav_tasks"), new: t("nav_new"), clients: t("nav_clients"), "add-client": t("nav_add"), alerts: t("nav_alerts") };
  const known = ["Tasks", "New task", "My Clients", "Add Client", "Client", "Alerts", "Consultant Portal"];
  if (known.includes(title) || !title) title = tabTitle[activeTab] || t("portal");
  return theme.page({
    title, area: t("portal"), lang,
    words: { firm: t("firm"), signedIn: t("signedIn"), signOut: t("signOut"), sections: t("sections") },
    switcher,
    nav: [
      { key: "dashboard", href: "/consultant", label: t("nav_tasks") },
      { key: "new", href: "/consultant/new", label: t("nav_new") },
      { key: "clients", href: "/consultant/clients", label: t("nav_clients") },
      { key: "add-client", href: "/consultant/clients/new", label: t("nav_add") },
      { key: "alerts", href: "/consultant/alerts", label: t("nav_alerts"), count: Number(user.alerts) > 0 ? Number(user.alerts) : null },
    ],
    active: activeTab, who: nameOf(user), body, foot: esc(t("foot")),
  });
}

// ── Dashboard: list of THIS consultant's submissions ───────────
function renderDashboard({ user, tasks, stats }) {
  const lang = langOf(user), t = words(lang);
  const n = (k) => Number(stats[k]) || 0;
  const rowsHtml = tasks.length ? tasks.map(x => {
    const overdue = x.due_date && !["completed", "rejected", "cancelled"].includes(x.status) && new Date(x.due_date) < new Date(Date.now() - 864e5);
    return `
      <a href="/consultant/task/${x.id}">
        <div>
          <div class="t">${esc(x.title)}</div>
          <div class="m">${[x.client_name ? esc(x.client_name) : null, x.matter_type ? esc(matterLabel(t, x.matter_type)) : null].filter(Boolean).join(" · ")}</div>
        </div>
        <div>
          ${badge(t, x.status)}
          ${x.assigned_to && x.status !== "pending_approval" && x.status !== "rejected" ? `<div class="m">${esc(t("with", { name: x.assigned_to }))}</div>` : ""}
        </div>
        <div class="m">
          ${x.due_date ? `<span${overdue ? ' style="color:var(--bad);font-weight:600;"' : ""}>${esc(t("due", { date: fmtDay(x.due_date, lang) }))}</span><br>` : ""}
          ${esc(t("sent", { date: fmtWhen(x.created_at, false, lang) }))}
        </div>
      </a>`;
  }).join("") : `<div class="empty">${esc(t("dash_empty"))}<br><a href="/consultant/new">${esc(t("dash_first"))}</a></div>`;

  return `
    <div class="page-header">
      <h1>${esc(t("dash_h1"))}</h1>
      <div class="sub">${esc(t("dash_sub"))}</div>
    </div>

    <div class="tiles">
      <div class="tile${n("pending_approval") ? " hot" : ""}"><div class="k">${esc(t("tile_waiting"))}</div><div class="v">${n("pending_approval")}</div></div>
      <div class="tile"><div class="k">${esc(t("tile_firm"))}</div><div class="v">${n("open") + n("pending") + n("in_progress")}</div></div>
      <div class="tile"><div class="k">${esc(t("tile_done"))}</div><div class="v">${n("completed")}</div></div>
      <div class="tile"><div class="k">${esc(t("tile_no"))}</div><div class="v">${n("rejected")}</div></div>
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
      <h3 style="margin:0;">${esc(t("dash_current"))}</h3>
      <a href="/consultant/new" class="btn-primary">${esc(t("dash_new"))}</a>
    </div>

    <div class="card flush"><div class="rows">${rowsHtml}</div></div>`;
}

// My Clients / Add Client / one client: drawn in the browser by
// public/consultant-clients.js from /api/consultant/* (the same calls the
// phone app makes), so phone and computer show the same thing. That script
// reads the page's language from <html lang>.
function renderClientsPage({ mode = "list", clientKey = null, user = {} } = {}) {
  const t = words(langOf(user));
  const heads = {
    list: [t("cl_list_h"), t("cl_list_sub")],
    new: [t("cl_new_h"), t("cl_new_sub")],
    view: [t("cl_view_h"), ""],
  };
  const [h, sub] = heads[mode] || heads.list;
  return `
    <div class="page-header"><h1>${esc(h)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
    <div data-consultant-clients="${esc(mode)}"${clientKey ? ` data-key="${esc(clientKey)}"` : ""}></div>
    ${require("./client-script").clientScriptTag("consultant-clients.js")}`;
}

// Phrases a page script needs, handed over as data rather than written into
// the script: these scripts sit inside a server-side template literal, which
// swallows apostrophes and backslashes, and a translated phrase is exactly
// where an apostrophe turns up. JSON in a data attribute cannot break that way.
const scriptWords = (t, keys) => esc(JSON.stringify(Object.fromEntries(keys.map(k => [k, t(k)]))));

// ── New task form ───────────────────────────────────────────
function renderNewForm({ user = {} } = {}) {
  const t = words(langOf(user));
  return `
    <div class="page-header">
      <h1>${esc(t("new_h1"))}</h1>
      <div class="sub">${esc(t("new_sub"))}</div>
    </div>

    <div class="card">
      <form id="wo-form" data-words="${scriptWords(t, ["f_send", "js_sending", "js_uploading", "js_failed", "js_server", "js_network", "js_some_files"])}">
        <div class="field">
          <label for="wo-title">${esc(t("f_title"))}</label>
          <input id="wo-title" type="text" name="title" required maxlength="300" placeholder="${esc(t("f_title_ph"))}">
          <div class="hint">${esc(t("f_title_hint"))}</div>
        </div>

        <div class="grid2">
          <div>
            <label for="wo-client-name">${esc(t("f_client"))}</label>
            <input type="text" name="client_name" maxlength="200" placeholder="${esc(t("f_client_ph"))}" id="wo-client-name">
          </div>
          <div>
            <label for="wo-matter">${esc(t("f_matter"))}</label>
            <select id="wo-matter" name="matter_type" required>
              <option value="">${esc(t("f_choose"))}</option>
              ${MATTERS.map(k => `<option value="${k}">${esc(t("m_" + k))}</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="grid2">
          <div>
            <label for="wo-phone">${esc(t("f_phone"))}</label>
            <input id="wo-phone" type="tel" name="_client_phone" maxlength="40" placeholder="(626) 555-0100">
          </div>
          <div>
            <label for="wo-email">${esc(t("f_email"))}</label>
            <input id="wo-email" type="email" name="_client_email" maxlength="200">
          </div>
        </div>

        <div class="grid2">
          <div>
            <label for="wo-priority">${esc(t("f_urgency"))}</label>
            <select id="wo-priority" name="priority">
              <option value="normal">${esc(t("u_normal"))}</option>
              <option value="high">${esc(t("u_high"))}</option>
              <option value="urgent">${esc(t("u_urgent"))}</option>
              <option value="low">${esc(t("u_low"))}</option>
            </select>
          </div>
          <div>
            <label for="wo-due">${esc(t("f_due"))}</label>
            <input id="wo-due" type="date" name="due_date">
          </div>
        </div>

        <div class="field">
          <label for="wo-desc">${esc(t("f_details"))}</label>
          <textarea id="wo-desc" name="description" rows="7" required maxlength="7500" placeholder="${esc(t("f_details_ph"))}"></textarea>
        </div>

        <div class="field">
          <label for="wo-files">${esc(t("f_files"))}</label>
          <input id="wo-files" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.gif,.doc,.docx,.xls,.xlsx,.txt,.rtf,.csv">
          <div class="hint">${esc(t("f_files_hint"))}</div>
        </div>

        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
          <button type="submit" class="btn-primary" id="submit-btn">${esc(t("f_send"))}</button>
          <a href="/consultant" class="btn-secondary">${esc(t("f_cancel"))}</a>
          <span id="submit-status" role="status" class="hint" style="margin:0;"></span>
        </div>
      </form>
    </div>

    <script>
      // No apostrophes or backslashes in this script: it sits inside a
      // server-side template literal, which swallows both. Every phrase it
      // shows comes from the form's data-words attribute.
      (function () {
        var form = document.getElementById("wo-form");
        var W = JSON.parse(form.getAttribute("data-words"));
        var btn = document.getElementById("submit-btn");
        var status = document.getElementById("submit-status");
        var files = document.getElementById("wo-files");
        try {
          var c = new URLSearchParams(location.search).get("client");
          var el = document.getElementById("wo-client-name");
          if (c && el && !el.value) el.value = c.slice(0, 200);
        } catch (e) { /* older browser: type it */ }
        function fail(msg) {
          status.textContent = msg; status.style.color = "var(--bad)";
          btn.disabled = false; btn.textContent = W.f_send;
        }
        function readJson(r) {
          return r.json().catch(function () { return { ok: false, error: W.js_server + r.status }; });
        }
        // One file at a time, so one that is too large does not sink the rest.
        function uploadAll(taskId, list, i, problems) {
          if (i >= list.length) return Promise.resolve(problems);
          var fd = new FormData(); fd.append("file", list[i]);
          return fetch("/api/consultant/tasks/" + taskId + "/attachments", { method: "POST", credentials: "same-origin", body: fd })
            .then(readJson)
            .then(function (d) { if (!d.ok) problems.push(list[i].name + " (" + (d.error || "?") + ")"); })
            .catch(function (e) { problems.push(list[i].name + " (" + e.message + ")"); })
            .then(function () { return uploadAll(taskId, list, i + 1, problems); });
        }
        form.addEventListener("submit", function (e) {
          e.preventDefault();
          btn.disabled = true; btn.textContent = W.js_sending;
          status.textContent = ""; status.style.color = "";
          var data = {};
          new FormData(form).forEach(function (v, k) { if (typeof v === "string" && v !== "") data[k] = v; });
          var bits = [];
          if (data._client_phone) bits.push("Phone: " + data._client_phone);
          if (data._client_email) bits.push("Email: " + data._client_email);
          if (bits.length) data.description = bits.join(" · ") + String.fromCharCode(10, 10) + (data.description || "");
          delete data._client_phone; delete data._client_email;
          fetch("/api/consultant/tasks", {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify(data)
          }).then(readJson).then(function (d) {
            if (!d.ok || !d.task) { fail(d.error || W.js_failed); return; }
            var list = files && files.files ? Array.prototype.slice.call(files.files) : [];
            if (!list.length) { location.href = "/consultant/task/" + d.task.id + "?sent=1"; return; }
            btn.textContent = W.js_uploading;
            return uploadAll(d.task.id, list, 0, []).then(function (problems) {
              location.href = "/consultant/task/" + d.task.id + "?sent=1" + (problems.length ? "&files=" + encodeURIComponent(problems.join("; ").slice(0, 400)) : "");
            });
          }).catch(function (err) { fail(W.js_network + err.message); });
        });
      })();
    </script>`;
}

// ── Task detail with activity timeline ─────────────────────
function renderTaskDetail({ task, activity, milestones = [], progress = null, user, justSent = false, attachments = [], fileProblems = "" }) {
  const lang = langOf(user), t = words(lang);
  const last = (action) => [...activity].reverse().find(a => a.action === action);
  const rejected = task.status === "rejected" ? last("rejected") : null;
  const approved = last("approved");

  // Where it stands, said once at the top in plain words.
  let standing = "";
  if (task.status === "pending_approval") {
    standing = `<div class="card note"><strong>${justSent ? esc(t("wait_sent")) : ""}${esc(t("wait_title"))}</strong>
      ${esc(t("wait_body"))}</div>`;
  } else if (rejected) {
    standing = `<div class="card warn"><strong>${esc(t("rej_title"))}</strong>
      ${rejected.note ? `<div class="quote">${esc(rejected.note)}</div>` : ""}
      <div class="hint">${rejected.actor_name ? esc(rejected.actor_name) + " · " : ""}${esc(fmtWhen(rejected.created_at, true, lang))}. ${esc(t("rej_again"))}</div></div>`;
  } else if (approved && task.status === "open") {
    standing = `<div class="card ok"><strong>${esc(approved.actor_name ? t("appr_by", { name: approved.actor_name }) : t("appr"))}</strong>
      ${esc(task.assigned_to ? t("appr_queue_with", { name: task.assigned_to }) : t("appr_queue"))}${approved.note ? `<div class="quote">${esc(approved.note)}</div>` : ""}</div>`;
  }
  const filesNote = fileProblems ? `<div class="card warn">${esc(t("js_some_files"))}${esc(fileProblems)}</div>` : "";

  // Milestone progress display — read-only for consultants. They see the
  // steps the firm is working through so they know exactly where things
  // stand without asking for updates.
  const pct = progress ? progress.percent : 0;
  const milestonesHtml = milestones.length ? `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:10px;">
        <h3 style="margin:0;">${esc(t("progress"))}</h3>
        <div class="hint" style="margin:0;">${esc(t("steps_of", { done: progress ? (progress.completed + progress.skipped) : 0, total: progress ? progress.total : 0, pct }))}</div>
      </div>
      <div class="bar"><i style="width:${Number(pct) || 0}%;"></i></div>
      <div class="timeline">
      ${milestones.map(m => {
        const done = m.status === "completed", skipped = m.status === "skipped", active = m.status === "in_progress";
        return `
          <div>
            <span class="dot${done || active ? " on" : ""}"${done ? ' style="background:var(--good);"' : ""}></span>
            <div>
              <div class="what"${done || skipped ? ' style="color:var(--stone);"' : ""}>${esc(m.title)}${active ? ` <span class="tag" style="--dot:var(--orange);margin-left:8px;">${esc(t("in_progress"))}</span>` : ""}${skipped ? " " + esc(t("not_needed")) : ""}</div>
              ${m.completed_at ? `<div class="when">${esc(t("done_on", { date: fmtWhen(m.completed_at, false, lang) }))}</div>` : (m.due_date && !done ? `<div class="when">${esc(t("target", { date: fmtDay(m.due_date, lang) }))}</div>` : "")}
            </div>
          </div>`;
      }).join("")}
      </div>
    </div>` : "";

  const strong = (s) => `<strong>${esc(s)}</strong>`;
  // esc() the whole phrase, then swap the two markers for bold values, so a
  // translated sentence can put them in whatever order its grammar wants.
  const withBold = (key, vars) => {
    let s = esc(t(key, Object.fromEntries(Object.keys(vars).map(k => [k, "\u0001" + k + "\u0002"]))));
    for (const k of Object.keys(vars)) s = s.split("\u0001" + k + "\u0002").join(strong(vars[k]));
    return s;
  };
  const timeline = activity.length ? activity.map(a => {
    let text = "";
    if (a.action === "created") text = esc(t("a_created"));
    else if (a.action === "approved") text = esc(t("a_approved"));
    else if (a.action === "rejected") text = esc(t("a_rejected"));
    else if (a.action === "status_changed") text = withBold("a_status", { from: statusWord(t, a.old_value) , to: statusWord(t, a.new_value) });
    else if (a.action === "assigned") text = a.new_value ? withBold("a_assigned", { name: a.new_value }) : esc(t("a_unassigned"));
    else if (a.action === "note_added") text = esc(String(a.actor_id) === String(user && (user.uid || user.id)) ? t("a_your_note") : t("a_firm_note"));
    else if (a.action === "attachment_added") text = esc(t("a_file", { name: a.note || "" }));
    else if (a.action === "completed") text = esc(t("a_completed"));
    else if (a.action === "reopened") text = esc(t("a_reopened"));
    else if (a.action === "edited") text = esc(a.old_value || a.new_value ? t("a_updated_fromto", { from: a.old_value || "", to: a.new_value || "" }) : t("a_updated"));
    else text = esc(String(a.action || "").replace(/_/g, " "));
    const key = ["approved", "rejected", "completed", "created"].includes(a.action);
    const showNote = a.note && a.action !== "created" && a.action !== "attachment_added";
    return `
      <div>
        <span class="dot${key ? " on" : ""}"></span>
        <div>
          <div class="what">${text}${a.actor_name ? ` <span style="color:var(--stone);">· ${esc(a.actor_name)}</span>` : ""}</div>
          ${showNote ? `<div class="quote">${esc(a.note)}</div>` : ""}
          <div class="when">${esc(fmtWhen(a.created_at, true, lang))}</div>
        </div>
      </div>`;
  }).join("") : `<div class="empty">${esc(t("a_none"))}</div>`;

  const fact = (label, value) => value ? `<div><span class="label">${esc(label)}</span><div style="font-weight:600;">${value}</div></div>` : "";
  const open = !["completed", "cancelled", "rejected"].includes(task.status);
  const tid = Number(task.id);

  const docs = `
    <div class="card">
      <h3>${esc(t("docs"))}</h3>
      ${attachments.length ? `<div class="timeline">${attachments.map(a => `
        <div style="grid-template-columns:minmax(0,1fr) auto;align-items:center;">
          <div><div class="what" style="overflow-wrap:anywhere;">${esc(a.filename)}</div>
            <div class="when">${esc(fmtBytes(a.bytes))} · ${esc(fmtWhen(a.created_at, true, lang))}</div></div>
          <a class="btn-secondary btn-small" href="/api/consultant/attachments/${Number(a.id)}">${esc(t("docs_download"))}</a>
        </div>`).join("")}</div>` : `<div class="hint" style="margin:0 0 6px;">${esc(t("docs_none"))}</div>`}
      ${open ? `
      <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--travertine);" id="doc-add"
           data-words="${scriptWords(t, ["docs_btn", "js_uploading", "js_failed", "js_server", "js_network", "docs_choose"])}">
        <label for="doc-file">${esc(t("docs_add"))}</label>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
          <input id="doc-file" type="file" style="flex:1;min-width:220px;" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.gif,.doc,.docx,.xls,.xlsx,.txt,.rtf,.csv">
          <button type="button" class="btn-primary" id="doc-btn">${esc(t("docs_btn"))}</button>
        </div>
        <div class="hint">${esc(t("docs_hint"))}</div>
        <div id="doc-status" role="status" class="hint"></div>
      </div>` : `<div class="hint">${esc(t("docs_closed"))}</div>`}
    </div>`;

  return `
    <div class="page-header">
      <a class="back" href="/consultant">&larr; ${esc(t("back_all"))}</a>
      <h1 style="margin-top:10px;overflow-wrap:anywhere;">${esc(task.title)}</h1>
      <div class="sub">${badge(t, task.status)}${statusLong(t, task.status) ? `<span style="margin-left:12px;">${esc(statusLong(t, task.status))}</span>` : ""}</div>
    </div>

    ${standing}
    ${filesNote}

    <div class="card">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:18px;">
        ${fact(t("fact_client"), task.client_name ? esc(task.client_name) : "")}
        ${fact(t("fact_matter"), task.matter_type ? esc(matterLabel(t, task.matter_type)) : "")}
        ${fact(t("fact_urgency"), esc(priorityLabel(t, task.priority)))}
        ${fact(t("fact_deadline"), esc(fmtDay(task.due_date, lang)))}
        ${task.status !== "pending_approval" && task.status !== "rejected" ? fact(t("fact_with"), task.assigned_to ? esc(task.assigned_to) : "") : ""}
        ${fact(t("fact_sent"), esc(fmtWhen(task.created_at, false, lang)))}
      </div>
      ${task.description ? `<div style="margin-top:18px;padding-top:18px;border-top:1px solid var(--travertine);"><span class="label">${esc(t("what_you_sent"))}</span><div style="white-space:pre-wrap;overflow-wrap:anywhere;">${esc(task.description)}</div></div>` : ""}
    </div>

    ${milestonesHtml}

    ${docs}

    <div class="card">
      <h3>${esc(t("activity"))}</h3>
      <div class="timeline">${timeline}</div>
    </div>

    ${open ? `
    <div class="card" id="note-box" data-words="${scriptWords(t, ["note_send", "js_sending", "js_failed", "js_server", "js_network", "note_first"])}">
      <h3>${esc(t("note_h"))}</h3>
      <label for="comment-text">${esc(t("note_label"))}</label>
      <textarea id="comment-text" rows="3" maxlength="2000" placeholder="${esc(t("note_ph"))}" style="margin-bottom:12px;"></textarea>
      <button type="button" class="btn-primary" id="comment-btn">${esc(t("note_send"))}</button>
      <span id="comment-status" role="status" class="hint" style="margin:0 0 0 12px;"></span>
    </div>

    <script>
      // No apostrophes or backslashes in here — see the note in the form above.
      (function () {
        function readJson(r, W) { return r.json().catch(function () { return { ok: false, error: W.js_server + r.status }; }); }
        var box = document.getElementById("note-box");
        var W = JSON.parse(box.getAttribute("data-words"));
        var btn = document.getElementById("comment-btn");
        var status = document.getElementById("comment-status");
        function bad(el, msg) { el.textContent = msg; el.style.color = "var(--bad)"; }
        btn.addEventListener("click", function () {
          var text = document.getElementById("comment-text").value.trim();
          if (!text) { bad(status, W.note_first); return; }
          btn.disabled = true; btn.textContent = W.js_sending; status.textContent = "";
          fetch("/consultant/task/${tid}/comment", {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ note: text })
          }).then(function (r) { return readJson(r, W); }).then(function (d) {
            if (d.ok) location.href = "/consultant/task/${tid}";
            else { bad(status, d.error || W.js_failed); btn.disabled = false; btn.textContent = W.note_send; }
          }).catch(function (e) { bad(status, W.js_network + e.message); btn.disabled = false; btn.textContent = W.note_send; });
        });

        var add = document.getElementById("doc-add");
        if (add) {
          var D = JSON.parse(add.getAttribute("data-words"));
          var dbtn = document.getElementById("doc-btn");
          var dstatus = document.getElementById("doc-status");
          dbtn.addEventListener("click", function () {
            var input = document.getElementById("doc-file");
            var f = input.files && input.files[0];
            if (!f) { bad(dstatus, D.docs_choose); return; }
            dbtn.disabled = true; dbtn.textContent = D.js_uploading; dstatus.textContent = "";
            var fd = new FormData(); fd.append("file", f);
            fetch("/api/consultant/tasks/${tid}/attachments", { method: "POST", credentials: "same-origin", body: fd })
              .then(function (r) { return readJson(r, D); })
              .then(function (d) {
                if (d.ok) location.href = "/consultant/task/${tid}";
                else { bad(dstatus, d.error || D.js_failed); dbtn.disabled = false; dbtn.textContent = D.docs_btn; }
              })
              .catch(function (e) { bad(dstatus, D.js_network + e.message); dbtn.disabled = false; dbtn.textContent = D.docs_btn; });
          });
        }
      })();
    </script>
    ` : ""}`;
}


/**
 * Alert settings for one consultant.
 *
 * Built as plain form POSTs with no inline JavaScript at all. That is a
 * deliberate choice, not laziness: these pages are JS template literals,
 * so an apostrophe or a \n inside an onclick handler is swallowed by the
 * literal and reaches the browser as a syntax error that kills every
 * script on the page. On 2026-09-28 exactly that took client search down
 * for five hours. A form needs no script, so it cannot break that way.
 *
 * What a consultant can see here is their own contact details and their
 * own switches. Nothing about any client appears on this page.
 */
function renderAlertsPage({ user = {}, me = {}, health = {}, linkCode = null, saved = false, linked = false, feed = [], hasApp = false }) {
  const lang = langOf(user), t = words(lang);
  const on = (v) => v ? "checked" : "";
  const chan = (key, label, enabled, address, missing, note) => {
    const ready = !!address;
    return `
    <div style="display:flex;gap:14px;align-items:flex-start;padding:16px 0;border-top:1px solid var(--travertine);">
      <input type="checkbox" id="ch-${key}" name="${key}" value="1" ${on(enabled)} style="margin-top:3px;flex:0 0 auto;">
      <div style="flex:1;">
        <label for="ch-${key}" style="font-size:15px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--charcoal);margin:0;">${esc(label)}</label>
        <div style="font-size:13px;color:${ready ? "var(--stone)" : "var(--ember)"};margin-top:3px;">
          ${esc(ready ? address : missing)}
        </div>
        ${note ? `<div class="hint">${esc(note)}</div>` : ""}
        ${enabled && !ready ? `<div class="hint" style="color:var(--bad);font-weight:600;">${esc(t("ch_nowhere"))}</div>` : ""}
      </div>
    </div>`;
  };

  const down = [];
  if (!health.email) down.push(t("down_email"));
  if (!health.sms) down.push(t("down_sms"));
  if (!health.telegram) down.push(t("down_tg"));

  // What has happened, newest first. This is the list the alerts point to.
  const labelOf = require("./notify").labelOf;
  const feedHtml = feed.length ? feed.map(f => {
    const href = f.task_id ? `/consultant/task/${Number(f.task_id)}`
      : (f.client_key ? `/consultant/client/${encodeURIComponent(f.client_key)}` : null);
    const inner = `
        <div>
          <div class="t">${esc(labelOf(f.kind, lang))}${f.seen_at ? "" : ` <span class="tag" style="--dot:var(--orange);margin-left:8px;">${esc(t("al_new"))}</span>`}</div>
          <div class="m">${esc(f.who || (f.task_id ? t("al_task_no", { id: f.task_id }) : t("al_a_client")))}</div>
        </div>
        <div class="m">${esc(fmtWhen(f.created_at, true, lang))}</div>
        <div class="m" style="font-weight:600;color:var(--ember);">${href ? esc(t("al_open")) : ""}</div>`;
    return href ? `<a href="${esc(href)}">${inner}</a>` : `<div>${inner}</div>`;
  }).join("") : `<div class="empty">${esc(t("al_empty"))}</div>`;

  return `
  <div class="page-header">
    <h1>${esc(t("al_h1"))}</h1>
    <div class="sub">${esc(t("al_sub"))}</div>
  </div>

  ${saved ? `<div class="card ok">${esc(t("al_saved"))}</div>` : ""}
  ${linked ? `<div class="card ok">${esc(t("al_linked"))}</div>` : ""}

  <h3>${esc(t("al_recent"))}</h3>
  <div class="card flush"><div class="rows">${feedHtml}</div></div>

  <div class="card" style="margin-top:28px;">
    <h3>${esc(t("al_told_h"))}</h3>
    <p style="color:var(--stone);margin:0 0 14px;">${esc(t("al_told_p"))}</p>
    <p class="quote" style="margin:0;white-space:normal;"><strong>${esc(t("al_rule_b"))}</strong> ${esc(t("al_rule"))}</p>
  </div>

  <form method="POST" action="/consultant/alerts">
    <div class="card">
      <h3>${esc(t("al_where_h"))}</h3>
      <div class="hint" style="margin:0 0 12px;">${esc(t("al_where_hint"))}</div>
      ${chan("notify_app", t("ch_app"), me.notify_app !== false, hasApp ? t("ch_app_ok") : "", t("ch_app_no"), t("ch_app_note"))}
      ${chan("notify_email", t("ch_email"), me.notify_email !== false, me.email, t("ch_email_no"), "")}
      ${chan("notify_sms", t("ch_sms"), me.notify_sms === true, me.phone, t("ch_sms_no"), t("ch_sms_note"))}
      ${chan("notify_telegram", t("ch_tg"), me.notify_telegram === true, me.telegram_chat_id ? t("ch_tg_ok") : "", t("ch_tg_no"), "")}
      <div style="padding:16px 0 0;border-top:1px solid var(--travertine);">
        <label for="al-lang">${esc(t("al_lang"))}</label>
        <select id="al-lang" name="lang" style="max-width:260px;">
          <option value="en"${lang === "en" ? " selected" : ""}>English</option>
          <option value="zh"${lang === "zh" ? " selected" : ""} lang="zh-Hans">简体中文</option>
        </select>
      </div>
      <div style="margin-top:18px;">
        <button type="submit" class="btn-primary">${esc(t("al_save"))}</button>
      </div>
    </div>
  </form>

  <div class="card">
    <h3>${esc(t("tg_h"))}</h3>
    <p style="color:var(--stone);margin-top:0;">${esc(t("tg_p"))} ${esc(linkCode ? t("tg_with") : t("tg_without"))}</p>
    ${linkCode ? `<div style="font-family:ui-monospace,Menlo,monospace;font-size:22px;font-weight:700;letter-spacing:2px;background:var(--marble);border:1px dashed var(--stone);border-radius:3px;padding:14px;text-align:center;margin:0 0 12px;">${esc(linkCode)}</div>
      <p class="hint" style="margin:0 0 14px;">${esc(t("tg_once"))}</p>` : ""}
    <form method="POST" action="/consultant/alerts/telegram-code" style="margin:0;">
      <button type="submit" class="btn-secondary">${esc(linkCode ? t("tg_regen") : t("tg_gen"))}</button>
    </form>
  </div>

  ${down.length ? `
  <div class="card note">
    <strong>${esc(t("down_h"))}</strong>
    <div class="hint" style="font-size:13px;">${esc(t("down_p", { what: down.join(t("down_or")) }))}</div>
  </div>` : ""}
  `;
}

module.exports = { renderChrome, renderDashboard, renderNewForm, renderTaskDetail, renderClientsPage, renderAlertsPage, STR, words, langOf };
