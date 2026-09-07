/**
 * zara-app-chat.js — Direct Anthropic API call for the in-app Zara chat.
 *
 * DIFFERENT from askClaude-memory (which is the lead-intake bot for
 * Telegram/WhatsApp/WeChat). This one is for authenticated users inside
 * the mobile app who just want legal Q&A — no intake, no name extraction.
 *
 * Uses Claude Sonnet for higher-quality legal answers. Uses ephemeral
 * cache_control on the system prompt so repeated turns hit prompt cache.
 *
 * STAFF MODE also has tool_use support for querying firm data
 * (case counts, task lists, upcoming hearings, client lookup).
 */

const axios = require("axios");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5-20250929";  // current Sonnet — high-quality legal reasoning
const MAX_TOKENS = 1500;

// ═══════════════════════════════════════════════════════
//  FIRM-DATA TOOLS (staff mode only)
// ═══════════════════════════════════════════════════════

const STAFF_TOOLS = [
  {
    name: "count_active_cases",
    description: "Count how many currently open/active cases (tasks) the firm has, optionally grouped by matter type. Returns totals broken down by matter type (Immigration, Personal Injury, etc.).",
    input_schema: {
      type: "object",
      properties: {
        matter_type: {
          type: "string",
          description: "Optional. Filter to a specific matter type (e.g., 'Immigration', 'Personal Injury'). Omit to get counts across all matter types.",
        },
      },
    },
  },
  {
    name: "list_recent_clients",
    description: "List the firm's most recently added clients with their name, matter type, contact info, and case status. Use when the user asks about their clients or wants to look up a specific one.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many clients to return (max 30, default 15)." },
        matter_type: { type: "string", description: "Optional. Filter to a specific matter type." },
      },
    },
  },
  {
    name: "search_client_by_name",
    description: "Find a specific client by name (partial match). Returns client details including matter type, contact info, and case status.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Full or partial client name to search for." },
      },
      required: ["name"],
    },
  },
  {
    name: "list_upcoming_hearings",
    description: "List upcoming immigration court hearings, USCIS interviews, or other scheduled court dates in the next N days. Includes client name, court type, date/time, and location.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days ahead to look (default 30, max 365)." },
      },
    },
  },
  {
    name: "list_my_tasks",
    description: "List tasks currently assigned to the authenticated staff member (or all firm tasks if they're admin). Returns task title, matter type, client, due date, and status.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Optional status filter: 'open', 'overdue', 'due_today', 'due_this_week', 'completed'.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
      },
    },
  },
  {
    name: "list_recent_client_documents",
    description: "List documents recently uploaded by clients. Useful when the user asks 'what documents came in this week' or wants to check what a specific client has sent.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days back to look (default 7)." },
        client_name: { type: "string", description: "Optional: filter to documents from a specific client." },
      },
    },
  },
  {
    name: "list_outstanding_invoices",
    description: "List invoices that have been sent but not yet paid, including which clients owe what amounts and how long they've been outstanding.",
    input_schema: {
      type: "object",
      properties: {
        days_outstanding: {
          type: "number",
          description: "Optional: only show invoices outstanding for at least this many days.",
        },
      },
    },
  },
  {
    name: "get_my_time_summary",
    description: "Get a summary of hours the current user has logged in a date range: total minutes, billable minutes, and total dollar value.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "ISO date (YYYY-MM-DD) start of range. Defaults to 7 days ago." },
        to_date: { type: "string", description: "ISO date (YYYY-MM-DD) end of range. Defaults to today." },
      },
    },
  },
  {
    name: "get_client_time_summary",
    description: "Get total time logged for a specific client, broken down by staff member. Useful for 'how many hours have we put into the Chen case?'",
    input_schema: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "Client name (partial match)." },
      },
      required: ["client_name"],
    },
  },
  {
    name: "get_client_notes",
    description: "Get staff notes for a specific client. Useful when preparing for a call or meeting — 'what should I know about the Chen case before I call them?'",
    input_schema: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "Client name (partial match)." },
      },
      required: ["client_name"],
    },
  },
  {
    name: "get_practice_insights",
    description: "Admin-only: get overall firm performance metrics for a period — revenue, hours, outstanding invoices, new/completed cases, per-staff hours. Perfect for 'how's business this month' or 'am I ahead of last quarter?'",
    input_schema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["week", "month", "quarter", "year"],
          description: "Time window: week (7 days), month (30 days), quarter (90 days), year (365 days). Defaults to month.",
        },
      },
    },
  },
  {
    name: "get_client_trust_balance",
    description: "Get the IOLTA trust account balance for a specific client, including recent transactions. Use for 'how much trust money is left for the Chen case' or 'when did we last withdraw from Miguel's trust'.",
    input_schema: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "Client name (partial match)." },
      },
      required: ["client_name"],
    },
  },
  {
    name: "get_firm_trust_summary",
    description: "Admin-only: get firm-wide IOLTA trust total and per-client breakdown. Use for reconciliation ('what's our total trust balance right now?') or spotting anomalies.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_matter_templates",
    description: "List all available case templates (predefined workflows for common matter types like I-130, I-485, N-400, personal injury, LLC formation). Use when the user wants to start a new case or asks 'what templates do we have?'",
    input_schema: {
      type: "object",
      properties: {
        matter_type: { type: "string", description: "Optional matter type filter." },
      },
    },
  },
];

