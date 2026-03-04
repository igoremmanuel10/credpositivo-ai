/**
 * Flow Simulation v2 — tests the FULL conversation flow.
 * Matches EXACTLY the real manager.js logic.
 *
 * Usage: node src/test-flow-simulation.js
 */
import { buildSystemPrompt } from './ai/system-prompt.js';
import { config } from './config.js';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const SCENARIOS = [
  {
    name: 'CENARIO 1: Fluxo COMPLETO — menu ate fechamento',
    messages: [
      'Oi, como funciona?',
      '2',
      'Serasa, faz 4 anos',
      'Ja tentei limpar e nao deu certo',
      'Sim, faz sentido',
      'Sim, ouvi o audio',
      'Entendi a imagem, show',
      'Gostei do video, quero fazer',
      'Quanto custa?',
      'Vou fazer',
      'Ja paguei',
    ],
  },
  {
    name: 'CENARIO 2: Lead desconfiado — objecoes',
    messages: [
      'oi',
      '1',
      'Banco negou meu emprestimo faz 2 anos. Tentei no Itau e Bradesco',
      'Mas isso funciona mesmo? Parece golpe',
      'Ta, mas e caro?',
      'Vou pensar',
      'Voltei, quero fazer',
    ],
  },
  {
    name: 'CENARIO 3: Lead direto — quer resolver rapido',
    messages: [
      'Quero limpar meu nome',
      'SPC e Serasa, 6 meses. Nunca tentei resolver',
      'Pode mandar',
      'Ouvi',
      'Vi a imagem',
      'Assisti o video. Quero fazer',
      'Manda o link',
    ],
  },
  {
    name: 'CENARIO 4: Lead pergunta preco antes da hora',
    messages: [
      'Oi',
      'Quanto custa pra limpar o nome?',
      'Serasa, 1 ano. Primeira vez tentando',
      'Ok, pode mandar o material',
      'Ouvi o audio. E ai?',
      'Vi a imagem. Entendi',
      'Assisti. Quanto custa?',
    ],
  },
  {
    name: 'CENARIO 5: Lead manda audio/imagem',
    messages: [
      'oi',
      '3',
      'Quero aumentar meu score. Banco sempre nega. Faz 1 ano tentando',
      'Ta, e o que vcs fazem exatamente?',
    ],
  },
  {
    name: 'CENARIO 6: Lead quer falar com humano',
    messages: [
      'oi',
      '1',
      'Quero falar com alguem de verdade, nao com robo',
    ],
  },
  {
    name: 'CENARIO 7: Lead retornando (ja conversou antes)',
    initialState: {
      phase: 2,
      name: 'Carlos',
      message_count: 6,
      user_profile: { educational_stage: 1, negativacao_local: 'serasa' },
      recommended_product: 'diagnostico',
    },
    messages: [
      'Oi, voltei. Sobre aquele diagnostico...',
      'Sim, ouvi o audio. Me explica melhor',
      'Entendi. Quero fazer',
    ],
  },
  {
    name: 'CENARIO 8: Lead opcao 4 — ja estava em atendimento',
    messages: [
      'oi',
      '4',
      'Meu nome e Joao, conversei ontem',
    ],
  },
];

async function callClaude(systemPrompt, messages) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: systemPrompt,
    messages,
  });
  return response.content[0].text;
}

function parseMetadata(text) {
  let metadataMatch = text.match(/\[METADATA\]([\s\S]*?)\[\/METADATA\]/);
  if (!metadataMatch) {
    metadataMatch = text.match(/\[METADATA\]([\s\S]*)$/);
  }
  if (!metadataMatch) return { data: null, cleanText: text };

  const cleanText = text.replace(/\[METADATA\][\s\S]*?\[\/METADATA\]/, '').replace(/\[METADATA\][\s\S]*$/, '').trim();
  try {
    const data = JSON.parse(metadataMatch[1].trim());
    return { data, cleanText };
  } catch {
    return { data: null, cleanText };
  }
}

