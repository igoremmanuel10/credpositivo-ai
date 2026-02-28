import { handleVoiceCallTrigger } from "../voice/call-handler.js";
import { Router } from 'express';
import { db } from '../db/client.js';
import { cache } from '../db/redis.js';
import { triggerSdrOutreach } from '../sdr/outreach.js';
import { handleFollowup } from '../conversation/manager.js';
import { normalizePhone } from '../utils/phone.js';
import { config } from '../config.js';
import { syncDealWon } from '../crm/sync.js';

export const webhooksRouter = Router();

// Webhook authentication middleware for /api/events/* endpoints
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

function authenticateWebhook(req, res, next) {
  // Skip auth if no secret is configured (backwards compatible)
  if (!WEBHOOK_SECRET) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);
  if (token !== WEBHOOK_SECRET) {
    console.warn(`[Webhook] Unauthorized request to ${req.path} from ${req.ip}`);
    return res.status(403).json({ error: 'Invalid webhook token' });
  }

  next();
}

// Apply auth to all /api/events/* routes
webhooksRouter.use('/api/events', authenticateWebhook);

// NOTE: POST /api/register is in api/users.js — SDR trigger is hooked there.

/**
 * POST /api/sdr/outreach — Trigger SDR outreach manually.
 * Used for batch outreach to existing users.
 *
 * Body: { telefone, nome?, email? }
 */
webhooksRouter.post('/api/sdr/outreach', async (req, res) => {
  const { telefone, nome, email } = req.body;

  if (!telefone) {
    return res.status(400).json({ error: 'Telefone obrigatório' });
  }

  console.log(`[SDR API] Manual outreach: ${nome || '?'} / ${telefone}`);

  res.json({ status: 'ok', event: 'sdr_outreach', telefone });

  triggerSdrOutreach(telefone, nome, email).catch(err => {
    console.error('[SDR API] Outreach error:', err.message);
  });
});

/**
 * POST /api/events/signup-completed — Lead criou conta mas não comprou.
 * Dispara follow-up do agente correto (Augusto ou Paulo).
 *
 * Body: { telefone, nome?, email? }
 */
webhooksRouter.post('/api/events/signup-completed', async (req, res) => {
  const { telefone } = req.body;

  if (!telefone) {
    return res.status(400).json({ error: 'Telefone obrigatório' });
  }

  const phone = normalizePhone(telefone);
  console.log(`[Webhook] signup_completed for ${phone}`);

  res.json({ status: 'ok', event: 'signup_completed' });

  try {
    const conversation = await db.getConversation(phone);
    if (conversation) {
      await handleFollowup(conversation, 'signup_completed');
    } else {
      console.log(`[Webhook] No conversation found for ${phone}, skipping signup_completed`);
    }
  } catch (err) {
    console.error(`[Webhook] signup_completed error for ${phone}:`, err);
  }
});

/**
 * POST /api/events/purchase-completed — Lead comprou um produto.
 * Dispara áudio de confirmação + mensagem de parabéns.
 *
 * Body: { telefone, produto?, valor? }
 */
webhooksRouter.post('/api/events/purchase-completed', async (req, res) => {
  const { telefone, produto } = req.body;

  if (!telefone) {
    return res.status(400).json({ error: 'Telefone obrigatório' });
  }

  const phone = normalizePhone(telefone);
  console.log(`[Webhook] purchase_completed for ${phone} (produto: ${produto || '?'})`);

  res.json({ status: 'ok', event: 'purchase_completed' });

  try {
    const conversation = await db.getConversation(phone);
    if (conversation) {
      if (produto) {
        await db.updateConversation(conversation.id, { recommended_product: produto });
        conversation.recommended_product = produto;
      }
      // Audio confirmation for purchases (Section 7: Confirmação de compra = AUDIO)
      await handleFollowup(conversation, 'purchase_completed', true);
      // CRM: Mark deal as won
      const valor = req.body.valor || null;
      syncDealWon(phone, produto || conversation.recommended_product, valor).catch(err => {
        console.error('[CRM] syncDealWon error:', err.message);
      });
    } else {
      console.log(`[Webhook] No conversation found for ${phone}, skipping purchase_completed`);
    }
  } catch (err) {
    console.error(`[Webhook] purchase_completed error for ${phone}:`, err);
  }
});

/**
 * POST /api/events/purchase-abandoned — Lead iniciou checkout mas não finalizou.
 * Dispara follow-up gentil perguntando se teve dificuldade.
 *
 * Body: { telefone, produto? }
 */
