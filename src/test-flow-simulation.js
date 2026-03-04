/**
 * Flow Simulation — tests the full conversation flow without WhatsApp.
 * Calls Claude directly with the actual prompts to verify responses.
 *
 * Usage: node src/test-flow-simulation.js
 */
import { buildSystemPrompt } from './ai/system-prompt.js';
import { config } from './config.js';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const SCENARIOS = [
  {
    name: 'CENARIO 1: Limpa Nome completo (lead negativado)',
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
    ],
  },
  {
    name: 'CENARIO 2: Lead desconfiado ("é golpe?")',
    messages: [
      'oi',
      '1',
      'Banco negou meu emprestimo',
      'Faz 2 anos. Tentei no Itau e Bradesco',
      'Mas isso funciona mesmo? Parece golpe',
      'Ok, vou ouvir',
      'Entendi. Mas quanto custa?',
    ],
  },
  {
    name: 'CENARIO 3: Lead direto ("quero fazer logo")',
    messages: [
      'Quero limpar meu nome',
      '2',
      'SPC e Serasa, 6 meses',
      'Nunca tentei. Quero resolver rapido',
      'Pode mandar o audio',
      'Ouvi. Manda a imagem',
      'Vi. Manda o video',
      'Quero fazer agora. Me manda o link',
    ],
  },
  {
    name: 'CENARIO 4: Lead que pergunta preço cedo demais',
    messages: [
      'Oi',
      'Quanto custa pra limpar o nome?',
      '2',
      'Serasa, 1 ano',
      'Primeira vez tentando',
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
  // Extract JSON metadata from AI response
  const jsonMatch = text.match(/\{[\s\S]*?"phase"[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
  return null;
}

async function simulateScenario(scenario) {
  console.log('\n' + '='.repeat(70));
  console.log(scenario.name);
  console.log('='.repeat(70));

  let state = {
    phase: 0,
    price_counter: 0,
    link_counter: 0,
    ebook_sent: false,
    name: null,
    user_profile: {},
    recommended_product: null,
    message_count: 0,
  };

  const conversationHistory = [];

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

    // Parse metadata from response
    const metadata = parseMetadata(fullResponse);
    const responseText = fullResponse.replace(/\{[\s\S]*?"phase"[\s\S]*?\}/, '').trim();

    // Determine educational material dispatch
    const effectivePhase = metadata?.phase ?? state.phase;
    const eduStage = state.user_profile?.educational_stage || 0;
    const phaseAllowsEdu = effectivePhase >= 2;
    const aiIntroduced = eduStage > 0 || /audio|diagnostico|raio.?x/i.test(responseText);
    const shouldAdvanceEdu = phaseAllowsEdu && eduStage < 3 && aiIntroduced;

    let mediaAction = 'nenhuma';
    let newEduStage = eduStage;
    if (shouldAdvanceEdu) {
      if (eduStage === 0) { mediaAction = 'AUDIO enviado'; newEduStage = 1; }
      else if (eduStage === 1) { mediaAction = 'INFOGRAFICO enviado'; newEduStage = 2; }
      else if (eduStage === 2) { mediaAction = 'VIDEO enviado'; newEduStage = 3; }
    }

    // Check for issues
    const issues = [];
    const charCount = responseText.length;
    if (charCount > 250 && state.phase > 1) issues.push(`TEXTAO (${charCount} chars)`);
    if (state.phase <= 2 && /credpositivo\.com/i.test(responseText)) issues.push('LINK NA FASE ERRADA');
    if (state.phase <= 2 && /R\$\d+/i.test(responseText)) issues.push('PRECO NA FASE ERRADA');
    if (/R\$97/i.test(responseText)) issues.push('PRECO ERRADO (R$97 em vez de R$67)');
    if (/fico.{0,5}disposi/i.test(responseText)) issues.push('FRASE PROIBIDA');
    if (/\[.*?\]/i.test(responseText)) issues.push('TAG SISTEMA VAZOU');

    // Print step
    console.log(`\n  [MSG ${i + 1}] Lead: "${userMsg}"`);
    console.log(`  [AI] (${charCount} chars): ${responseText.substring(0, 200)}${responseText.length > 200 ? '...' : ''}`);
    console.log(`  [STATE] phase: ${state.phase}→${effectivePhase} | edu: ${eduStage}→${newEduStage} | media: ${mediaAction}`);
    if (metadata) console.log(`  [META] phase=${metadata.phase} link=${metadata.should_send_link} product=${metadata.recommended_product}`);
    if (issues.length > 0) console.log(`  [ISSUE] ${issues.join(' | ')}`);

    // Update state
    if (metadata?.phase !== undefined) state.phase = metadata.phase;
    if (metadata?.recommended_product) state.recommended_product = metadata.recommended_product;
    if (metadata?.user_profile_update) {
      state.user_profile = { ...state.user_profile, ...metadata.user_profile_update };
    }
    if (newEduStage !== eduStage) {
      state.user_profile.educational_stage = newEduStage;
      state.user_profile.educational_material_sent = newEduStage >= 3;
    }
    state.message_count = (state.message_count || 0) + 2; // user + agent

    // Add AI response to history (without metadata)
    conversationHistory.push({ role: 'assistant', content: responseText });
  }

  console.log(`\n  [FINAL STATE] phase=${state.phase} | edu_stage=${state.user_profile?.educational_stage || 0} | product=${state.recommended_product}`);
}

async function main() {
  console.log('CredPositivo Flow Simulation');
  console.log('Model: claude-haiku-4-5-20251001');
  console.log('Date:', new Date().toISOString());

  for (const scenario of SCENARIOS) {
    await simulateScenario(scenario);
  }

  console.log('\n\nSIMULATION COMPLETE');
}

main().catch(console.error);
