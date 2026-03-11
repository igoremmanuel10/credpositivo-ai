import { Router } from "express";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { enqueueLeadToFunnel } from "./email-funnel.js";

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

    // 3) Enqueue into email funnel
    const funnelResult = await enqueueLeadToFunnel({
      nome,
      email,
      whatsapp,
      score,
      nivel,
    });

    // 4) Log the lead to JSON file
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

    // 5) Return success
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