async function simulateScenario(scenario) {
  console.log('\n' + '='.repeat(70));
  console.log(scenario.name);
  console.log('='.repeat(70));

  let state = scenario.initialState ? { ...scenario.initialState } : {
    phase: 0,
    price_counter: 0,
    link_counter: 0,
    ebook_sent: false,
    name: null,
    user_profile: {},
    recommended_product: null,
    message_count: 0,
  };
  // Ensure user_profile exists
  state.user_profile = state.user_profile || {};

  if (scenario.initialState) {
    console.log(`  [INITIAL STATE] phase=${state.phase} | edu=${state.user_profile?.educational_stage || 0} | name=${state.name} | msgs=${state.message_count}`);
  }

  const conversationHistory = [];
  let totalIssues = 0;

  for (let i = 0; i < scenario.messages.length; i++) {
    const userMsg = scenario.messages[i];
    conversationHistory.push({ role: 'user', content: userMsg });

    const systemPrompt = buildSystemPrompt(state);
    let fullResponse;
    try {
      fullResponse = await callClaude(systemPrompt, conversationHistory);
    } catch (err) {
      console.log(`  [ERROR] API call failed: ${err.message}`);
      break;
    }

    const { data: metadata, cleanText: responseText } = parseMetadata(fullResponse);

    // EXACT same dispatch logic as manager.js (no aiIntroduced check)
    const effectivePhase = metadata?.phase ?? state.phase;
    const eduStage = state.user_profile?.educational_stage || 0;
    const shouldAdvanceEdu = effectivePhase >= 2 && eduStage < 3;

    let mediaAction = '-';
    let newEduStage = eduStage;
    if (shouldAdvanceEdu) {
      if (eduStage === 0) { mediaAction = 'AUDIO'; newEduStage = 1; }
      else if (eduStage === 1) { mediaAction = 'INFOGRAFICO'; newEduStage = 2; }
      else if (eduStage === 2) { mediaAction = 'VIDEO'; newEduStage = 3; }
    }

    // Check for issues
    const issues = [];
    const charCount = responseText.length;
    if (charCount > 300 && state.phase > 1) issues.push(`TEXTAO(${charCount})`);
    if (effectivePhase <= 2 && /credpositivo\.com/i.test(responseText)) issues.push('LINK_CEDO');
    if (effectivePhase <= 2 && /R\$\d+/i.test(responseText)) issues.push('PRECO_CEDO');
    if (/R\$97/i.test(responseText)) issues.push('PRECO_ERRADO');
    if (/fico.{0,5}disposi|qualquer coisa me chama|boa sorte/i.test(responseText)) issues.push('FRASE_PROIBIDA');
    if (/\[(?!METADATA).*?\]/i.test(responseText) && responseText.length > 5) issues.push('TAG_VAZOU');
    if (!metadata) issues.push('SEM_METADATA');
    totalIssues += issues.length;

    // Print step (compact)
    const issueStr = issues.length > 0 ? ` !! ${issues.join(' ')}` : '';
    console.log(`\n  [${i + 1}] "${userMsg}"`);
    console.log(`      → (${charCount}c) ${responseText.substring(0, 180)}${responseText.length > 180 ? '...' : ''}`);
    console.log(`      ph:${state.phase}→${effectivePhase} edu:${eduStage}→${newEduStage} media:${mediaAction} prod:${metadata?.recommended_product || '-'}${issueStr}`);

    // Update state (same as manager.js applyMetadataUpdates)
    if (metadata?.phase !== undefined) state.phase = metadata.phase;
    if (metadata?.recommended_product) state.recommended_product = metadata.recommended_product;
    if (metadata?.user_profile_update) {
      state.user_profile = { ...state.user_profile, ...metadata.user_profile_update };
    }
    if (metadata?.price_mentioned) state.price_counter = (state.price_counter || 0) + 1;
    if (metadata?.should_send_link) state.link_counter = (state.link_counter || 0) + 1;
    if (newEduStage !== eduStage) {
      state.user_profile.educational_stage = newEduStage;
      state.user_profile.educational_material_sent = newEduStage >= 3;
    }
    if (metadata?.user_profile_update?.name) state.name = metadata.user_profile_update.name;
    state.message_count = (state.message_count || 0) + 2;

    conversationHistory.push({ role: 'assistant', content: responseText });
  }

  const verdict = totalIssues === 0 ? 'PASS' : `${totalIssues} ISSUES`;
  console.log(`\n  [RESULT] ${verdict} | phase=${state.phase} edu=${state.user_profile?.educational_stage || 0} product=${state.recommended_product || '-'} name=${state.name || '-'}`);
  return totalIssues;
}

async function main() {
  console.log('CredPositivo Flow Simulation v2');
  console.log('Model: claude-haiku-4-5-20251001');
  console.log('Date:', new Date().toISOString());
  console.log('Matching EXACT manager.js dispatch logic\n');

  let total = 0;
  for (const scenario of SCENARIOS) {
    total += await simulateScenario(scenario);
  }

  console.log('\n' + '='.repeat(70));
  console.log(`TOTAL: ${total} issues across ${SCENARIOS.length} scenarios`);
  console.log('Note: PRECO_CEDO and LINK_CEDO are caught by output-filter in real system');
  console.log('='.repeat(70));
}

main().catch(console.error);
