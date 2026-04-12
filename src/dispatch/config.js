const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

export const dispatchConfig = {
  enabled: process.env.DISPATCH_ENABLED === 'true',
  token: process.env.DISPATCH_QUEPASA_TOKEN || '',
  dailyCap: num(process.env.DISPATCH_DAILY_CAP, 30),
  delayMinMs: num(process.env.DISPATCH_DELAY_MIN_MS, 180000),
  delayMaxMs: num(process.env.DISPATCH_DELAY_MAX_MS, 480000),
  windowStartHour: num(process.env.DISPATCH_WINDOW_START, 9),
  windowEndHour: num(process.env.DISPATCH_WINDOW_END, 20),
  timezone: process.env.DISPATCH_TZ || 'America/Sao_Paulo',
  maxLeadAgeDays: num(process.env.DISPATCH_MAX_LEAD_AGE_DAYS, 30),
};

export function isWithinWindow(now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: dispatchConfig.timezone,
      hour: '2-digit',
      hour12: false,
    }).format(now)
  );
  return hour >= dispatchConfig.windowStartHour && hour < dispatchConfig.windowEndHour;
}

export function randomDelayMs() {
  const { delayMinMs, delayMaxMs } = dispatchConfig;
  if (delayMaxMs <= delayMinMs) return delayMinMs;
  return delayMinMs + Math.floor(Math.random() * (delayMaxMs - delayMinMs));
}
