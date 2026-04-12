import { Router } from "express";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { enqueueLeadToFunnel } from "./email-funnel.js";
import { db } from "../db/client.js";
import { requireAdmin } from "./auth.js";

const FB_PIXEL_ID    = "3814071692219923";
const FB_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

// ── Meta CAPI — fire Lead event server-side ─────────────────────────────────
async function fireCAPI({ email, phone, nome, eventSourceUrl, clientIpAddress, clientUserAgent, fbp, fbc }) {
  if (!FB_ACCESS_TOKEN) return;
  try {
    const hash = (v) => v ? createHash("sha256").update(v.trim().toLowerCase()).digest("hex") : undefined;
    const payload = {
      data: [{
        event_name: "Lead",
        event_time: Math.floor(Date.now() / 1000),
        event_id: randomUUID(),
        event_source_url: eventSourceUrl || "https://www.credpositivo.com/quizz",
        action_source: "website",
        user_data: {
          em: [hash(email)],
          ph: phone ? [hash(phone.replace(/\D/g, ""))] : undefined,
          fn: nome ? [hash(nome.split(" ")[0])] : undefined,
          client_ip_address: clientIpAddress || undefined,
          client_user_agent: clientUserAgent || undefined,
          fbp: fbp || undefined,
          fbc: fbc || undefined,
        },
        custom_data: { currency: "BRL", value: 97 },
      }],
      test_event_code: process.env.FB_TEST_EVENT_CODE || undefined,
    };
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${FB_PIXEL_ID}/events?access_token=${FB_ACCESS_TOKEN}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
    );
    const data = await res.json();
    console.log(`[quiz-lead] CAPI fired: events_received=${data.events_received ?? "?"}`);
  } catch (err) {
    console.warn("[quiz-lead] CAPI error:", err.message);
  }
}

export const quizLeadRouter = Router();

const LEADS_PATH = "/app/data/quiz-leads.json";

// ── Level mapping (English from form → Portuguese for funnel) ───────────────
const LEVEL_MAP = {
  critical: "critico",
  critico: "critico",
  attention: "atencao",
  atencao: "atencao",
  preventive: "preventivo",
  preventivo: "preventivo",
};

