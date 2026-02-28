/**
 * Test script: trigger all 5 follow-up attempts for a conversation.
 * Run inside Docker: node src/test-followups.js
 */

import { db } from './db/client.js';
import { cache } from './db/redis.js';
import { sendMessages } from './quepasa/client.js';
import { sendMediaBase64 } from './quepasa/client.js';
import { getFollowupAudio, getProvaSocial } from './media/assets.js';
import { getAgentResponse } from './ai/claude.js';
import { config } from './config.js';

const CONV_ID = 3110;
const PHONE = '5511932145806';
const REMOTE_JID = '212287801561248@lid';
const PERSONA = 'augusto';
const BOT_TOKEN = null;

const PROVA_SOCIAL_CAPTIONS = [
  'Olha o resultado de um cliente nosso',
  'Esse aqui conseguiu destravar o cr\u00e9dito em 60 dias',
  'Mais um cliente que saiu da nega\u00e7\u00e3o',
  'Resultado real de quem fez o diagn\u00f3stico',
  'Isso aqui \u00e9 o que acontece quando voc\u00ea entende o que os bancos veem',
];

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function sendFollowup(attempt, conv) {
  const isHotLead = conv.phase >= 3;
  const name = conv.name || 'Igor';
  const produto = conv.user_profile?.produto || 'cr\u00e9dito';
  const banco = conv.user_profile?.tentou_banco || '';
  const bancoRef = banco ? ` no ${banco}` : '';
  const siteUrl = config.site.url;

  console.log(`\n=== FOLLOW-UP ${attempt}/5 ===`);

  // Determine format
  let format;
  switch (attempt) {
    case 1: format = 'pre_recorded_audio'; break;
    case 2: format = 'text'; break;
    case 3: format = isHotLead ? 'vapi_outbound_call' : 'social_proof_media'; break;
    case 4: format = isHotLead ? 'social_proof_media' : 'text_urgency'; break;
    case 5: format = 'text_close'; break;
  }

  console.log(`Format: ${format} | Phase: ${conv.phase} | Hot lead: ${isHotLead}`);

  // ── FU1: AUDIO + TEXT ──
  if (format === 'pre_recorded_audio') {
    try {
      const audioData = getFollowupAudio(PERSONA);
      if (audioData) {
        await sendMediaBase64(REMOTE_JID, audioData.base64, '', audioData.fileName, BOT_TOKEN);
        await db.addMessage(CONV_ID, 'agent', `[Audio follow-up - ${PERSONA}]`, conv.phase);
        console.log(`[FU1] Audio sent: ${audioData.fileName}`);
        // Send complementary text after audio
        await sleep(3000);
        const fuText = `Mandei esse \u00e1udio pra te explicar melhor. Sobre a nega\u00e7\u00e3o${bancoRef} \u2014 o diagn\u00f3stico mostra exatamente o que t\u00e1 travando seu ${produto}. D\u00e1 uma olhada: ${siteUrl}`;
        await sendMessages(REMOTE_JID, fuText, BOT_TOKEN);
        await db.addMessage(CONV_ID, 'agent', fuText, conv.phase);
        console.log(`[FU1] Text sent after audio`);
      }
    } catch (err) {
      console.error(`[FU1] Failed:`, err.message);
    }
    return;
  }

  // ── FU3: VAPI → skip, send prova social instead ──
  if (format === 'vapi_outbound_call') {
    console.log(`[FU${attempt}] VAPI call SKIPPED (test mode). Sending prova social instead.`);
    format = 'social_proof_media';
  }

  // ── PROVA SOCIAL + CONTEXTUAL TEXT ──
  if (format === 'social_proof_media') {
    try {
      const provaSocial = getProvaSocial(PERSONA, CONV_ID + attempt);
      if (provaSocial) {
        const caption = PROVA_SOCIAL_CAPTIONS[(CONV_ID + attempt) % PROVA_SOCIAL_CAPTIONS.length];
        await sendMediaBase64(REMOTE_JID, provaSocial.base64, caption, provaSocial.fileName, BOT_TOKEN);
        await db.addMessage(CONV_ID, 'agent', `[Prova social - ${provaSocial.fileName}] ${caption}`, conv.phase);
        console.log(`[FU${attempt}] Prova social sent: ${provaSocial.fileName}`);
        // Send contextual text after media
        await sleep(3000);
        const socialTexts = [
          `${name}, esse cliente tava na mesma situa\u00e7\u00e3o que voc\u00ea. Fez o diagn\u00f3stico e em 2 meses conseguiu destravar. Se quiser ver como funciona: ${siteUrl}`,
          `${name}, resultados assim s\u00e3o comuns pra quem entende o que os bancos realmente veem. Quer fazer o seu? ${siteUrl}`,
        ];
        const socialText = socialTexts[(CONV_ID + attempt) % socialTexts.length];
        await sendMessages(REMOTE_JID, socialText, BOT_TOKEN);
        await db.addMessage(CONV_ID, 'agent', socialText, conv.phase);
        console.log(`[FU${attempt}] Contextual text sent`);
      }
    } catch (err) {
      console.error(`[FU${attempt}] Failed:`, err.message);
    }
    return;
  }

  // ── TEXT FOLLOW-UPS (FU2, FU4-urgency, FU5-close) ──
  await sendTextFollowup(attempt, conv, format);
}

