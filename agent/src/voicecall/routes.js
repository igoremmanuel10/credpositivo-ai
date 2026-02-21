import { Router } from "express";
import { readFileSync } from "fs";
import { resolve } from "path";
import { makeCall, getWavoipStatus, getCallLog } from "./wavoip.js";

export const voicecallRouter = Router();

/**
 * POST /api/voicecall/call
 * Initiate a voice call to a WhatsApp number.
 * Body: { phone: string, reason?: string }
 */
voicecallRouter.post("/api/voicecall/call", async (req, res) => {
  try {
    const { phone, reason } = req.body;

    if (phone == null || phone === "") {
      return res.status(400).json({ error: "Phone number is required" });
    }

    const result = await makeCall(phone, { reason: reason || "api" });

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (err) {
    console.error("[VOICECALL] API error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/voicecall/status
 * Get Wavoip connection status.
 */
voicecallRouter.get("/api/voicecall/status", (req, res) => {
  res.json(getWavoipStatus());
});

/**
 * GET /api/voicecall/log
 * Get recent call log.
 */
voicecallRouter.get("/api/voicecall/log", async (req, res) => {
  try {
    const count = parseInt(req.query.count || "20");
    const log = await getCallLog(count);
    res.json({ calls: log, total: log.length });
  } catch (err) {
    console.error("[VOICECALL] Log error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});



/**
 * POST /api/voicecall/webhook
 * Receive Wavoip webhook events (call status, etc.)
 */
voicecallRouter.post("/api/voicecall/webhook", async (req, res) => {
  const event = req.body;
  console.log("[WAVOIP Webhook] Event received:", JSON.stringify(event));
  res.json({ ok: true });
});

/**
 * GET /phone
 * Serve the Wavoip webphone page.
 */
voicecallRouter.get("/phone", (req, res) => {
  try {
    const html = readFileSync(resolve(process.cwd(), "public", "phone.html"), "utf8");
    res.type("html").send(html);
  } catch (err) {
    console.error("[VOICECALL] Phone page error:", err);
    res.status(500).send("Phone page not found");
  }
});
