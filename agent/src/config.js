import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3001'),

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    visionModel: process.env.OPENAI_VISION_MODEL || 'gpt-4o',
    organization: process.env.OPENAI_ORG_ID || '',
  },

  tts: {
    enabled: process.env.TTS_ENABLED !== 'false',
    model: process.env.TTS_MODEL || 'tts-1-hd',
    voice: process.env.TTS_VOICE || 'onyx',
    maxDailyPerLead: parseInt(process.env.TTS_MAX_DAILY || '2'),
  },

  quepasa: {
    apiUrl: process.env.QUEPASA_API_URL || 'http://localhost:31000',
    masterKey: process.env.QUEPASA_MASTER_KEY,
    botToken: process.env.QUEPASA_BOT_TOKEN,
    botTokens: (process.env.QUEPASA_BOT_TOKENS || process.env.QUEPASA_BOT_TOKEN || '').split(',').filter(Boolean),
  },

  chatwoot: {
    apiUrl: process.env.CHATWOOT_API_URL || 'http://localhost:3000',
    apiToken: process.env.CHATWOOT_API_TOKEN,
    accountId: process.env.CHATWOOT_ACCOUNT_ID || '1',
    inboxId: process.env.CHATWOOT_INBOX_ID || '1',
    inboxMapping: Object.fromEntries(
      (process.env.CHATWOOT_INBOX_MAPPING || '').split(',').filter(Boolean).map(pair => {
        const [phone, id] = pair.split(':');
        return [phone, id];
      })
    ),
  },

  database: {
    url: process.env.DATABASE_URL || 'postgresql://credpositivo:credpositivo@localhost:5432/credpositivo_agent',
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  site: {
    url: process.env.SITE_URL || 'https://www.credpositivo.com/cadastro',
    whatsappNumber: process.env.WHATSAPP_NUMBER || '5571936180654',
    ebookUrl: process.env.EBOOK_URL || '',
  },

  mercadopago: {
    publicKey: process.env.MP_PUBLIC_KEY || '',
    accessToken: process.env.MP_ACCESS_TOKEN || '',
    clientId: process.env.MP_CLIENT_ID || '',
    clientSecret: process.env.MP_CLIENT_SECRET || '',
  },

  apiful: {
    token: process.env.APIFUL_TOKEN || '',
    baseUrl: process.env.APIFUL_BASE_URL || 'https://api.apifull.com.br',
  },

  media: {
    enabled: process.env.MEDIA_ENABLED !== 'false',
    welcomeVideoUrl: process.env.MEDIA_WELCOME_VIDEO || '',
    diagnosticoImageUrl: process.env.MEDIA_DIAGNOSTICO_IMAGE || '',
  },

  sdr: {
    enabled: process.env.SDR_ENABLED !== 'false',
    botToken: process.env.SDR_BOT_TOKEN || '',
    botPhone: process.env.SDR_BOT_PHONE || '5521971364221',
    phoneToPersona: Object.fromEntries(
      (process.env.PHONE_TO_PERSONA || '5521971364221:paulo,5571936180654:augusto')
        .split(',').filter(Boolean).map(pair => {
          const [phone, persona] = pair.split(':');
          return [phone, persona];
        })
    ),
  },

  vapi: {    enabled: process.env.VAPI_ENABLED === "true",    privateKey: process.env.VAPI_PRIVATE_KEY || "",    publicKey: process.env.VAPI_PUBLIC_KEY || "",    orgId: process.env.VAPI_ORG_ID || "",    phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID || "",    assistantId: process.env.VAPI_ASSISTANT_ID || "",    serverUrl: process.env.VAPI_SERVER_URL || "",    maxCallsPerLeadPerDay: parseInt(process.env.VAPI_MAX_CALLS_PER_LEAD_DAY || "1"),    maxCallDurationSeconds: parseInt(process.env.VAPI_MAX_CALL_DURATION || "300"),    callDelayMinutes: parseInt(process.env.VAPI_CALL_DELAY_MINUTES || "30"),  },
  wavoip: {
    enabled: process.env.WAVOIP_ENABLED === 'true',
    token: process.env.WAVOIP_TOKEN || '',
    maxDailyCalls: parseInt(process.env.WAVOIP_MAX_DAILY_CALLS || '5'),
  },
  followupEnabled: process.env.FOLLOWUP_ENABLED !== 'false',

  // Business hours (BRT = UTC-3)
  businessHours: {
    weekday: { start: 8, end: 20 },   // Seg-Sex: 8h-20h
    saturday: { start: 8, end: 14 },   // Sáb: 8h-14h
    sunday: false,                       // Dom: não enviar (exceto resposta)
  },

  limits: {
    maxMessagesPerPhase: { 0: 2, 1: 2, 2: 8, 3: 4, 4: 3, 5: Infinity },
    maxLinksPerConversation: 3,
    maxPriceEscalation: 3,
    followupDelays: [48 * 60, 7 * 24 * 60, 14 * 24 * 60],
    conversationTimeoutMinutes: 48 * 60,
    debounceSeconds: 3,
    cooldownSeconds: 10,
    maxBubblesPerResponse: 1,
    maxConversationMessages: 200,
    maxAgentMessagesPerHour: 20,
    maxFollowupsPerDay: 1,
    maxAutoTouchpointsPerWeek: 3,
  },
};

