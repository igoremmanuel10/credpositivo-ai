/**
 * Normalize phone number to consistent format.
 * Always ensures Brazilian country code (55) prefix.
 * We store just the number: 5571999999999
 */
export function normalizePhone(jid) {
  if (!jid) return null;
  // Remove @s.whatsapp.net suffix and non-digits
  let clean = jid.replace(/@s\.whatsapp\.net$/, '').replace(/\D/g, '');

  if (!clean) return null;

  // Add Brazilian country code if missing
  // Brazilian phones: 10-11 digits without country code (DDD + number)
  // With country code: 12-13 digits (55 + DDD + number)
  if (clean.length === 10 || clean.length === 11) {
    clean = '55' + clean;
  }

  return clean;
}

/**
 * Convert stored phone to WhatsApp JID format.
 */
export function toJid(phone) {
  const clean = normalizePhone(phone);
  return clean ? `${clean}@s.whatsapp.net` : null;
}