webhooksRouter.post('/api/events/purchase-abandoned', async (req, res) => {
  const { telefone } = req.body;

  if (!telefone) {
    return res.status(400).json({ error: 'Telefone obrigatório' });
  }

  const phone = normalizePhone(telefone);
  console.log(`[Webhook] purchase_abandoned for ${phone}`);

  res.json({ status: 'ok', event: 'purchase_abandoned' });

  try {
    const conversation = await db.getConversation(phone);
    if (conversation) {
      await handleFollowup(conversation, 'purchase_abandoned');
      // Trigger voice call after delay for high-value leads
      const produto = req.body.produto || conversation.recommended_product || '';
      setTimeout(() => {
        handleVoiceCallTrigger(phone, 'purchase_abandoned', { produto }).catch(err => {
          console.error(`[Webhook] Voice call trigger error for ${phone}:`, err.message);
        });
      }, (config.vapi?.callDelayMinutes || 30) * 60 * 1000);
    } else {
      console.log(`[Webhook] No conversation found for ${phone}, skipping purchase_abandoned`);
    }
  } catch (err) {
    console.error(`[Webhook] purchase_abandoned error for ${phone}:`, err);
  }
});

/**
 * POST /api/events/link-sent-no-action — Link enviado mas lead não acessou (24h+).
 *
 * Body: { telefone }
 */
webhooksRouter.post('/api/events/link-sent-no-action', async (req, res) => {
  const { telefone } = req.body;

  if (!telefone) {
    return res.status(400).json({ error: 'Telefone obrigatório' });
  }

  const phone = normalizePhone(telefone);
  console.log(`[Webhook] link_sent_no_action for ${phone}`);

  res.json({ status: 'ok', event: 'link_sent_no_action' });

  try {
    const conversation = await db.getConversation(phone);
    if (conversation) {
      await handleFollowup(conversation, 'link_sent_no_action');
    } else {
      console.log(`[Webhook] No conversation found for ${phone}, skipping link_sent_no_action`);
    }
  } catch (err) {
    console.error(`[Webhook] link_sent_no_action error for ${phone}:`, err);
  }
});

/**
 * POST /api/events/diagnosis-completed — Diagnóstico pronto (instantâneo).
 * Dispara áudio + texto com resultado.
 *
 * Body: { telefone, resultado? }
 */
webhooksRouter.post('/api/events/diagnosis-completed', async (req, res) => {
  const { telefone, resultado } = req.body;

  if (!telefone) {
    return res.status(400).json({ error: 'Telefone obrigatório' });
  }

  const phone = normalizePhone(telefone);
  console.log(`[Webhook] diagnosis_completed for ${phone}`);

  res.json({ status: 'ok', event: 'diagnosis_completed' });

  try {
    const conversation = await db.getConversation(phone);
    if (conversation) {
      // Audio + text (Section 7: Resultado diagnóstico = AUDIO + TEXTO)
      await handleFollowup(conversation, 'diagnosis_completed', true);
      // Trigger voice call for complex diagnoses
      const resultado = req.body.resultado || '';
      const issuesCount = req.body.issues_count || 0;
      if (issuesCount > 3 || req.body.complex) {
        setTimeout(() => {
          handleVoiceCallTrigger(phone, 'diagnosis_completed', { complex: true, issues_count: issuesCount, summary: resultado }).catch(err => {
            console.error(`[Webhook] Voice call trigger error for ${phone}:`, err.message);
          });
        }, (config.vapi?.callDelayMinutes || 30) * 60 * 1000);
      }
    } else {
      console.log(`[Webhook] No conversation found for ${phone}, skipping diagnosis_completed`);
    }
  } catch (err) {
    console.error(`[Webhook] diagnosis_completed error for ${phone}:`, err);
  }
});

/**
 * POST /api/events/limpa-completed — Limpa Nome concluído (até 15 dias úteis).
 * Dispara áudio de celebração + upsell Rating.
 *
 * Body: { telefone }
 */
webhooksRouter.post('/api/events/limpa-completed', async (req, res) => {
  const { telefone } = req.body;

  if (!telefone) {
    return res.status(400).json({ error: 'Telefone obrigatório' });
  }

  const phone = normalizePhone(telefone);
  console.log(`[Webhook] limpa_completed for ${phone}`);

  res.json({ status: 'ok', event: 'limpa_completed' });

  try {
    const conversation = await db.getConversation(phone);
    if (conversation) {
      // Audio celebration (Section 7: Conclusão de serviço = AUDIO)
      await handleFollowup(conversation, 'limpa_completed', true);
    } else {
      console.log(`[Webhook] No conversation found for ${phone}, skipping limpa_completed`);
    }
  } catch (err) {
    console.error(`[Webhook] limpa_completed error for ${phone}:`, err);
  }
});

/**
 * POST /api/events/rating-progress — Atualização de progresso do Rating.
 * Dispara texto com etapa concluída.
 *
 * Body: { telefone, etapa, descricao? }
 */
webhooksRouter.post('/api/events/rating-progress', async (req, res) => {
  const { telefone, etapa } = req.body;

  if (!telefone) {
    return res.status(400).json({ error: 'Telefone obrigatório' });
  }

  const phone = normalizePhone(telefone);
  console.log(`[Webhook] rating_progress for ${phone} (etapa: ${etapa || '?'})`);

  res.json({ status: 'ok', event: 'rating_progress' });

  try {
    const conversation = await db.getConversation(phone);
    if (conversation) {
      // Text only (Section 7: Progresso = TEXTO)
      await handleFollowup(conversation, 'rating_progress');
    } else {
      console.log(`[Webhook] No conversation found for ${phone}, skipping rating_progress`);
    }
  } catch (err) {
    console.error(`[Webhook] rating_progress error for ${phone}:`, err);
  }
});