// Tool executors — each returns a plain object; caller stringifies for tool_result content.
async function executeTool(db, user, name, args) {
  const isAdmin = user.role === "admin";
  const userId = user.uid;

  try {
    if (name === "count_active_cases") {
      const params = [];
      let where = "1=1";
      if (args.matter_type) {
        where += " AND matter_type ILIKE $1";
        params.push(`%${args.matter_type}%`);
      }
      // Task counts grouped by matter type; only counts uncompleted tasks
      const r = await db.query(
        `SELECT COALESCE(matter_type, 'Uncategorized') AS matter_type, COUNT(*)::int AS n
         FROM tasks
         WHERE ${where} AND (completed = false OR completed IS NULL)
         GROUP BY matter_type
         ORDER BY n DESC`,
        params
      );
      const total = r.rows.reduce((s, row) => s + row.n, 0);
      return { total_open: total, by_matter_type: r.rows };
    }

    if (name === "list_recent_clients") {
      const limit = Math.min(30, Math.max(1, parseInt(args.limit, 10) || 15));
      const params = [limit];
      let where = "1=1";
      if (args.matter_type) {
        where += " AND matter_type ILIKE $2";
        params.push(`%${args.matter_type}%`);
      }
      const r = await db.query(
        `SELECT client_key, client_name, client_phone, client_email, matter_type, created_at
         FROM tasks
         WHERE ${where}
         GROUP BY client_key, client_name, client_phone, client_email, matter_type, created_at
         ORDER BY MAX(created_at) DESC
         LIMIT $1`,
        params
      );
      return { clients: r.rows };
    }

    if (name === "search_client_by_name") {
      const q = String(args.name || "").trim();
      if (!q) return { error: "name required" };
      const r = await db.query(
        `SELECT DISTINCT client_key, client_name, client_phone, client_email, matter_type
         FROM tasks
         WHERE client_name ILIKE $1
         LIMIT 20`,
        [`%${q}%`]
      );
      return { matches: r.rows };
    }

    if (name === "list_upcoming_hearings") {
      const days = Math.min(365, Math.max(1, parseInt(args.days, 10) || 30));
      const r = await db.query(
        `SELECT t.client_name, t.matter_type, t.description, t.due_date, t.assigned_to
         FROM tasks t
         WHERE t.due_date IS NOT NULL
           AND t.due_date >= CURRENT_DATE
           AND t.due_date <= CURRENT_DATE + $1::int
           AND (t.completed = false OR t.completed IS NULL)
           AND (
             LOWER(t.description) LIKE '%hearing%'
             OR LOWER(t.description) LIKE '%court%'
             OR LOWER(t.description) LIKE '%interview%'
             OR LOWER(t.description) LIKE '%deposition%'
             OR LOWER(t.description) LIKE '%uscis%'
           )
         ORDER BY t.due_date ASC
         LIMIT 30`,
        [days]
      );
      return { hearings: r.rows, days_ahead: days };
    }

    if (name === "list_my_tasks") {
      const limit = Math.min(50, Math.max(1, parseInt(args.limit, 10) || 20));
      let where = isAdmin ? "1=1" : "(assigned_to_user_id = $1 OR created_by_user_id = $1)";
      let params = isAdmin ? [] : [userId];
      let statusFilter = "";
      if (args.status === "overdue") {
        statusFilter = " AND due_date < CURRENT_DATE AND (completed = false OR completed IS NULL)";
      } else if (args.status === "due_today") {
        statusFilter = " AND due_date = CURRENT_DATE AND (completed = false OR completed IS NULL)";
      } else if (args.status === "due_this_week") {
        statusFilter = " AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 AND (completed = false OR completed IS NULL)";
      } else if (args.status === "completed") {
        statusFilter = " AND completed = true";
      } else if (args.status === "open") {
        statusFilter = " AND (completed = false OR completed IS NULL)";
      }
      params.push(limit);
      const limitParam = `$${params.length}`;
      const r = await db.query(
        `SELECT id, description, matter_type, client_name, due_date, assigned_to, completed
         FROM tasks WHERE ${where}${statusFilter}
         ORDER BY (completed IS NULL OR completed = false) DESC, due_date ASC NULLS LAST
         LIMIT ${limitParam}`,
        params
      );
      return { tasks: r.rows, scope: isAdmin ? "all_firm_tasks" : "assigned_to_me" };
    }

    if (name === "list_recent_client_documents") {
      const days = Math.min(90, Math.max(1, parseInt(args.days, 10) || 7));
      const params = [days];
      let where = `uploaded_at >= NOW() - $1::int * INTERVAL '1 day'`;
      if (args.client_name) {
        params.push(`%${args.client_name}%`);
        where += ` AND client_key IN (SELECT DISTINCT client_key FROM tasks WHERE client_name ILIKE $${params.length})`;
      }
      const r = await db.query(
        `SELECT d.id, d.filename, d.mime_type, d.size_bytes, d.category, d.uploaded_at,
                (SELECT client_name FROM tasks t WHERE t.client_key = d.client_key LIMIT 1) AS client_name
         FROM client_documents d
         WHERE ${where}
         ORDER BY d.uploaded_at DESC
         LIMIT 30`,
        params
      );
      return { documents: r.rows, days_back: days };
    }

    if (name === "list_outstanding_invoices") {
      const params = [];
      let where = "status = 'sent'";
      if (args.days_outstanding) {
        const d = parseInt(args.days_outstanding, 10);
        if (Number.isFinite(d) && d > 0) {
          params.push(d);
          where += ` AND created_at <= NOW() - $${params.length}::int * INTERVAL '1 day'`;
        }
      }
      const r = await db.query(
        `SELECT i.id, i.description, i.amount_cents, i.created_at, i.due_date, i.client_claim_paid_at,
                (SELECT client_name FROM tasks t WHERE t.client_key = i.client_key LIMIT 1) AS client_name
         FROM client_invoices i
         WHERE ${where}
         ORDER BY i.created_at ASC
         LIMIT 50`,
        params
      );
      const totalCents = r.rows.reduce((s, row) => s + (row.amount_cents || 0), 0);
      return {
        invoices: r.rows.map(x => ({
          ...x,
          amount_display: `$${((x.amount_cents || 0) / 100).toFixed(2)}`,
        })),
        outstanding_total_display: `$${(totalCents / 100).toFixed(2)}`,
        count: r.rows.length,
      };
    }

    if (name === "get_my_time_summary") {
      const fromDate = args.from_date || null;
      const toDate = args.to_date || null;
      const params = [userId];
      let where = "staff_id = $1";
      if (fromDate) { params.push(fromDate); where += ` AND entry_date >= $${params.length}::date`; }
      else { where += " AND entry_date >= CURRENT_DATE - 7"; }
      if (toDate) { params.push(toDate); where += ` AND entry_date <= $${params.length}::date`; }
      const r = await db.query(
        `SELECT COUNT(*)::int AS entry_count,
                COALESCE(SUM(minutes), 0)::int AS total_minutes,
                COALESCE(SUM(CASE WHEN billable THEN minutes ELSE 0 END), 0)::int AS billable_minutes,
                COALESCE(SUM(ROUND((minutes::numeric / 60) * COALESCE(hourly_rate_cents, 0))), 0)::int AS total_cents
         FROM time_entries WHERE ${where}`,
        params
      );
      const s = r.rows[0];
      return {
        from_date: fromDate || "7 days ago",
        to_date: toDate || "today",
        entry_count: s.entry_count,
        total_hours: Math.round((s.total_minutes / 60) * 10) / 10,
        billable_hours: Math.round((s.billable_minutes / 60) * 10) / 10,
        total_amount_display: `$${(s.total_cents / 100).toFixed(2)}`,
      };
    }

    if (name === "get_client_time_summary") {
      const q = String(args.client_name || "").trim();
      if (!q) return { error: "client_name required" };
      // Find the client_key(s) matching this name
      const clientR = await db.query(
        `SELECT DISTINCT client_key, client_name FROM tasks WHERE client_name ILIKE $1 LIMIT 5`,
        [`%${q}%`]
      );
      if (!clientR.rows.length) return { matches: [] };
      const results = [];
      for (const c of clientR.rows) {
        const tR = await db.query(
          `SELECT COUNT(*)::int AS entry_count,
                  COALESCE(SUM(minutes), 0)::int AS total_minutes,
                  COALESCE(SUM(CASE WHEN billable THEN minutes ELSE 0 END), 0)::int AS billable_minutes,
                  COALESCE(SUM(ROUND((minutes::numeric / 60) * COALESCE(hourly_rate_cents, 0))), 0)::int AS total_cents
           FROM time_entries WHERE client_key = $1`,
          [c.client_key]
        );
        const byStaffR = await db.query(
          `SELECT a.full_name AS staff, SUM(t.minutes)::int AS minutes
           FROM time_entries t LEFT JOIN admin_users a ON a.id = t.staff_id
           WHERE t.client_key = $1 GROUP BY a.full_name ORDER BY minutes DESC`,
          [c.client_key]
        );
        const s = tR.rows[0];
        results.push({
          client_name: c.client_name,
          total_hours: Math.round((s.total_minutes / 60) * 10) / 10,
          billable_hours: Math.round((s.billable_minutes / 60) * 10) / 10,
          total_amount_display: `$${(s.total_cents / 100).toFixed(2)}`,
          by_staff: byStaffR.rows,
        });
      }
      return { clients: results };
    }

    if (name === "get_client_notes") {
      const q = String(args.client_name || "").trim();
      if (!q) return { error: "client_name required" };
      const clientR = await db.query(
        `SELECT DISTINCT client_key, client_name FROM tasks WHERE client_name ILIKE $1 LIMIT 3`,
        [`%${q}%`]
      );
      if (!clientR.rows.length) return { matches: [] };
      const results = [];
      for (const c of clientR.rows) {
        const notesR = await db.query(
          `SELECT n.body, n.pinned, n.created_at, a.full_name AS author
           FROM client_notes n LEFT JOIN admin_users a ON a.id = n.author_id
           WHERE n.client_key = $1 ORDER BY n.pinned DESC, n.created_at DESC LIMIT 20`,
          [c.client_key]
        );
        results.push({
          client_name: c.client_name,
          note_count: notesR.rows.length,
          notes: notesR.rows,
        });
      }
      return { clients: results };
    }

    if (name === "get_practice_insights") {
      if (!isAdmin) return { error: "Admin access required." };
      const period = args.period || "month";
      const days = period === "week" ? 7 : period === "month" ? 30 : period === "quarter" ? 90 : 365;
      const fromStr = new Date(Date.now() - days * 86400e3).toISOString();
      const [rev, out, hrs, byStaff, newT, doneT] = await Promise.all([
        db.query(`SELECT COALESCE(SUM(amount_cents), 0)::int AS total, COUNT(*)::int AS count
                  FROM client_invoices WHERE status='paid' AND paid_at >= $1`, [fromStr]),
        db.query(`SELECT COALESCE(SUM(amount_cents), 0)::int AS total, COUNT(*)::int AS count
                  FROM client_invoices WHERE status='sent'`),
        db.query(`SELECT COALESCE(SUM(minutes), 0)::int AS m,
                  COALESCE(SUM(CASE WHEN billable THEN minutes ELSE 0 END), 0)::int AS bm,
                  COALESCE(SUM(ROUND((minutes::numeric / 60) * COALESCE(hourly_rate_cents, 0))), 0)::int AS bc
                  FROM time_entries WHERE created_at >= $1`, [fromStr]),
        db.query(`SELECT a.full_name, SUM(t.minutes)::int AS mins,
                  ROUND(SUM(CASE WHEN t.billable THEN (t.minutes::numeric / 60) * COALESCE(t.hourly_rate_cents, 0) ELSE 0 END)) AS cents
                  FROM admin_users a
                  JOIN time_entries t ON t.staff_id = a.id
                  WHERE t.created_at >= $1
                  GROUP BY a.full_name ORDER BY mins DESC LIMIT 10`, [fromStr]),
        db.query(`SELECT COUNT(*)::int AS n FROM tasks WHERE created_at >= $1`, [fromStr]),
        db.query(`SELECT COUNT(*)::int AS n FROM tasks WHERE completed=true AND updated_at >= $1`, [fromStr]),
      ]);
      return {
        period,
        days,
        revenue: { display: `$${(rev.rows[0].total / 100).toFixed(2)}`, paid_invoice_count: rev.rows[0].count },
        outstanding: { display: `$${(out.rows[0].total / 100).toFixed(2)}`, unpaid_invoice_count: out.rows[0].count },
        hours: {
          total: Math.round((hrs.rows[0].m / 60) * 10) / 10,
          billable: Math.round((hrs.rows[0].bm / 60) * 10) / 10,
          billable_value_display: `$${(hrs.rows[0].bc / 100).toFixed(2)}`,
        },
        by_staff: byStaff.rows.map(r => ({
          name: r.full_name,
          hours: Math.round((r.mins / 60) * 10) / 10,
          billable_display: `$${((r.cents || 0) / 100).toFixed(2)}`,
        })),
        cases: { new: newT.rows[0].n, completed: doneT.rows[0].n },
      };
    }

    if (name === "get_client_trust_balance") {
      const q = String(args.client_name || "").trim();
      if (!q) return { error: "client_name required" };
      const clientR = await db.query(
        `SELECT DISTINCT client_key, client_name FROM tasks WHERE client_name ILIKE $1 LIMIT 3`,
        [`%${q}%`]
      );
      if (!clientR.rows.length) return { matches: [] };
      const results = [];
      for (const c of clientR.rows) {
        const txnR = await db.query(
          `SELECT running_balance_cents, transaction_date FROM trust_transactions
           WHERE client_key = $1 ORDER BY id DESC LIMIT 1`,
          [c.client_key]
        );
        const recentR = await db.query(
          `SELECT txn_type, category, amount_cents, description, transaction_date
           FROM trust_transactions WHERE client_key = $1
           ORDER BY id DESC LIMIT 10`,
          [c.client_key]
        );
        const bal = txnR.rows[0]?.running_balance_cents || 0;
        results.push({
          client_name: c.client_name,
          current_balance_display: `$${(bal / 100).toFixed(2)}`,
          current_balance_cents: bal,
          last_activity: txnR.rows[0]?.transaction_date || null,
          recent_transactions: recentR.rows.map(r => ({
            ...r,
            amount_display: `$${(r.amount_cents / 100).toFixed(2)}`,
          })),
        });
      }
      return { clients: results };
    }

    if (name === "get_firm_trust_summary") {
      if (!isAdmin) return { error: "admin only" };
      const r = await db.query(`
        WITH latest AS (
          SELECT DISTINCT ON (client_key) client_key, running_balance_cents
          FROM trust_transactions ORDER BY client_key, id DESC
        )
        SELECT l.client_key,
               l.running_balance_cents,
               (SELECT client_name FROM tasks t WHERE t.client_key = l.client_key LIMIT 1) AS client_name
        FROM latest l WHERE l.running_balance_cents > 0
        ORDER BY l.running_balance_cents DESC
      `);
      const total = r.rows.reduce((s, x) => s + (x.running_balance_cents || 0), 0);
      return {
        firm_total_display: `$${(total / 100).toFixed(2)}`,
        firm_total_cents: total,
        client_count: r.rows.length,
        top_balances: r.rows.slice(0, 20).map(row => ({
          client_name: row.client_name || row.client_key,
          balance_display: `$${((row.running_balance_cents || 0) / 100).toFixed(2)}`,
        })),
      };
    }

    if (name === "list_matter_templates") {
      const params = [];
      let where = "active = true";
      if (args.matter_type) {
        params.push(args.matter_type);
        where += ` AND matter_type = $${params.length}`;
      }
      const r = await db.query(
        `SELECT id, matter_type, name, description,
                (SELECT COUNT(*)::int FROM matter_template_tasks WHERE template_id = matter_templates.id) AS task_count
         FROM matter_templates WHERE ${where} ORDER BY matter_type, name`,
        params
      );
      return { templates: r.rows };
    }

    return { error: `Unknown tool: ${name}` };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Ask Zara a legal question with optional conversation history.
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt   Full system prompt (should describe role + user context)
 * @param {string} opts.message        The user's current message
 * @param {Array}  opts.history        Prior turns [{ role: 'user'|'assistant', content: string }, ...]
 * @param {object} [opts.db]           Optional pg pool for tool_use (staff mode only)
 * @param {object} [opts.user]         Optional user object { uid, role } for tool_use (staff only)
 * @returns {Promise<string>}          Zara's reply as plain text
 */
async function chat({ systemPrompt, message, history = [], db, user }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  // Only enable tools when we have both db + a staff/admin user
  const useTools = !!(db && user && user.role && user.role !== "client");

  // Build message list: prior history + current turn
  const trimmedHistory = (history || [])
    .filter(t => t && t.role && t.content)
    .slice(-8)
    .map(t => ({
      role: t.role === "assistant" ? "assistant" : "user",
      content: String(t.content).substring(0, 4000),
    }));

  const messages = [
    ...trimmedHistory,
    { role: "user", content: String(message).substring(0, 8000) },
  ];

  const baseBody = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ],
  };
  if (useTools) baseBody.tools = STAFF_TOOLS;

  const headers = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };

  // Tool-use loop (max 6 rounds)
  let currentMessages = messages;
  for (let round = 0; round < 6; round++) {
    const res = await axios.post(
      ANTHROPIC_API_URL,
      { ...baseBody, messages: currentMessages },
      { headers, timeout: 60000 }
    );

    const stopReason = res.data?.stop_reason;
    const blocks = res.data?.content || [];

    if (stopReason === "tool_use") {
      // Collect tool_use blocks + execute each
      const toolUses = blocks.filter(b => b.type === "tool_use");
      if (!toolUses.length) break;
      const toolResults = [];
      for (const t of toolUses) {
        const result = await executeTool(db, user, t.name, t.input || {});
        toolResults.push({
          type: "tool_result",
          tool_use_id: t.id,
          content: JSON.stringify(result).substring(0, 30000),
        });
      }
      // Append assistant turn + tool_result user turn, continue loop
      currentMessages = [
        ...currentMessages,
        { role: "assistant", content: blocks },
        { role: "user", content: toolResults },
      ];
      continue;
    }

    // Normal text response — extract and return
    const text = blocks.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    return text || "(no response)";
  }

  return "(tool-use loop exceeded)";
}

