import { config } from '../config.js';

const headers = () => ({
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Authorization': `Bearer ${config.krayin.apiToken}`,
});

async function krayinFetch(path, options = {}) {
  const url = `${config.krayin.apiUrl}/api/v1${path}`;
  const res = await fetch(url, {
    headers: headers(),
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Krayin ${options.method || 'GET'} ${path} → ${res.status}: ${body.substring(0, 300)}`);
  }
  return res.json();
}

// ── LEADS ────────────────────────────────────────────────────────────

export async function getLead(leadId) {
  const res = await krayinFetch(`/leads/${leadId}`);
  return res.data || res;
}

export async function createLead(leadData) {
  const res = await krayinFetch('/leads', {
    method: 'POST',
    body: JSON.stringify(leadData),
  });
  return res.data || res;
}

export async function updateLead(leadId, updates) {
  const res = await krayinFetch(`/leads/${leadId}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
  return res.data || res;
}

// ── CONTACTS (Persons) ──────────────────────────────────────────────

export async function getPerson(personId) {
  const res = await krayinFetch(`/contacts/persons/${personId}`);
  return res.data || res;
}

export async function createPerson(personData) {
  const res = await krayinFetch('/contacts/persons', {
    method: 'POST',
    body: JSON.stringify(personData),
  });
  return res.data || res;
}

export async function updatePerson(personId, updates) {
  const res = await krayinFetch(`/contacts/persons/${personId}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
  return res.data || res;
}

// ── ACTIVITIES ──────────────────────────────────────────────────────

export async function createActivity(activityData) {
  const res = await krayinFetch('/activities', {
    method: 'POST',
    body: JSON.stringify(activityData),
  });
  return res.data || res;
}

// ── HEALTH CHECK ────────────────────────────────────────────────────

export async function healthCheck() {
  try {
    const res = await krayinFetch('/leads?limit=1');
    return true;
  } catch {
    return false;
  }
}