/**
 * POST /api/events/rating-completed — Rating concluído (até 20 dias úteis).
 * Dispara áudio de celebração.
 *
 * Body: { telefone }
 */
webhooksRouter.post('/api/events/rating-completed', async (req, res) => {
  const { telefone } = req.body;

  if (!telefone) {
    return res.status(400).json({ error: 'Telefone obrigatório' });
  }

  const phone = normalizePhone(telefone);
  console.log(`[Webhook] rating_completed for ${phone}`);

  res.json({ status: 'ok', event: 'rating_completed' });

  try {
    const conversation = await db.getConversation(phone);
    if (conversation) {
      await handleFollowup(conversation, 'rating_completed', true);
    } else {
      console.log(`[Webhook] No conversation found for ${phone}, skipping rating_completed`);
    }
  } catch (err) {
    console.error(`[Webhook] rating_completed error for ${phone}:`, err);
  }
});

/**
 * POST /api/events/affiliate-invite — Convite para programa de afiliados.
 * Disparado 7 dias após conclusão do último serviço.
 *
 * Body: { telefone }
 */
webhooksRouter.post('/api/events/affiliate-invite', async (req, res) => {
  const { telefone } = req.body;

  if (!telefone) {
    return res.status(400).json({ error: 'Telefone obrigatório' });
  }

  const phone = normalizePhone(telefone);
  console.log(`[Webhook] affiliate_invite for ${phone}`);

  res.json({ status: 'ok', event: 'affiliate_invite' });

  try {
    const conversation = await db.getConversation(phone);
    if (conversation) {
      // Audio (Section 7: Convite afiliados = AUDIO)
      await handleFollowup(conversation, 'affiliate_invite', true);
    } else {
      console.log(`[Webhook] No conversation found for ${phone}, skipping affiliate_invite`);
    }
  } catch (err) {
    console.error(`[Webhook] affiliate_invite error for ${phone}:`, err);
  }
});

/**
 * GET /api/events — Lista de eventos disponíveis (para documentação).
 */
webhooksRouter.get('/api/events', (req, res) => {
  res.json({
    events: [
      {
        endpoint: 'POST /api/register',
        description: 'Novo cadastro no site. Dispara outreach do Paulo (SDR).',
        body: { nome: 'string', email: 'string (obrigatório)', telefone: 'string (opcional, dispara SDR)' },
      },
      {
        endpoint: 'POST /api/events/signup-completed',
        description: 'Lead criou conta mas não comprou. Dispara follow-up.',
        body: { telefone: 'string (obrigatório)' },
      },
      {
        endpoint: 'POST /api/events/purchase-completed',
        description: 'Lead finalizou compra. Dispara áudio de confirmação.',
        body: { telefone: 'string (obrigatório)', produto: 'string (opcional)', valor: 'number (opcional)' },
      },
      {
        endpoint: 'POST /api/events/purchase-abandoned',
        description: 'Lead abandonou checkout. Dispara follow-up gentil.',
        body: { telefone: 'string (obrigatório)' },
      },
      {
        endpoint: 'POST /api/events/link-sent-no-action',
        description: 'Link enviado há 24h+ sem ação. Dispara lembrete.',
        body: { telefone: 'string (obrigatório)' },
      },
      {
        endpoint: 'POST /api/events/diagnosis-completed',
        description: 'Diagnóstico pronto (instantâneo). Dispara áudio + texto com resultado.',
        body: { telefone: 'string (obrigatório)', resultado: 'string (opcional)' },
      },
      {
        endpoint: 'POST /api/events/limpa-completed',
        description: 'Limpa Nome concluído. Dispara áudio de celebração + upsell Rating.',
        body: { telefone: 'string (obrigatório)' },
      },
      {
        endpoint: 'POST /api/events/rating-progress',
        description: 'Atualização de progresso do Rating. Dispara texto.',
        body: { telefone: 'string (obrigatório)', etapa: 'string (opcional)' },
      },
      {
        endpoint: 'POST /api/events/rating-completed',
        description: 'Rating concluído. Dispara áudio de celebração.',
        body: { telefone: 'string (obrigatório)' },
      },
      {
        endpoint: 'POST /api/events/affiliate-invite',
        description: 'Convite programa de afiliados (7 dias pós-serviço). Áudio.',
        body: { telefone: 'string (obrigatório)' },
      },
    ],
    sdr: {
      enabled: config.sdr.enabled,
      persona: 'paulo',
      phone: config.sdr.botPhone,
    },
    tts: {
      enabled: config.tts.enabled,
      voice: config.tts.voice,
      model: config.tts.model,
    },
  });
});