async function sendTextFollowup(attempt, conv, format) {
  const name = conv.name || 'Igor';
  const produto = conv.user_profile?.produto || 'cr\u00e9dito';
  const banco = conv.user_profile?.tentou_banco || '';
  const bancoRef = banco ? ` a nega\u00e7\u00e3o do ${banco}` : ' a situa\u00e7\u00e3o do seu cr\u00e9dito';
  const siteUrl = config.site.url;

  let instruction;
  switch (format) {
    case 'text':
      instruction = `[SISTEMA: Follow-up #2 (48h). ${name} nao respondeu. Mande UMA mensagem referenciando o CASO DELE: ele quer ${produto} e teve${bancoRef}. Aborde de angulo diferente: "Tava pensando no seu caso..." ou "Sabe o que mais trava ${produto}?". INCLUA o link ${siteUrl} no final. NAO mencione preco. Maximo 3 linhas.]`;
      break;
    case 'text_urgency':
      instruction = `[SISTEMA: Follow-up #4 (5 dias). Urgencia REAL (nao falsa). Fale que cada mes sem resolver, os bancos acumulam mais dados negativos sobre ${name}. Pergunte se quer resolver ou se mudou de ideia. INCLUA o link ${siteUrl}. Maximo 3 linhas.]`;
      break;
    case 'text_close':
      instruction = `[SISTEMA: Follow-up #5 FINAL (7 dias). Encerramento. Diga que nao vai mais mandar mensagem. MAS deixe o link como ultimo recurso: "${name}, nao vou mais te mandar mensagem. Se um dia quiser entender por que os bancos tao negando, o link ta aqui: ${siteUrl}. Valeu!" Maximo 2 linhas.]`;
      break;
    default:
      instruction = `[SISTEMA: Follow-up para ${name}. Seja breve. INCLUA link ${siteUrl}.]`;
  }

  const messages = await db.getMessages(CONV_ID, 8);
  const state = {
    phase: conv.phase,
    price_counter: 0,
    link_counter: 0,
    name: name,
    user_profile: conv.user_profile || {},
    recommended_product: conv.recommended_product,
  };

  try {
    const { text } = await getAgentResponse(state, messages, instruction, PERSONA);
    if (text) {
      await sendMessages(REMOTE_JID, text, BOT_TOKEN);
      await db.addMessage(CONV_ID, 'agent', text, conv.phase);
      console.log(`[FU${attempt}] Text sent: "${text.substring(0, 120)}..."`);
    }
  } catch (err) {
    console.error(`[FU${attempt}] Text failed:`, err.message);
  }
}

async function main() {
  console.log('=== FOLLOW-UP TEST v2 ===');
  console.log(`Conv: ${CONV_ID} | Phone: ${PHONE} | Persona: ${PERSONA}`);

  const conv = await db.getConversation(PHONE);
  if (!conv) { console.error('Conversation not found!'); process.exit(1); }

  console.log(`Phase: ${conv.phase} | Product: ${conv.recommended_product} | Profile: ${JSON.stringify(conv.user_profile)}`);
  console.log('Sending 5 follow-ups with 12s delay...\n');

  for (let attempt = 1; attempt <= 5; attempt++) {
    await sendFollowup(attempt, conv);
    if (attempt < 5) {
      console.log(`\nWaiting 12s...`);
      await sleep(12000);
    }
  }

  console.log('\n=== ALL FOLLOW-UPS SENT ===');
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
