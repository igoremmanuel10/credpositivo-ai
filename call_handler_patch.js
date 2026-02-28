/**
 * call_handler_patch.js — Patches call-handler.js on the server.
 * Adds 'followup_hot_lead' event type to shouldCallForEvent and buildCallOverrides.
 */
import { readFileSync, writeFileSync } from 'fs';

const filePath = '/opt/credpositivo-agent/src/voice/call-handler.js';
let content = readFileSync(filePath, 'utf8');

// 1. Add 'followup_hot_lead' to shouldCallForEvent
const oldShouldCall = `    case 'manual_test':
      // Always allow manual test calls
      return true;

    default:
      return false;`;

const newShouldCall = `    case 'followup_hot_lead':
      // Call for hot leads (phase 3-4) during follow-up sequence
      return eventData.phase >= 3;

    case 'manual_test':
      // Always allow manual test calls
      return true;

    default:
      return false;`;

if (content.includes(oldShouldCall)) {
  content = content.replace(oldShouldCall, newShouldCall);
  console.log('[Patch] Added followup_hot_lead to shouldCallForEvent');
} else {
  console.error('[Patch] Could not find shouldCallForEvent default case!');
  process.exit(1);
}

// 2. Add 'followup_hot_lead' case to buildCallOverrides
const oldBuildOverrides = `    case 'manual_test': {
      overrides.firstMessage = \`Oi! Aqui e o Paulo, a inteligencia artificial do Grupo CredPositivo. Essa e uma chamada de teste. Como posso te ajudar?\`;
      break;
    }`;

const newBuildOverrides = `    case 'followup_hot_lead': {
      const personaName = eventData?.persona === 'paulo' ? 'Paulo' : 'Augusto';
      overrides.firstMessage = \`Oi\${leadName !== 'amigo' ? ', ' + leadName : ''}! Aqui e o \${personaName}, a inteligencia artificial do Grupo CredPositivo. Estou ligando porque a gente conversou antes sobre sua situacao de credito e queria saber se posso te ajudar com alguma duvida.\`;

      overrides.model = {
        messages: [
          {
            role: 'system',
            content: \`CONTEXTO DESTA CHAMADA: Follow-up de lead quente (fase \${eventData?.phase || 3}). O lead \${leadName} ja conversou no WhatsApp e mostrou interesse\${produto ? ' em ' + formatProductName(produto) : ''}. Esta e uma ligacao de follow-up (tentativa \${eventData?.attempt || 1}). Seu objetivo e retomar o contato de forma amigavel, entender o que faltou pra ele decidir, e responder duvidas. NAO pressione. Se nao tiver interesse, agradeca e encerre gentilmente. Se tiver duvidas sobre preco: Diagnostico R$97, Limpa Nome R$397, Rating R$997.\`,
          },
        ],
      };
      break;
    }

    case 'manual_test': {
      overrides.firstMessage = \`Oi! Aqui e o Paulo, a inteligencia artificial do Grupo CredPositivo. Essa e uma chamada de teste. Como posso te ajudar?\`;
      break;
    }`;

if (content.includes(oldBuildOverrides)) {
  content = content.replace(oldBuildOverrides, newBuildOverrides);
  console.log('[Patch] Added followup_hot_lead to buildCallOverrides');
} else {
  console.error('[Patch] Could not find buildCallOverrides manual_test case!');
  process.exit(1);
}

// 3. Update the JSDoc comment at the top to include followup_hot_lead
const oldDocComment = ` * Supported triggers:
 * 1. purchase_abandoned (Rating R$997) -- high-value lead abandoned checkout
 * 2. diagnosis_completed (complex result) -- result too complex for text
 * 3. manual_test -- admin test call (skips business hours)`;

const newDocComment = ` * Supported triggers:
 * 1. purchase_abandoned (Rating R$997) -- high-value lead abandoned checkout
 * 2. diagnosis_completed (complex result) -- result too complex for text
 * 3. followup_hot_lead (phase 3-4) -- follow-up call for hot leads
 * 4. manual_test -- admin test call (skips business hours)`;

if (content.includes(oldDocComment)) {
  content = content.replace(oldDocComment, newDocComment);
  console.log('[Patch] Updated JSDoc triggers');
}

// 4. Also skip rate limit for followup_hot_lead (already controlled by followup scheduler)
const oldRateLimit = `  if (eventType !== 'manual_test') {
    const rateLimitOk = await checkCallRateLimit(phone);`;

const newRateLimit = `  if (eventType !== 'manual_test' && eventType !== 'followup_hot_lead') {
    const rateLimitOk = await checkCallRateLimit(phone);`;

if (content.includes(oldRateLimit)) {
  content = content.replace(oldRateLimit, newRateLimit);
  console.log('[Patch] Excluded followup_hot_lead from rate limit (controlled by scheduler)');
}

writeFileSync(filePath, content, 'utf8');
console.log('[Patch] call-handler.js patched successfully (added followup_hot_lead)!');
