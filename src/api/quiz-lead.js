import { Router } from "express";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { enqueueLeadToFunnel } from "./email-funnel.js";

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

    // 5) Log the lead to JSON file
    const leads = readLeads();
    leads.push({
      nome,
      whatsapp,
      email,
      score,
      level,
      nivel,
      variant: body.variant || null,
      situacao: body.situacao || null,
      valor: body.valor || null,
      onde: body.onde || [],
      urgencia: body.urgencia || null,
      tentativa: body.tentativa || null,
      source: body.source || "quiz_form",
      url: body.url || null,
      utm: body.utm || {},
      timestamp: body.timestamp || new Date().toISOString(),
      funnelEnqueued: funnelResult.success,
      createdAt: new Date().toISOString(),
    });
    writeLeads(leads);

    console.log(`[quiz-lead] Lead saved: ${email} (${nivel}, score ${score})`);

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
