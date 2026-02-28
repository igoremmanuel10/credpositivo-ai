/**
 * event-detector.js — Proactive Event Detector
 *
 * Runs every 30 minutes during business hours.
 * Detects events from conversation + orders data, triggering
 * Vapi outbound calls and WhatsApp follow-ups automatically.
 *
 * Detected events:
 *   1. purchase_abandoned (conversation) — Phase 4, link sent 2-8h ago, no response
 *   2. purchase_abandoned (orders)       — Pending order > 2h, no payment
 *
 * Both trigger outbound Vapi calls for hot leads.
 */

import cron from 'node-cron';
import { db } from '../db/client.js';
import { isBusinessHours } from '../config.js';
import { handleVoiceCallTrigger } from '../voice/call-handler.js';
import { handleFollowup } from './manager.js';
import { cache } from '../db/redis.js';

const DETECTION_INTERVAL_MINUTES = 30;

// Max calls triggered per cycle (prevent flooding)
const MAX_CALLS_PER_CYCLE = 3;

// Delay between each call (seconds)
const DELAY_BETWEEN_CALLS_SEC = 60;

/**
 * Start the event detector scheduler.
 */
export function startEventDetector() {
  cron.schedule(`*/${DETECTION_INTERVAL_MINUTES} * * * *`, async () => {
    if (!isBusinessHours()) return;

    try {
      await detectAbandonedOrders();
      await detectAbandonedConversations();
    } catch (err) {
      console.error('[EventDetector] Error:', err.message);
    }
  });

  console.log(`[EventDetector] ATIVADO (every ${DETECTION_INTERVAL_MINUTES} min, business hours)`);
  console.log(`[EventDetector] Detecta: abandoned orders (2-24h) + abandoned conversations (phase 4)`);
}

/**
 * Detect abandoned orders from the orders table.
 * More precise than conversation-based detection because it knows
 * the person actually started checkout.
 *
 * Pattern: order status='pending', created 2-24h ago, has phone number
 */
async function detectAbandonedOrders() {
  try {
    const { rows: abandonedOrders } = await db.query(`
      SELECT o.id, o.cpf, o.customer_name, o.customer_phone, o.service, o.price,
             o.created_at, o.status
      FROM orders o
      WHERE o.status = 'pending'
        AND o.created_at < NOW() - INTERVAL '2 hours'
        AND o.created_at > NOW() - INTERVAL '24 hours'
        AND o.customer_phone IS NOT NULL
        AND o.customer_phone != ''
        AND NOT EXISTS (
          SELECT 1 FROM voice_calls vc
          WHERE vc.phone = REGEXP_REPLACE(o.customer_phone, '[^0-9]', '', 'g')
            AND vc.event_type = 'purchase_abandoned'
            AND vc.created_at > NOW() - INTERVAL '48 hours'
        )
      ORDER BY o.price DESC
      LIMIT 10
    `);

    if (abandonedOrders.length === 0) return;

    console.log(`[EventDetector] Found ${abandonedOrders.length} abandoned order(s)`);

    let callsMade = 0;

    for (const order of abandonedOrders) {
      if (callsMade >= MAX_CALLS_PER_CYCLE) break;

      const phone = order.customer_phone.replace(/\D/g, '');
      if (!phone || phone.length < 10) continue;

      // Check Redis to avoid duplicate
      const detectedKey = `event_detected:order_abandoned:${phone}`;
      const alreadyDetected = await cache.client.get(detectedKey);
      if (alreadyDetected) continue;

      await cache.client.set(detectedKey, '1', 'EX', 48 * 3600);

      const hoursAgo = ((Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60)).toFixed(1);

      console.log(`[EventDetector] Abandoned order #${order.id}: ${order.customer_name || '?'} (${phone}), ${order.service} R$${order.price}, ${hoursAgo}h ago`);

      // Send WhatsApp follow-up first
      try {
        const conv = await db.getConversation(phone);
        if (conv && !conv.opted_out) {
          handleFollowup(conv, 'purchase_abandoned').catch(err => {
            console.error(`[EventDetector] WhatsApp followup error for ${phone}:`, err.message);
          });
        }
      } catch (err) {
        console.error(`[EventDetector] Conversation lookup error for ${phone}:`, err.message);
      }

      // Schedule voice call (30min after WhatsApp message)
      const delay = (callsMade * DELAY_BETWEEN_CALLS_SEC * 1000) + (30 * 60 * 1000);

      setTimeout(async () => {
        try {
          const result = await handleVoiceCallTrigger(
            phone,
            'purchase_abandoned',
            { produto: order.service || '', source: 'order_detector', orderId: order.id },
            'outbound'
          );
          if (result) {
            console.log(`[EventDetector] Call initiated for order #${order.id} (${phone}): ${JSON.stringify(result)}`);
          }
        } catch (err) {
          console.error(`[EventDetector] Call failed for order #${order.id}:`, err.message);
        }
      }, delay);

      callsMade++;
    }

    if (callsMade > 0) {
      console.log(`[EventDetector] Triggered ${callsMade} abandoned order follow-up(s) + call(s)`);
    }
  } catch (err) {
    console.error('[EventDetector] detectAbandonedOrders error:', err.message);
  }
}

