/**
 * manager_patch_v3.js — Patches manager.js on the server.
 * v3: Adds Vapi outbound call support in follow-ups for hot leads (phase 3-4).
 */
import { readFileSync, writeFileSync } from 'fs';

const filePath = '/opt/credpositivo-agent/src/conversation/manager.js';
let content = readFileSync(filePath, 'utf8');

// 1. Update import — ensure getFollowupAudio + getProvaSocial
const oldImport = content.match(/import \{[^}]*\} from '\.\.\/media\/assets\.js';/);
if (oldImport) {
  const currentImport = oldImport[0];
  if (!currentImport.includes('getProvaSocial')) {
    const newImport = "import { getMediaForPhase, getProductAudios, getFollowupAudio, getProvaSocial } from '../media/assets.js';";
    content = content.replace(currentImport, newImport);
    console.log('[Patch] Updated assets.js import');
  }
}

// 2. Add handleVoiceCallTrigger import if not present
if (!content.includes('handleVoiceCallTrigger')) {
  // Add after the last import statement
  const lastImportIdx = content.lastIndexOf('\nimport ');
  const nextNewline = content.indexOf('\n', lastImportIdx + 1);
  const insertPoint = content.indexOf('\n', nextNewline + 1);
  content = content.slice(0, insertPoint) +
    "\nimport { handleVoiceCallTrigger } from '../voice/call-handler.js';" +
    content.slice(insertPoint);
  console.log('[Patch] Added handleVoiceCallTrigger import');
} else {
  console.log('[Patch] handleVoiceCallTrigger import already exists');
}

// 3. Replace handleFollowup function
const newHandleFollowup = `export async function handleFollowup(conversation, eventType, usePreRecordedAudio = false, attempt = 1) {
  const messages = await db.getMessages(conversation.id);

  // Guard: check if last message is from agent (need 24h+ gap)
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === 'agent') {
      const hoursSinceLastAgent = (Date.now() - new Date(lastMsg.created_at).getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastAgent < 24) {
        console.log(\`[Followup] BLOCKED \${eventType} for \${conversation.phone} — last agent msg was \${hoursSinceLastAgent.toFixed(1)}h ago (need 24h+). Waiting.\`);
        return;
      }
    }
  }

  const persona = conversation.persona || 'augusto';
  const target = conversation.remote_jid || \`\${conversation.phone}@s.whatsapp.net\`;
  const token = phoneTokenMap.get(conversation.phone) || null;

  // Determine follow-up format
  const { getFollowupFormat } = await import('./followup.js');
  const format = getFollowupFormat(persona, attempt, conversation.phase || 0);

  console.log(\`[Followup] Sending \${eventType} attempt \${attempt} to \${target} (persona: \${persona}, format: \${format.type}, phase: \${conversation.phase})\`);

  // ── PRE-RECORDED AUDIO (attempt 1) ──
  if (format.type === 'pre_recorded_audio') {
    try {
      const audioData = getFollowupAudio(persona);
      if (audioData) {
        await sendMediaBase64(target, audioData.base64, '', audioData.fileName, token);
        await db.addMessage(conversation.id, 'agent', \`[Audio follow-up 24h - \${persona}]\`, conversation.phase);
        console.log(\`[Followup] Pre-recorded audio sent for \${persona} to \${conversation.phone}\`);
        return;
      }
    } catch (err) {
      console.error(\`[Followup] Pre-recorded audio failed:\`, err.message);
    }
  }

  // ── VAPI OUTBOUND CALL (hot leads phase 3-4) ──
  if (format.type === 'vapi_outbound_call') {
    try {
      console.log(\`[Followup] Initiating VAPI OUTBOUND call for \${conversation.phone} (phase \${conversation.phase})\`);
      const callResult = await handleVoiceCallTrigger(
        conversation.phone,
        'followup_hot_lead',
        {
          produto: conversation.recommended_product || '',
          phase: conversation.phase,
          attempt: attempt,
          persona: persona,
        },
        'outbound'
      );
      if (callResult) {
        await db.addMessage(conversation.id, 'agent', \`[Ligacao outbound - follow-up \${attempt} - \${persona}]\`, conversation.phase);
        console.log(\`[Followup] VAPI call initiated for \${conversation.phone}: \${JSON.stringify(callResult)}\`);
        return;
      } else {
        console.warn(\`[Followup] VAPI call skipped/failed for \${conversation.phone}. Falling back to prova social.\`);
        // Fall through to social proof
        const provaSocial = getProvaSocial(persona, conversation.id);
        if (provaSocial) {
          const caption = persona === 'paulo'
            ? 'Olha so o resultado de um dos nossos clientes'
            : 'Olha o que um cliente nosso conseguiu';
          await sendMediaBase64(target, provaSocial.base64, caption, provaSocial.fileName, token);
          await db.addMessage(conversation.id, 'agent', \`[Prova social - \${provaSocial.fileName}] \${caption}\`, conversation.phase);
          return;
        }
      }
    } catch (err) {
      console.error(\`[Followup] VAPI outbound call error:\`, err.message);
      // Fall through to text
    }
  }

  // ── SOCIAL PROOF MEDIA ──
  if (format.type === 'social_proof_media') {
    try {
      const provaSocial = getProvaSocial(persona, conversation.id);
      if (provaSocial) {
        const caption = persona === 'paulo'
          ? 'Olha so o resultado de um dos nossos clientes'
          : 'Olha o que um cliente nosso conseguiu';
        await sendMediaBase64(target, provaSocial.base64, caption, provaSocial.fileName, token);
        await db.addMessage(conversation.id, 'agent', \`[Prova social - \${provaSocial.fileName}] \${caption}\`, conversation.phase);
        console.log(\`[Followup] Prova social sent: \${provaSocial.fileName} to \${conversation.phone}\`);
        return;
      }
    } catch (err) {
      console.error(\`[Followup] Prova social failed:\`, err.message);
    }
  }

  // ── TEXT-BASED FOLLOW-UPS ──
  const state = {
    phase: conversation.phase,
    price_counter: conversation.price_counter,
    link_counter: conversation.link_counter,
    ebook_sent: conversation.ebook_sent,
    name: conversation.name,
    user_profile: conversation.user_profile || {},
    recommended_product: conversation.recommended_product,
  };

  const followupPrompt = buildFollowupPrompt(eventType, conversation, attempt, persona);

  const { text: responseText, metadata } = await getAgentResponse(
    state,
    messages,
    followupPrompt,
    persona
  );

  if (!responseText) return;

  const fixedText = fixSiteLinks(responseText);

  // Legacy TTS audio for specific events
  const legacyAudioEvents = ['purchase_completed', 'purchase_followup', 'reengagement'];
  if (legacyAudioEvents.includes(eventType) && config.tts.enabled) {
    try {
      const { sendAudioMessage } = await import('../audio/tts.js');
      const audioText = getAudioScript(eventType, conversation);
      await sendAudioMessage(target, audioText, token);
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      console.error(\`[Followup] TTS audio failed:\`, err.message);
    }
  }

  await sendMessages(target, fixedText, token);
  await db.addMessage(conversation.id, 'agent', fixedText, conversation.phase);

  const updates = applyMetadataUpdates(state, metadata);
  if (Object.keys(updates).length > 0) {
    await db.updateConversation(conversation.id, updates);
  }

  console.log(\`[Followup] \${eventType} attempt \${attempt} (\${format.type}) sent to \${target}\`);
}`;

