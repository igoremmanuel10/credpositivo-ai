/**
 * Wavoip Voice Call Module for CredPositivo
 *
 * Wavoip is a browser-oriented library. We use JSDOM to provide
 * a browser-like environment so the Socket.IO signaling works in Node.js.
 * Audio streaming (WebRTC) is not used server-side — we only
 * need to initiate call signals.
 */

import { JSDOM } from "jsdom";
import { createRequire } from "module";
import Redis from "ioredis";
import { config } from "../config.js";
import { normalizePhone } from "../utils/phone.js";
import { db } from "../db/client.js";

// Setup JSDOM environment for wavoip-api
const dom = new JSDOM("", {
  url: "https://app.wavoip.com",
  pretendToBeVisual: true,
});

// Assign browser globals from JSDOM
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
globalThis.self = dom.window;
globalThis.HTMLElement = dom.window.HTMLElement;

// Polyfill navigator.mediaDevices for Node.js
const fakeMediaDevices = {
  enumerateDevices: async () => [],
  getUserMedia: async () => new (globalThis.MediaStream || class {})(),
  addEventListener: () => {},
  removeEventListener: () => {},
};
// navigator is read-only on JSDOM window, use defineProperty
Object.defineProperty(dom.window.navigator, "mediaDevices", {
  value: fakeMediaDevices,
  writable: true,
  configurable: true,
});
globalThis.navigator = dom.window.navigator;

// Polyfill navigator.userActivation for Node.js (needed by wavoip-api callStart)
if (!dom.window.navigator.userActivation) {
  Object.defineProperty(dom.window.navigator, "userActivation", {
    value: { hasBeenActive: true, isActive: true },
    writable: true,
    configurable: true,
  });
  globalThis.navigator = dom.window.navigator;
}

// Stub WebRTC/Audio APIs that wavoip needs but JSDOM does not provide
if (typeof globalThis.MediaStream === "undefined") {
  globalThis.MediaStream = class MediaStream {};
  dom.window.MediaStream = globalThis.MediaStream;
}
if (typeof globalThis.AudioContext === "undefined") {
  globalThis.AudioContext = class AudioContext {
    createMediaStreamSource() { return { connect() {} }; }
    createScriptProcessor() { return { connect() {}, addEventListener() {} }; }
    get destination() { return {}; }
    close() {}
    get sampleRate() { return 48000; }
  };
  dom.window.AudioContext = globalThis.AudioContext;
}
if (typeof globalThis.webkitAudioContext === "undefined") {
  globalThis.webkitAudioContext = globalThis.AudioContext;
  dom.window.webkitAudioContext = globalThis.AudioContext;
}

// Load wavoip-api via CommonJS require (it uses UMD format)
const require = createRequire(import.meta.url);
const Wavoip = require("wavoip-api");

const redis = new Redis(config.redis.url);

let wavoipInstance = null;
let whatsappInstance = null;
let connected = false;
let reconnectAttempts = 0;
let lastConnectTime = 0;
let gaveUp = false;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 5000;
const STABLE_CONNECTION_MS = 30000; // Connection must last 30s to be considered stable

/**
 * Initialize Wavoip connection.
 * Uses exponential backoff with max retry limit to prevent log spam.
 */
export function initWavoip() {
  if (config.wavoip.enabled === false) {
    console.log("[WAVOIP] Disabled, skipping initialization");
    return;
  }

  if (config.wavoip.token === "") {
    console.log("[WAVOIP] No token configured, skipping initialization");
    return;
  }

  try {
    const WavoipClass = Wavoip.default || Wavoip.Wavoip || Wavoip;
    wavoipInstance = new WavoipClass();
    whatsappInstance = wavoipInstance.connect(config.wavoip.token);

    // Disable automatic reconnection — we handle it manually with backoff
    if (whatsappInstance.socket && whatsappInstance.socket.io) {
      whatsappInstance.socket.io.opts.reconnection = false;
    }

    whatsappInstance.socket.on("connect", () => {
      connected = true;
      lastConnectTime = Date.now();
      if (!gaveUp) {
        console.log("[WAVOIP] Connected successfully");
      }
    });

    whatsappInstance.socket.on("disconnect", (reason) => {
      connected = false;
      const connectionDuration = Date.now() - lastConnectTime;

      // If connection lasted long enough, reset the counter
      if (connectionDuration > STABLE_CONNECTION_MS) {
        reconnectAttempts = 0;
      }

      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        if (!gaveUp) {
          console.warn("[WAVOIP] Connection unstable — giving up after " + MAX_RECONNECT_ATTEMPTS + " attempts. Will retry on next makeCall.");
          gaveUp = true;
          // Force close the socket to stop internal auto-reconnects
          try { whatsappInstance.socket.disconnect(); } catch (e) {}
        }
        return;
      }
      reconnectAttempts++;
      const backoff = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts - 1), 60000);
      console.log("[WAVOIP] Disconnected (" + reason + ", lasted " + Math.round(connectionDuration / 1000) + "s). Reconnecting in " + Math.round(backoff / 1000) + "s (attempt " + reconnectAttempts + "/" + MAX_RECONNECT_ATTEMPTS + ")");
      setTimeout(() => {
        try {
          whatsappInstance.socket.connect();
        } catch (err) {
          console.error("[WAVOIP] Reconnect failed:", err.message);
        }
      }, backoff);
    });

    whatsappInstance.socket.on("connect_error", (err) => {
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        console.error("[WAVOIP] Connection error:", err.message);
      }
    });

    whatsappInstance.socket.on("error", (err) => {
      console.error("[WAVOIP] Socket error:", err);
    });

    console.log("[WAVOIP] Initialization started with token:", config.wavoip.token.substring(0, 8) + "...");
  } catch (err) {
    console.error("[WAVOIP] Failed to initialize:", err);
  }
}