/**
 * Detect abandoned conversations (phase 4, link sent, no response).
 * Fallback for leads who received a link via WhatsApp but never
 * reached the checkout page (no order created).
 */
async function detectAbandonedConversations() {
  try {
    const { rows: candidates } = await db.query(`
      SELECT c.id, c.phone, c.name, c.remote_jid, c.phase, c.persona,
             c.recommended_product, c.link_counter, c.last_message_at
      FROM conversations c
      WHERE c.phase = 4
        AND c.link_counter > 0
        AND c.opted_out = false
        AND c.last_message_at < NOW() - INTERVAL '2 hours'
        AND c.last_message_at > NOW() - INTERVAL '8 hours'
        AND c.product_sold IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM orders o
          WHERE REGEXP_REPLACE(o.customer_phone, '[^0-9]', '', 'g') = c.phone
            AND o.created_at > NOW() - INTERVAL '24 hours'
        )
        AND NOT EXISTS (
          SELECT 1 FROM voice_calls vc
          WHERE vc.phone = c.phone
            AND vc.event_type = 'purchase_abandoned'
            AND vc.created_at > NOW() - INTERVAL '48 hours'
        )
      ORDER BY c.last_message_at DESC
      LIMIT 5
    `);

    if (candidates.length === 0) return;

    let callsMade = 0;

    for (const conv of candidates) {
      if (callsMade >= MAX_CALLS_PER_CYCLE) break;

      // Verify last message is from agent
      const { rows: messages } = await db.query(`
        SELECT role FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [conv.id]);

      if (messages.length === 0 || messages[0].role !== 'agent') continue;

      const detectedKey = `event_detected:conv_abandoned:${conv.phone}`;
      const alreadyDetected = await cache.client.get(detectedKey);
      if (alreadyDetected) continue;

      await cache.client.set(detectedKey, '1', 'EX', 48 * 3600);

      const hoursAgo = ((Date.now() - new Date(conv.last_message_at).getTime()) / (1000 * 60 * 60)).toFixed(1);
      console.log(`[EventDetector] Abandoned conversation: ${conv.phone} (${conv.name || '?'}, ${conv.recommended_product || '?'}, ${hoursAgo}h ago, no order created)`);

      const delay = callsMade * DELAY_BETWEEN_CALLS_SEC * 1000;

      setTimeout(async () => {
        try {
          const result = await handleVoiceCallTrigger(
            conv.phone,
            'purchase_abandoned',
            { produto: conv.recommended_product || '', source: 'conversation_detector' },
            'outbound'
          );
          if (result) {
            console.log(`[EventDetector] Call initiated for ${conv.phone}: ${JSON.stringify(result)}`);
          }
        } catch (err) {
          console.error(`[EventDetector] Call failed for ${conv.phone}:`, err.message);
        }
      }, delay);

      callsMade++;
    }

    if (callsMade > 0) {
      console.log(`[EventDetector] Triggered ${callsMade} conversation-abandoned call(s)`);
    }
  } catch (err) {
    console.error('[EventDetector] detectAbandonedConversations error:', err.message);
  }
}