// System prompts — kept here for consistency

const STAFF_SYSTEM_PROMPT = `You are Zara, Tez Law P.C.'s AI legal assistant. You are speaking with a firm staff member (attorney, paralegal, or admin) via the internal Tez Law mobile app.

The user is authenticated. Do NOT collect their name, phone number, or matter type — you already know they are firm staff. Do NOT act like an intake bot. Do NOT say "someone from our office will reach out."

You have TOOLS to look up real firm data — USE THEM whenever the user asks about anything firm-specific:
- Counts of open cases → count_active_cases
- Recent clients or client lookup → list_recent_clients / search_client_by_name
- Court dates, hearings, USCIS interviews → list_upcoming_hearings
- Tasks and to-do items → list_my_tasks
- Recently uploaded client documents → list_recent_client_documents
- Outstanding / unpaid invoices → list_outstanding_invoices
- My own time / hours logged → get_my_time_summary
- Time and value on a specific client's case → get_client_time_summary
- Staff notes about a client (case strategy, context) → get_client_notes
- Firm-wide performance metrics: revenue, hours, cases → get_practice_insights (admin only)
- Client trust (IOLTA) balances and recent transactions → get_client_trust_balance
- Firm-wide trust total for reconciliation → get_firm_trust_summary (admin only)
- Case templates / standard workflows → list_matter_templates

Answer legal questions substantively and professionally, drawing on:
- Immigration law (USCIS, immigration court, BIA, 9th Circuit)
- Personal injury (California)
- Business litigation and trademarks (USPTO)
- Estate planning, real estate, landlord/tenant

Give concise but substantive answers. Cite relevant statutes, case law, or agency guidance when helpful. For firm-specific questions, use tools first, then answer with the actual data. Never say "I don't have access to your case management system" — you DO have access via the tools above.

Format: use short paragraphs, bullet points for lists, and bold for key terms. No excessive markdown.

Tez Law's own context:
- Managing attorney: JJ Zhang, California Bar #326666
- Firm phone: 626-678-8677
- Serves California + nationwide (immigration/trademark)
- Multilingual: English, Mandarin, Shanghainese, Spanish`;