/**
 * Check if Wavoip is connected and ready.
 */
export function isWavoipReady() {
  return config.wavoip.enabled && connected && whatsappInstance != null;
}

async function getDailyCallCount(phone) {
  const key = "wavoip:calls:" + phone + ":" + new Date().toISOString().slice(0, 10);
  const count = await redis.get(key);
  return parseInt(count || "0");
}

async function incrementDailyCallCount(phone) {
  const key = "wavoip:calls:" + phone + ":" + new Date().toISOString().slice(0, 10);
  await redis.incr(key);
  await redis.expire(key, 86400);
}

/**
 * Make a voice call to a WhatsApp number.
 *
 * @param {string} phone - Phone number (e.g. '5571999999999')
 * @param {object} [options]
 * @param {string} [options.reason] - Reason for the call
 * @param {boolean} [options.skipLimitCheck] - Skip daily limit check
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function makeCall(phone, options = {}) {
  const { reason = "manual", skipLimitCheck = false } = options;

  if (config.wavoip.enabled === false) {
    return { success: false, message: "Wavoip is disabled" };
  }

  if (whatsappInstance == null) {
    return { success: false, message: "Wavoip not initialized" };
  }

  // Lazy reconnect: if disconnected but instance exists, try to reconnect
  if (connected === false) {
    console.log("[WAVOIP] Not connected, attempting lazy reconnect for call...");
    reconnectAttempts = 0;
    gaveUp = false;
    try {
      whatsappInstance.socket.connect();
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      console.error("[WAVOIP] Lazy reconnect failed:", err.message);
    }
    if (connected === false) {
      return { success: false, message: "Wavoip not connected (reconnect failed)" };
    }
  }

  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone == null || normalizedPhone === "") {
    return { success: false, message: "Invalid phone number: " + phone };
  }

  if (skipLimitCheck === false) {
    const dailyCount = await getDailyCallCount(normalizedPhone);
    if (dailyCount >= config.wavoip.maxDailyCalls) {
      console.log("[WAVOIP] Daily call limit reached for " + normalizedPhone + " (" + dailyCount + "/" + config.wavoip.maxDailyCalls + ")");
      return { success: false, message: "Daily call limit reached (" + dailyCount + "/" + config.wavoip.maxDailyCalls + ")" };
    }
  }

  try {
    const whatsappId = normalizedPhone + "@s.whatsapp.net";
    console.log("[WAVOIP] Starting call to " + normalizedPhone + " (reason: " + reason + ")");

    whatsappInstance.callStart({ whatsappid: whatsappId });

    await incrementDailyCallCount(normalizedPhone);

    const callLog = JSON.stringify({
      phone: normalizedPhone,
      reason: reason,
      timestamp: new Date().toISOString(),
    });
    await redis.lpush("wavoip:call_log", callLog);
    await redis.ltrim("wavoip:call_log", 0, 999);

    // Log to database (non-fatal if migration hasn't run yet)
    try {
      await db.query(
        `INSERT INTO voice_calls (phone, event_type, status, provider, call_mode, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [normalizedPhone, reason, 'initiated', 'wavoip', 'whatsapp']
      );
    } catch (dbErr) {
      // Silently ignore if provider/call_mode columns don't exist yet
      if (!dbErr.message.includes('provider') && !dbErr.message.includes('call_mode')) {
        console.warn("[WAVOIP] DB log failed:", dbErr.message);
      }
    }

    console.log("[WAVOIP] Call initiated to " + normalizedPhone);
    return { success: true, message: "Call initiated to " + normalizedPhone };
  } catch (err) {
    console.error("[WAVOIP] Call failed to " + normalizedPhone + ":", err);
    return { success: false, message: "Call failed: " + err.message };
  }
}

/**
 * Get Wavoip connection status.
 */
export function getWavoipStatus() {
  return {
    enabled: config.wavoip.enabled,
    connected: connected,
    tokenConfigured: config.wavoip.token !== "",
    maxDailyCalls: config.wavoip.maxDailyCalls,
  };
}

/**
 * Get recent call log entries.
 */
export async function getCallLog(count = 20) {
  const entries = await redis.lrange("wavoip:call_log", 0, count - 1);
  return entries.map(function(e) { return JSON.parse(e); });
}