/**
 * Check if current time is within business hours (BRT).
 * @returns {boolean}
 */
export function isBusinessHours() {
  const now = new Date();
  // BRT = UTC-3
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const hour = brt.getUTCHours();
  const day = brt.getUTCDay(); // 0=Sun, 6=Sat

  if (day === 0) return false; // Sunday
  if (day === 6) {
    return hour >= config.businessHours.saturday.start && hour < config.businessHours.saturday.end;
  }
  return hour >= config.businessHours.weekday.start && hour < config.businessHours.weekday.end;
}

/**
 * Get next allowed send time in ms from now.
 * Returns 0 if currently in business hours.
 * @returns {number} Milliseconds until next business hour window
 */
export function msUntilNextBusinessHour() {
  if (isBusinessHours()) return 0;

  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const hour = brt.getUTCHours();
  const day = brt.getUTCDay();

  let nextStart;
  if (day === 0) {
    // Sunday → Monday 8h BRT
    nextStart = new Date(brt);
    nextStart.setUTCDate(nextStart.getUTCDate() + 1);
    nextStart.setUTCHours(config.businessHours.weekday.start, 0, 0, 0);
  } else if (day === 6 && hour >= config.businessHours.saturday.end) {
    // Saturday after 14h → Monday 8h BRT
    nextStart = new Date(brt);
    nextStart.setUTCDate(nextStart.getUTCDate() + 2);
    nextStart.setUTCHours(config.businessHours.weekday.start, 0, 0, 0);
  } else if (hour >= config.businessHours.weekday.end) {
    // After 20h → next day 8h BRT
    nextStart = new Date(brt);
    nextStart.setUTCDate(nextStart.getUTCDate() + 1);
    const nextDay = (day + 1) % 7;
    if (nextDay === 0) {
      nextStart.setUTCDate(nextStart.getUTCDate() + 1); // Skip Sunday
    }
    nextStart.setUTCHours(config.businessHours.weekday.start, 0, 0, 0);
  } else {
    // Before 8h → today 8h BRT
    nextStart = new Date(brt);
    if (day === 6) {
      nextStart.setUTCHours(config.businessHours.saturday.start, 0, 0, 0);
    } else {
      nextStart.setUTCHours(config.businessHours.weekday.start, 0, 0, 0);
    }
  }

  // Convert back to UTC
  const nextStartUTC = new Date(nextStart.getTime() + 3 * 60 * 60 * 1000);
  return Math.max(0, nextStartUTC.getTime() - now.getTime());
}
