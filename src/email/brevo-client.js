/**
 * Brevo (Sendinblue) API v3 Client
 * Handles all email sending and contact management via Brevo.
 */

const BREVO_KEY = process.env.BREVO_API_KEY || "";
const BREVO_BASE = "https://api.brevo.com/v3";
const SENDER = {
  name: process.env.BREVO_SENDER_NAME || "CredPositivo",
  email: process.env.BREVO_SENDER_EMAIL || "sac@credpositivo.com",
};

async function brevoRequest(method, path, body) {
  const url = `${BREVO_BASE}${path}`;
  const options = {
    method,
    headers: {
      "api-key": BREVO_KEY,
      "content-type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const res = await fetch(url, options);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }

    if (!res.ok) {
      console.error(`[brevo] ${method} ${path} => ${res.status}:`, data);
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error(`[brevo] ${method} ${path} network error:`, err.message);
    return { ok: false, status: 0, data: { error: err.message } };
  }
}

/**
 * Send a transactional email using a Brevo template.
 * @param {number} templateId - Brevo template ID
 * @param {string} toEmail - Recipient email
 * @param {string} toName - Recipient name
 * @param {object} params - Template variables (FIRSTNAME, etc.)
 */
export async function sendTemplate(templateId, toEmail, toName, params = {}) {
  if (!BREVO_KEY) {
    console.warn("[brevo] BREVO_API_KEY not configured, skipping email");
    return { ok: false, status: 0, data: { error: "No API key" } };
  }
  if (!toEmail) {
    console.warn("[brevo] No email provided, skipping");
    return { ok: false, status: 0, data: { error: "No email" } };
  }

  console.log(`[brevo] Sending template ${templateId} to ${toEmail}`);
  return brevoRequest("POST", "/smtp/email", {
    sender: SENDER,
    to: [{ email: toEmail, name: toName || "" }],
    templateId,
    params,
  });
}

/**
 * Create or update a contact in Brevo.
 * @param {string} email
 * @param {object} attributes - FIRSTNAME, LASTNAME, etc.
 * @param {number[]} listIds - Brevo list IDs to add contact to
 */
export async function upsertContact(email, attributes = {}, listIds = []) {
  if (!BREVO_KEY || !email) return { ok: false };

  const body = { email, attributes, updateEnabled: true };
  if (listIds.length > 0) body.listIds = listIds;

  return brevoRequest("POST", "/contacts", body);
}

/**
 * Send a raw transactional email (no template).
 * @param {string} toEmail
 * @param {string} toName
 * @param {string} subject
 * @param {string} htmlContent
 */
export async function sendRawEmail(toEmail, toName, subject, htmlContent) {
  if (!BREVO_KEY || !toEmail) return { ok: false };

  return brevoRequest("POST", "/smtp/email", {
    sender: SENDER,
    to: [{ email: toEmail, name: toName || "" }],
    subject,
    htmlContent,
  });
}

export { SENDER, BREVO_KEY };