// ── Helpers ─────────────────────────────────────────────────────────────────
function ensureDataDir() {
  const dir = "/app/data";
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readLeads() {
  ensureDataDir();
  if (!existsSync(LEADS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(LEADS_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function writeLeads(leads) {
  ensureDataDir();
  writeFileSync(LEADS_PATH, JSON.stringify(leads, null, 2), "utf-8");
}

// ── POST /api/quiz-lead ─────────────────────────────────────────────────────
quizLeadRouter.post("/api/quiz-lead", async (req, res) => {
  try {
    const body = req.body || {};
    const { nome, whatsapp, email, score, level } = body;

    // 1) Validate required fields
    const missing = [];
    if (!nome) missing.push("nome");
    if (!whatsapp) missing.push("whatsapp");
    if (!email) missing.push("email");
    if (score === undefined || score === null) missing.push("score");
    if (!level) missing.push("level");

    if (missing.length > 0) {
      return res.status(400).json({
        error: "Missing required fields",
        missing,
      });
    }

    // 2) Map level to nivel (English → Portuguese)
    const nivel = LEVEL_MAP[level.toLowerCase()];
    if (!nivel) {
      return res.status(400).json({
        error: "Invalid level. Use: critical, attention, preventive (or critico, atencao, preventivo)",
      });
    }

    // 3) Fire Meta CAPI (server-side, non-blocking)
    fireCAPI({
      email,
      phone: whatsapp,
      nome,
      eventSourceUrl: body.url || undefined,
      clientIpAddress: req.ip || req.headers["x-forwarded-for"]?.split(",")[0].trim(),
      clientUserAgent: req.headers["user-agent"],
      fbp: req.cookies?.["_fbp"] || body.fbp,
      fbc: req.cookies?.["_fbc"] || body.fbc,
    }).catch(() => {});

    // 4) Enqueue into email funnel
    const funnelResult = await enqueueLeadToFunnel({
      nome,
      email,
      whatsapp,
      score,
      nivel,
    });

    // 5) Salvar no PostgreSQL (fonte primária) + JSON como fallback
    try {
      await db.query(
        `INSERT INTO quiz_leads
           (nome, whatsapp, email, cpf, score, level, nivel, variant, situacao, valor,
            onde, urgencia, tentativa, source, utm, url, funnel_enqueued,
            tempo_quiz, chegou_resultado, is_final)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          nome, whatsapp, email, body.cpf || null, score, level, nivel,
          body.variant || null, body.situacao || null, body.valor || null,
          JSON.stringify(body.onde || []), body.urgencia || null, body.tentativa || null,
          body.source || "quiz_credpositivo", JSON.stringify(body.utm || {}),
          body.url || null, funnelResult.success,
          body.tempo_quiz || null, body.chegou_resultado || false, body.is_final || false,
        ]
      );
      console.log(`[quiz-lead] Lead saved to DB: ${email} (${nivel}, score ${score})`);
    } catch (dbErr) {
      console.error("[quiz-lead] DB error, falling back to JSON:", dbErr.message);
      const leads = readLeads();
      leads.push({
        nome, whatsapp, email, score, level, nivel,
        variant: body.variant || null, situacao: body.situacao || null,
        valor: body.valor || null, onde: body.onde || [],
        urgencia: body.urgencia || null, tentativa: body.tentativa || null,
        source: body.source || "quiz_credpositivo", url: body.url || null,
        utm: body.utm || {}, timestamp: body.timestamp || new Date().toISOString(),
        funnelEnqueued: funnelResult.success, createdAt: new Date().toISOString(),
      });
      writeLeads(leads);
    }

    // 6) Return success
    res.json({
      success: true,
      nivel,
      scheduled: funnelResult.scheduled,
    });
  } catch (err) {
    console.error("[quiz-lead] Error:", err);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

// ── GET /api/quiz-leads (admin dashboard) ───────────────────────────────────
quizLeadRouter.get("/api/quiz-leads", requireAdmin, async (req, res) => {
  try {
    const { period = "today", limit = 200 } = req.query;

    const periodFilter =
      period === "today"   ? "created_at >= CURRENT_DATE" :
      period === "week"    ? "created_at >= CURRENT_DATE - INTERVAL '7 days'" :
      period === "month"   ? "created_at >= CURRENT_DATE - INTERVAL '30 days'" :
      "TRUE";

    const [leads, stats] = await Promise.all([
      db.query(
        `SELECT id, nome, whatsapp, email, score, nivel, situacao, urgencia,
                funnel_enqueued, is_final, tempo_quiz, chegou_resultado, utm, source, created_at,
                wa_dispatch_status, wa_dispatch_last_at, wa_dispatch_count
         FROM quiz_leads
         WHERE ${periodFilter}
         ORDER BY created_at DESC
         LIMIT $1`,
        [Number(limit)]
      ),
      db.query(
        `SELECT
           COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)                     AS hoje,
           COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days') AS semana,
           COUNT(*)                                                                AS total,
           COUNT(*) FILTER (WHERE nivel = 'critico')                              AS criticos,
           COUNT(*) FILTER (WHERE nivel = 'atencao')                              AS atencao,
           COUNT(*) FILTER (WHERE nivel = 'preventivo')                           AS preventivo,
           COUNT(*) FILTER (WHERE funnel_enqueued = true)                         AS no_funil,
           COUNT(*) FILTER (WHERE is_final = true)                                AS foi_checkout,
           COUNT(*) FILTER (WHERE chegou_resultado = true)                        AS chegou_resultado,
           ROUND(AVG(score)::numeric, 1)                                          AS score_medio,
           ROUND(AVG(tempo_quiz) FILTER (WHERE tempo_quiz IS NOT NULL)::numeric)  AS tempo_medio
         FROM quiz_leads`
      ),
    ]);

    res.json({ leads: leads.rows, stats: stats.rows[0] });
  } catch (err) {
    console.error("[quiz-leads] Error:", err);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

// ── PATCH /api/quiz-leads/:id/dispatch-status ───────────────────────────────
// Admin action: pause/resume/reset dispatch for a given lead.
// Allowed values: novo | parado | respondeu | optout
quizLeadRouter.patch("/api/quiz-leads/:id/dispatch-status", requireAdmin, async (req, res) => {
  const allowed = new Set(["novo", "parado", "respondeu", "optout"]);
  const { id } = req.params;
  const { status } = req.body || {};
  if (!allowed.has(status)) {
    return res.status(400).json({ error: "invalid status", allowed: [...allowed] });
  }
  try {
    const r = await db.query(
      `UPDATE quiz_leads SET wa_dispatch_status = $1 WHERE id = $2
       RETURNING id, wa_dispatch_status`,
      [status, Number(id)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, lead: r.rows[0] });
  } catch (err) {
    console.error("[quiz-leads] PATCH dispatch-status error:", err);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});
