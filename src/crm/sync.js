import { config } from '../config.js';
import { db } from '../db/client.js';
import {
  getLead,
  createLead,
  updateLead,
  createPerson,
  createActivity,
  healthCheck,
} from './krayin-client.js';

// Map agent phases (0-5) to Krayin pipeline stage IDs.
const PHASE_TO_STAGE = {
  0: 1,  // Novo Lead
  1: 1,  // Novo Lead (still greeting)
  2: 2,  // Investigacao
  3: 3,  // Diagnostico
  4: 4,  // Proposta Enviada
  5: 5,  // Ganhou
};

const PRODUCT_VALUES = {
  diagnostico: 67,
  limpa_nome: 600,
  rating: 1200,
};

let krayinAvailable = null;

async function isKrayinReady() {
  if (!config.krayin.enabled || !config.krayin.apiToken) return false;
  if (krayinAvailable !== null) return krayinAvailable;

  krayinAvailable = await healthCheck();
  setTimeout(() => { krayinAvailable = null; }, 60_000);

  if (!krayinAvailable) {
    console.warn('[CRM] Krayin not reachable, sync disabled temporarily');
  }
  return krayinAvailable;
}

/**
 * Sync a lead to Krayin CRM.
 * Creates person + lead if not already synced.
 * Stores krayin_person_id and krayin_lead_id in our DB.
 */
export async function syncLeadToKrayin(conversation, pushName, persona) {
  if (!(await isKrayinReady())) return;

  try {
    const phone = conversation.phone;
    const name = conversation.name || pushName || phone;

    // Already synced?
    if (conversation.krayin_lead_id) {
      return { leadId: conversation.krayin_lead_id, personId: conversation.krayin_person_id };
    }

    // 1. Create person
    const person = await createPerson({
      name,
      contact_numbers: [{ value: phone, label: 'whatsapp' }],
    });
    const personId = person.id;
    console.log(`[CRM] Created person ${personId} for ${phone}`);

    // 2. Create lead
    const stageId = PHASE_TO_STAGE[conversation.phase] || 1;
    const lead = await createLead({
      title: `${name} — WhatsApp`,
      description: `Lead via WhatsApp (${persona})`,
      lead_pipeline_id: parseInt(config.krayin.pipelineId),
      lead_pipeline_stage_id: stageId,
      person: { id: personId },
      lead_value: PRODUCT_VALUES[conversation.recommended_product] || 0,
      status: 1,
      lead_source_id: 1,
      lead_type_id: 1,
    });
    const leadId = lead.id;
    console.log(`[CRM] Created lead ${leadId} for ${phone} (stage ${stageId})`);

    // 3. Store IDs in our DB
    await db.query(
      'UPDATE conversations SET krayin_person_id = $1, krayin_lead_id = $2 WHERE phone = $3',
      [personId, leadId, phone]
    );

    return { leadId, personId };
  } catch (err) {
    console.error('[CRM] syncLeadToKrayin error:', err.message);
  }
}

/**
 * Update lead stage in Krayin when conversation phase changes.
 */
export async function syncPhaseChange(phone, newPhase, extraData = {}) {
  if (!(await isKrayinReady())) return;

  try {
    // Get Krayin lead ID from our DB
    const { rows } = await db.query(
      'SELECT krayin_lead_id, krayin_person_id FROM conversations WHERE phone = $1',
      [phone]
    );
    const leadId = rows[0]?.krayin_lead_id;
    const personId = rows[0]?.krayin_person_id;
    if (!leadId) return;

    const stageId = PHASE_TO_STAGE[newPhase] || 1;
    const updates = {
      lead_pipeline_stage_id: stageId,
      person: { id: personId },
    };

    if (extraData.recommended_product) {
      updates.lead_value = PRODUCT_VALUES[extraData.recommended_product] || 0;
    }

    await updateLead(leadId, updates);
    console.log(`[CRM] Lead ${leadId} → stage ${stageId} (phase ${newPhase})`);

    // Log activity (non-critical)
    createActivity({
      title: `Fase ${newPhase}: ${phaseLabel(newPhase)}`,
      type: 'note',
      lead_id: leadId,
      description: extraData.recommended_product
        ? `Produto recomendado: ${extraData.recommended_product}`
        : `Lead avancou para fase ${newPhase}`,
    }).catch(() => {});

  } catch (err) {
    console.error('[CRM] syncPhaseChange error:', err.message);
  }
}

/**
 * Mark a lead as won in Krayin (purchase completed).
 */
export async function syncDealWon(phone, product, amount) {
  if (!(await isKrayinReady())) return;

  try {
    const { rows } = await db.query(
      'SELECT krayin_lead_id, krayin_person_id FROM conversations WHERE phone = $1',
      [phone]
    );
    const leadId = rows[0]?.krayin_lead_id;
    const personId = rows[0]?.krayin_person_id;
    if (!leadId) return;

    const value = amount || PRODUCT_VALUES[product] || 0;
    await updateLead(leadId, {
      lead_pipeline_stage_id: 5, // Ganhou
      lead_value: value,
      status: 1,
      person: { id: personId },
    });

    createActivity({
      title: `Venda: ${product} — R$ ${value}`,
      type: 'note',
      lead_id: leadId,
      description: `Compra concluida: ${product}`,
    }).catch(() => {});

    console.log(`[CRM] Lead ${leadId} WON: ${product} R$ ${value}`);
  } catch (err) {
    console.error('[CRM] syncDealWon error:', err.message);
  }
}

/**
 * Mark a lead as lost in Krayin.
 */
export async function syncDealLost(phone, reason = 'opt_out') {
  if (!(await isKrayinReady())) return;

  try {
    const { rows } = await db.query(
      'SELECT krayin_lead_id, krayin_person_id FROM conversations WHERE phone = $1',
      [phone]
    );
    const leadId = rows[0]?.krayin_lead_id;
    const personId = rows[0]?.krayin_person_id;
    if (!leadId) return;

    await updateLead(leadId, {
      lead_pipeline_stage_id: 6, // Perdeu
      status: 0,
      person: { id: personId },
    });

    createActivity({
      title: `Lead perdido: ${reason}`,
      type: 'note',
      lead_id: leadId,
      description: `Motivo: ${reason}`,
    }).catch(() => {});

    console.log(`[CRM] Lead ${leadId} LOST: ${reason}`);
  } catch (err) {
    console.error('[CRM] syncDealLost error:', err.message);
  }
}

function phaseLabel(phase) {
  const labels = {
    0: 'Novo Lead',
    1: 'Apresentacao',
    2: 'Investigacao',
    3: 'Diagnostico',
    4: 'Proposta Enviada',
    5: 'Pos-compra',
  };
  return labels[phase] || `Fase ${phase}`;
}
