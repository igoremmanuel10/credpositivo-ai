/**
 * payment_routes_patch.js — Patches routes.js to add:
 * 1. Voice call trigger on diagnosis upload (admin uploads PDF → call lead)
 * 2. Voice call trigger on purchase_abandoned (orders pending > 2h)
 */
import { readFileSync, writeFileSync } from 'fs';

const filePath = '/opt/credpositivo-agent/src/payment/routes.js';
let content = readFileSync(filePath, 'utf8');

// 1. Add handleVoiceCallTrigger import if not present
if (!content.includes('handleVoiceCallTrigger')) {
  const oldImport = "import { handleFollowup } from '../conversation/manager.js';";
  const newImport = `import { handleFollowup } from '../conversation/manager.js';
import { handleVoiceCallTrigger } from '../voice/call-handler.js';`;
  content = content.replace(oldImport, newImport);
  console.log('[Patch] Added handleVoiceCallTrigger import to routes.js');
}

// 2. Add voice call trigger after diagnosis_completed in admin upload endpoint
const oldDiagTrigger = `            handleFollowup(diagConv, 'diagnosis_completed', true).catch(err => {
              console.error('[Admin Upload] diagnosis_completed trigger error:', err.message);
            });
            console.log('[Admin Upload] diagnosis_completed triggered for ' + diagPhone);`;

const newDiagTrigger = `            handleFollowup(diagConv, 'diagnosis_completed', true).catch(err => {
              console.error('[Admin Upload] diagnosis_completed trigger error:', err.message);
            });
            console.log('[Admin Upload] diagnosis_completed triggered for ' + diagPhone);

            // Trigger outbound voice call for diagnosis (30min delay)
            setTimeout(() => {
              handleVoiceCallTrigger(diagPhone, 'diagnosis_completed', {
                complex: true,
                issues_count: 5,
                summary: 'Diagnostico de credito finalizado — resultado requer atencao',
              }, 'outbound').catch(err => {
                console.error('[Admin Upload] Voice call trigger error:', err.message);
              });
            }, 30 * 60 * 1000); // 30 min delay
            console.log('[Admin Upload] Voice call scheduled (30min) for ' + diagPhone);`;

if (content.includes(oldDiagTrigger)) {
  content = content.replace(oldDiagTrigger, newDiagTrigger);
  console.log('[Patch] Added voice call trigger to admin upload endpoint');
} else {
  console.error('[Patch] Could not find diagnosis_completed trigger in admin upload!');
}

// 3. Add voice call trigger for purchase_abandoned in Mercado Pago webhook
// When a payment fails or is rejected, trigger purchase_abandoned
const oldMPWebhookEnd = `      // Diagnostico: do NOT auto-process. Wait for client to provide target CPF via /api/process-diagnostico
    }`;

const newMPWebhookEnd = `      // Diagnostico: do NOT auto-process. Wait for client to provide target CPF via /api/process-diagnostico
    }

    // If payment failed/rejected, trigger purchase_abandoned voice call
    if (['rejected', 'cancelled'].includes(mpStatus) && order.customer_phone) {
      const abanPhone = normalizePhone(order.customer_phone);
      if (abanPhone) {
        try {
          const abanConv = await db.getConversation(abanPhone);
          if (abanConv) {
            handleFollowup(abanConv, 'purchase_abandoned').catch(err => {
              console.error('[MP Webhook] purchase_abandoned trigger error:', err.message);
            });
            // Voice call after 30min
            setTimeout(() => {
              handleVoiceCallTrigger(abanPhone, 'purchase_abandoned', {
                produto: order.service || '',
                source: 'mercadopago_rejected',
              }, 'outbound').catch(err => {
                console.error('[MP Webhook] Voice call trigger error:', err.message);
              });
            }, 30 * 60 * 1000);
            console.log('[MP Webhook] purchase_abandoned + voice call scheduled for ' + abanPhone);
          }
        } catch (err) {
          console.error('[MP Webhook] purchase_abandoned trigger error:', err.message);
        }
      }
    }`;

if (content.includes(oldMPWebhookEnd)) {
  content = content.replace(oldMPWebhookEnd, newMPWebhookEnd);
  console.log('[Patch] Added purchase_abandoned trigger for rejected MP payments');
} else {
  console.warn('[Patch] Could not find MP webhook end marker — purchase_abandoned not added');
}

writeFileSync(filePath, content, 'utf8');
console.log('[Patch] payment/routes.js patched successfully!');
