import { Router } from "express";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

export const emailFunnelRouter = Router();

// ── Config ──────────────────────────────────────────────────────────────────
const BREVO_KEY = process.env.BREVO_API_KEY || "";
const BREVO_BASE = "https://api.brevo.com/v3";
const SENDER = {
  name: process.env.BREVO_SENDER_NAME || "CredPositivo",
  email: process.env.BREVO_SENDER_EMAIL || "sac@credpositivo.com",
};
const WHATSAPP_LINK =
  "https://api.whatsapp.com/send?phone=5521971364221&text=Oi%2C%20vim%20pelo%20email%20e%20quero%20saber%20mais%20sobre%20o%20diagnostico%20completo";

const QUEUE_PATH = "/app/data/email-queue.json";

const TEMPLATES = {
  critico:   [1, 2, 3, 4, 5, 6, 7],
  atencao:   [8, 9, 10, 11, 12, 13, 14],
  preventivo:[15, 16, 17, 18, 19, 20, 21],
};

const LIST_IDS = { critico: 3, atencao: 4, preventivo: 5 };

// Cadence: D+0 sent immediately, then D+1, D+2, D+3, D+5, D+7, D+10
const CADENCE_DAYS = [1, 2, 3, 5, 7, 10];

// ── Helpers ─────────────────────────────────────────────────────────────────
function ensureDataDir() {
  const dir = "/app/data";
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readQueue() {
  ensureDataDir();
  if (!existsSync(QUEUE_PATH)) return [];
  try {
    return JSON.parse(readFileSync(QUEUE_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  ensureDataDir();
  writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2), "utf-8");
}

async function brevoRequest(path, body) {
  const url = `${BREVO_BASE}${path}`;
  console.log(`[email-funnel] Brevo request: ${path}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "api-key": BREVO_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    console.error(`[email-funnel] Brevo error ${res.status}:`, data);
  }
  return { ok: res.ok, status: res.status, data };
}

async function createOrUpdateContact(lead) {
  const nivel = (lead.nivel || "critico").toLowerCase();
  const listId = LIST_IDS[nivel] || LIST_IDS.critico;
  return brevoRequest("/contacts", {
    email: lead.email,
    attributes: {
      FIRSTNAME: lead.nome || "",
      SCORE: String(lead.score || 0),
      NIVEL: nivel,
      WHATSAPP_NUM: (lead.whatsapp || "").replace(/\D/g, ""),
    },
    listIds: [listId],
    updateEnabled: true,
  });
}

async function sendTemplateEmail(email, nome, score, templateId) {
  console.log(`[email-funnel] Sending template ${templateId} to ${email}`);
  return brevoRequest("/smtp/email", {
    sender: SENDER,
    to: [{ email, name: nome || "" }],
    templateId,
    params: {
      FIRSTNAME: nome || "",
      SCORE: String(score || 0),
      WHATSAPP_LINK: WHATSAPP_LINK,
    },
  });
}

function buildSendDates(now) {
  return CADENCE_DAYS.map((d) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + d);
    // 10:00 BRT = 13:00 UTC
    date.setUTCHours(13, 0, 0, 0);
    return date.toISOString();
  });
}

// ── Core enqueue logic (reusable) ───────────────────────────────────────────
export async function enqueueLeadToFunnel({ nome, email, whatsapp, score, nivel }) {
  const cleanNivel = (nivel || "critico").toLowerCase();
  if (!TEMPLATES[cleanNivel]) {
    throw new Error("Invalid nivel. Use: critico, atencao, preventivo");
  }

  // 1) Create/update contact in Brevo
  const contactRes = await createOrUpdateContact({ nome, email, whatsapp, score, nivel: cleanNivel });
  console.log(`[email-funnel] Contact sync for ${email}: ${contactRes.ok ? "OK" : "FAIL"}`);

  // 2) Send D+0 email immediately (first template)
  const templates = TEMPLATES[cleanNivel];
  const d0Res = await sendTemplateEmail(email, nome, score, templates[0]);
  console.log(`[email-funnel] D+0 email (template ${templates[0]}) to ${email}: ${d0Res.ok ? "SENT" : "FAIL"}`);

  // 3) Schedule remaining 6 emails
  const now = new Date();
  const queue = readQueue();

  // Remove existing entry for this email if any (re-enqueue)
  const filtered = queue.filter((e) => e.email !== email);

  const entry = {
    email,
    nome: nome || "",
    score: score || 0,
    nivel: cleanNivel,
    templateIds: templates.slice(1), // templates 2-7
    sendDates: buildSendDates(now),
    sent: [false, false, false, false, false, false],
    active: true,
    createdAt: now.toISOString(),
  };

  filtered.push(entry);
  writeQueue(filtered);

  console.log(`[email-funnel] Enqueued ${email} (${cleanNivel}), 6 emails scheduled`);

  return {
    success: true,
    email,
    nivel: cleanNivel,
    d0Sent: d0Res.ok,
    scheduled: entry.sendDates,
  };
}

// ── POST /api/email-funnel/enqueue ──────────────────────────────────────────
emailFunnelRouter.post("/api/email-funnel/enqueue", async (req, res) => {
  try {
    const { nome, email, whatsapp, score, nivel } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    const result = await enqueueLeadToFunnel({ nome, email, whatsapp, score, nivel });
    res.json(result);
  } catch (err) {
    console.error("[email-funnel] enqueue error:", err);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

// ── GET /api/email-funnel/status ────────────────────────────────────────────
emailFunnelRouter.get("/api/email-funnel/status", (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: "email query param required" });

    const queue = readQueue();
    const entry = queue.find((e) => e.email === email);

    if (!entry) return res.status(404).json({ error: "Lead not found in funnel" });

    const sentCount = entry.sent.filter(Boolean).length + 1; // +1 for D+0
    const totalEmails = 7;

    res.json({
      email: entry.email,
      nome: entry.nome,
      nivel: entry.nivel,
      score: entry.score,
      active: entry.active,
      progress: `${sentCount}/${totalEmails}`,
      sentEmails: sentCount,
      totalEmails,
      nextEmail: entry.active
        ? entry.sendDates.find((d, i) => !entry.sent[i]) || null
        : null,
      createdAt: entry.createdAt,
    });
  } catch (err) {
    console.error("[email-funnel] status error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── POST /api/email-funnel/cancel ───────────────────────────────────────────
emailFunnelRouter.post("/api/email-funnel/cancel", (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "email is required" });

    const queue = readQueue();
    const entry = queue.find((e) => e.email === email);

    if (!entry) return res.status(404).json({ error: "Lead not found in funnel" });

    entry.active = false;
    writeQueue(queue);

    console.log(`[email-funnel] Cancelled funnel for ${email}`);
    res.json({ success: true, email, message: "Funnel cancelled" });
  } catch (err) {
    console.error("[email-funnel] cancel error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── Poller ──────────────────────────────────────────────────────────────────
export async function processEmailQueue() {
  const queue = readQueue();
  const now = new Date();
  let changed = false;

  for (const entry of queue) {
    if (!entry.active) continue;

    for (let i = 0; i < entry.templateIds.length; i++) {
      if (entry.sent[i]) continue;

      const sendDate = new Date(entry.sendDates[i]);
      if (sendDate > now) continue;

      // Time to send
      const result = await sendTemplateEmail(
        entry.email,
        entry.nome,
        entry.score,
        entry.templateIds[i]
      );

      if (result.ok) {
        entry.sent[i] = true;
        changed = true;
        console.log(
          `[email-funnel] Poller sent template ${entry.templateIds[i]} to ${entry.email} (${i + 2}/7)`
        );
      } else {
        console.error(
          `[email-funnel] Poller failed template ${entry.templateIds[i]} to ${entry.email}`
        );
      }
    }

    // If all sent, mark inactive
    if (entry.sent.every(Boolean)) {
      entry.active = false;
      changed = true;
      console.log(`[email-funnel] Funnel complete for ${entry.email}`);
    }
  }

  if (changed) writeQueue(queue);
}

// Start poller — every 5 minutes
export function startEmailFunnelPoller() {
  console.log("[email-funnel] Poller started (every 5 min)");
  setInterval(processEmailQueue, 5 * 60 * 1000);
  // Run once on startup after a short delay
  setTimeout(processEmailQueue, 10_000);
}