// Match both v2 and v3 versions
const handleFollowupV3Regex = /export async function handleFollowup\(conversation, eventType, usePreRecordedAudio = false, attempt = 1\) \{[\s\S]*?\n\}\n/;
const handleFollowupV1Regex = /export async function handleFollowup\(conversation, eventType, useAudio = false\) \{[\s\S]*?\n\}\n/;

if (handleFollowupV3Regex.test(content)) {
  content = content.replace(handleFollowupV3Regex, newHandleFollowup + '\n\n');
  console.log('[Patch] Replaced handleFollowup (added vapi_outbound_call)');
} else if (handleFollowupV1Regex.test(content)) {
  content = content.replace(handleFollowupV1Regex, newHandleFollowup + '\n\n');
  console.log('[Patch] Replaced handleFollowup v1 (added vapi_outbound_call)');
} else {
  console.error('[Patch] Could not find handleFollowup!');
  process.exit(1);
}

// 4. Replace buildFollowupPrompt
const newBuildFollowupPrompt = `function buildFollowupPrompt(eventType, conversation, attempt = 1, persona = 'augusto') {
  const name = conversation.name || 'amigo';

  if (['consultation_timeout', 'social_proof', 'urgency'].includes(eventType)) {
    const augustoPrompts = {
      2: \`[SISTEMA: Follow-up #2 (48h). O lead \${name} nao respondeu ao audio de ontem. Mande UMA mensagem curta e genuina com um angulo DIFERENTE. Pode ser uma pergunta sobre a situacao dele, mencionar que viu algo no perfil, ou perguntar se tem alguma duvida. NAO repita o que ja foi dito. NAO mencione preco. Seja breve e humano.]\`,
      3: \`[SISTEMA: Follow-up #3 (72h). Uma prova social (video/imagem de resultado real) acabou de ser enviada ao lead. Mande UMA frase curta complementando, tipo: "Esse e um dos nossos clientes que conseguiu resolver" ou "Resultados assim sao comuns por aqui". NAO repita o conteudo da midia. Seja breve.]\`,
      4: \`[SISTEMA: Follow-up #4 (5 dias). Use ESCASSEZ genuina. Mencione que as condicoes de negociacao mudam frequentemente e que quanto antes \${name} resolver, melhor. NAO invente promocoes falsas. Pergunte se quer retomar a conversa. Breve e direto.]\`,
      5: \`[SISTEMA: Follow-up #5 FINAL (7 dias). Encerramento GENTIL. Diga que percebe que agora talvez nao seja o melhor momento pra \${name}. Deixe a porta aberta dizendo que quando precisar, e so chamar. NAO pressione. Despeca-se com respeito. Esta e a ULTIMA mensagem automatica.]\`,
    };

    const pauloPrompts = {
      2: \`[SISTEMA: Follow-up #2 (48h). O lead \${name} nao respondeu ao audio. Pergunte se teve alguma DIFICULDADE TECNICA pra acessar o site ou se ficou alguma duvida. Mostre-se prestativo. NAO pressione. Uma mensagem curta.]\`,
      3: \`[SISTEMA: Follow-up #3 (72h). Use ESCASSEZ genuina. Mencione que as condicoes de negociacao e descontos mudam e que vale a pena \${name} dar uma olhada enquanto esta favoravel. Breve e direto, sem pressao excessiva.]\`,
      4: \`[SISTEMA: Follow-up #4 (5 dias). Uma prova social (video/imagem de resultado real) acabou de ser enviada ao lead. Mande UMA frase curta complementando, tipo: "Olha so o que esse cliente conseguiu" ou "Resultados assim sao bem comuns aqui". NAO repita o conteudo da midia. Seja breve.]\`,
      5: \`[SISTEMA: Follow-up #5 FINAL (7 dias). Encerramento GENTIL. Diga que percebe que agora talvez nao seja o melhor momento. Deixe a porta aberta. NAO pressione. Despeca-se com respeito. ULTIMA mensagem automatica.]\`,
    };

    const prompts = persona === 'paulo' ? pauloPrompts : augustoPrompts;
    if (prompts[attempt]) return prompts[attempt];
  }

  const legacyPrompts = {
    signup_completed:
      \`[SISTEMA: O lead criou conta no site mas ainda nao comprou. Pergunte se teve alguma duvida ou dificuldade. NAO pressione para comprar. Uma mensagem so.]\`,
    purchase_completed:
      \`[SISTEMA: O lead comprou \${conversation.recommended_product || 'um produto'}. Parabenize e pergunte se precisa de ajuda com algo. Seja breve.]\`,
    purchase_abandoned:
      \`[SISTEMA: O lead iniciou checkout mas nao finalizou. Pergunte se teve alguma dificuldade tecnica. NAO pressione. Uma mensagem so.]\`,
    link_sent_no_action:
      \`[SISTEMA: O link foi enviado ha 24h+ mas o lead nao acessou. Pergunte se ficou alguma duvida. NAO reenvie o link. Uma mensagem so.]\`,
    reengagement:
      \`[SISTEMA: O lead ficou inativo ha mais de 24h. Mande UMA mensagem curta, pessoal e genuina. Mostre que se importa. NAO mencione preco.]\`,
    purchase_followup:
      \`[SISTEMA: Acompanhamento pos-compra. O lead comprou \${conversation.recommended_product || 'um produto'}. Pergunte como esta o processo. Seja breve.]\`,
  };

  return legacyPrompts[eventType] || \`[SISTEMA: Follow-up necessario para \${eventType}. Attempt \${attempt}. Seja breve e humano.]\`;
}`;

const buildFollowupV2Regex = /function buildFollowupPrompt\(eventType, conversation, attempt = 1, persona = 'augusto'\) \{[\s\S]*?\n\}/;
const buildFollowupV1Regex = /function buildFollowupPrompt\(eventType, conversation\) \{[\s\S]*?\n\}/;

if (buildFollowupV2Regex.test(content)) {
  content = content.replace(buildFollowupV2Regex, newBuildFollowupPrompt);
  console.log('[Patch] Replaced buildFollowupPrompt');
} else if (buildFollowupV1Regex.test(content)) {
  content = content.replace(buildFollowupV1Regex, newBuildFollowupPrompt);
  console.log('[Patch] Replaced buildFollowupPrompt v1');
}

writeFileSync(filePath, content, 'utf8');
console.log('[Patch] manager.js patched successfully (v4 — Vapi outbound calls)!');