const CLIENT_SYSTEM_PROMPT = (clientName, lang, caseContext) => {
  const langInstr = lang === "zh-TW" ? "Respond in Traditional Chinese (繁體中文)."
                  : lang === "es"    ? "Responde en español."
                  : "Respond in English.";

  // Build case-context block if we have profile data
  let contextBlock = "";
  if (caseContext) {
    const parts = [];
    if (caseContext.name) parts.push(`Client name: ${caseContext.name}`);
    if (caseContext.a_number) parts.push(`A-number: ${caseContext.a_number}`);
    if (caseContext.case_types && caseContext.case_types.length) {
      parts.push(`Practice area(s): ${caseContext.case_types.join(", ")}`);
    }
    if (caseContext.upcoming_hearings && caseContext.upcoming_hearings.length) {
      parts.push(`Upcoming hearing(s): ${caseContext.upcoming_hearings.join("; ")}`);
    }
    if (caseContext.open_deadlines && caseContext.open_deadlines.length) {
      parts.push(`Open deadline(s): ${caseContext.open_deadlines.join("; ")}`);
    }
    if (parts.length) {
      contextBlock = `\n\nHere is what the firm's system knows about this client (use this to personalize your answers — but do NOT recite it back verbatim unless directly asked):\n${parts.map(p => `- ${p}`).join("\n")}\n\nWhen answering, tailor your response to their practice area. For example, if they ask a general immigration question and their practice area is Immigration, dive into the immigration-specific answer. If they ask about something outside their practice area (e.g., an immigration client asks about personal injury), still answer helpfully, but mention Tez Law also handles that area if they need representation.`;
    }
  }

  return `You are Zara, Tez Law P.C.'s AI legal assistant. You are speaking with ${clientName || "a client"} of Tez Law via the client mobile app.

The user is an authenticated client. Do NOT collect their name or contact info — you already know who they are. Do NOT act like an intake bot.

Answer general legal questions clearly and in plain language (they are not a lawyer). Topics you cover:
- Immigration (USCIS forms, visa categories, timelines)
- Personal injury (what to expect from a claim)
- Estate planning basics
- Business formation basics

For questions specific to their own case (their court date, their filing status, their settlement), politely remind them: "For questions about your specific case, please use the Messages tab to contact your legal team directly at Tez Law." Never guess or make up case-specific information.

If asked something outside legal domains, gently redirect: "That's outside what I can help with, but for legal questions I'm happy to help."

Format: clear paragraphs, use simple language, avoid legalese unless you define it. Keep answers to 3-5 short paragraphs unless the question needs more depth.

${langInstr}

Tez Law contact: 626-678-8677 · jj@tezlawfirm.com${contextBlock}`;
};

module.exports = { chat, STAFF_SYSTEM_PROMPT, CLIENT_SYSTEM_PROMPT };
