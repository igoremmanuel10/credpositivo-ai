/**
 * Instagram Auto-Publisher — Bia (content) + DALL-E (image) + Instagram API
 *
 * Pipeline:
 *   1. Bia gera conteúdo (legenda + prompt de imagem) via Claude
 *   2. DALL-E gera a imagem
 *   3. Publica no Instagram via Graph API
 *
 * Schedule (BRT / UTC):
 *   09:00 / 12:00  — Gera conteúdo do dia (2 posts)
 *   12:00 / 15:00  — Publica post 1 (horário de almoço)
 *   19:00 / 22:00  — Publica post 2 (horário nobre)
 *
 * Costs: ~R$0.15/image (DALL-E) + ~R$0.02/text (Claude) = ~R$0.35/day
 */

import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { postToOpsInbox } from '../chatwoot/ops-inbox.js';
import { sendText, getTokenForWid } from '../quepasa/client.js';
import { db } from '../db/client.js';
import { emit, setStatus } from '../os/emitter.js';
import { getPromptOverride } from '../os/api/admin-routes.js';

// --- Config ---
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;
const FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const API_VERSION = 'v21.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

const ADM_GROUP_JID = config.admGroupJid || process.env.ADM_GROUP_JID;
const AUGUSTO_WID = '5571936180654';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey, dangerouslyAllowBrowser: true });

// Content queue for the day
let dailyQueue = [];

// --- Bia System Prompt (default — overridable via admin panel) ---
export const BIA_PROMPT_DEFAULT = `Você é Bia, social media da CredPositivo. Crie um post para Instagram.

SOBRE A CREDPOSITIVO:
- Empresa de serviços financeiros que ajuda pessoas a recuperar e construir crédito
- Produtos: Diagnóstico de Rating (R$67), Limpa Nome (R$497), Rating Bancário (R$997)
- Site: credpositivo.com/diagnostico
- Tom: acessível, empoderador, direto, educativo
- Público: pessoas com nome sujo, score baixo, que querem crédito

REGRAS:
- Português brasileiro informal mas profissional
- Máximo 2-3 emojis por post
- NUNCA mencione preço do Rating (R$997) proativamente
- Use "você" (nunca "tu" ou "o senhor")
- CTA sempre direcionando pro Diagnóstico (R$67) ou link na bio
- Hashtags: mix de marca (#CredPositivo #NomeLimpo) + nicho (#Score #SPC #Serasa) + alcance

PILARES DE CONTEÚDO (alterne entre):
- 40% Educativo: dicas de crédito, como funciona o score, direitos do consumidor
- 25% Inspiracional: transformação, depoimentos, antes/depois
- 25% Conversacional: enquetes, mitos vs verdades, perguntas
- 10% Promocional: CTA direto pro Diagnóstico

Responda EXATAMENTE neste formato JSON:
{
  "caption": "Texto da legenda do Instagram (com emojis, CTA e hashtags no final)",
  "image_prompt": "Prompt em inglês para gerar imagem no DALL-E. Descreva uma imagem profissional, clean, com cores azul e verde (identidade CredPositivo). NÃO inclua texto na imagem. Estilo: foto profissional ou ilustração moderna.",
  "pillar": "educativo|inspiracional|conversacional|promocional",
  "topic": "Tema resumido em 3 palavras"
}`;

// --- Get active prompt (Redis override or default) ---
async function getBiaPrompt() {
  const override = await getPromptOverride('bia');
  return override || BIA_PROMPT_DEFAULT;
}

// --- Generate Content with Bia (Claude) ---
async function generateContent(postNumber) {
  try {
    // Check what was posted recently to avoid repetition
    let recentTopics = [];
    try {
      const { rows } = await db.query(
        `SELECT topic, pillar FROM instagram_posts WHERE created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 10`
      );
      recentTopics = rows;
    } catch (e) { /* table may not exist */ }

    const recentInfo = recentTopics.length > 0
      ? `\nPosts recentes (EVITE repetir): ${recentTopics.map(r => `${r.pillar}: ${r.topic}`).join(', ')}`
      : '';

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Crie o post ${postNumber} do dia para o Instagram da CredPositivo.${recentInfo}\n\nResponda APENAS o JSON, sem markdown.`
      }],
      system: await getBiaPrompt(),
    });

    const text = msg.content[0].text.trim();
    // Parse JSON - handle potential markdown wrapping
    const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error('[Instagram] Content generation error:', err.message);
    return null;
  }
}

// --- Generate Image with DALL-E ---
async function generateImage(prompt) {
  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: `Professional social media post image. ${prompt}. Clean design, no text overlays, high quality, Instagram square format 1080x1080.`,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
      }),
    });

    const data = await res.json();
    if (data.error) {
      console.error('[Instagram] DALL-E error:', data.error.message);
      return null;
    }
    return data.data[0].url;
  } catch (err) {
    console.error('[Instagram] Image generation error:', err.message);
    return null;
  }
}

// --- Publish to Instagram ---
async function publishToInstagram(imageUrl, caption) {
  try {
    // Step 1: Create media container
    const containerRes = await fetch(`${BASE_URL}/${INSTAGRAM_ACCOUNT_ID}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url: imageUrl,
        caption: caption,
        access_token: META_ACCESS_TOKEN,
      }),
    });
    const container = await containerRes.json();

    if (container.error) {
      console.error('[Instagram] Container error:', container.error.message);
      return null;
    }

    const containerId = container.id;
    console.log(`[Instagram] Container created: ${containerId}`);

    // Step 2: Wait for processing (poll status)
    let ready = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await fetch(`${BASE_URL}/${containerId}?fields=status_code&access_token=${META_ACCESS_TOKEN}`);
      const status = await statusRes.json();
      if (status.status_code === 'FINISHED') {
        ready = true;
        break;
      }
      if (status.status_code === 'ERROR') {
        console.error('[Instagram] Container processing error');
        return null;
      }
    }

    if (!ready) {
      console.error('[Instagram] Container processing timeout');
      return null;
    }

    // Step 3: Publish
    const publishRes = await fetch(`${BASE_URL}/${INSTAGRAM_ACCOUNT_ID}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: containerId,
        access_token: META_ACCESS_TOKEN,
      }),
    });
    const published = await publishRes.json();

    if (published.error) {
      console.error('[Instagram] Publish error:', published.error.message);
      return null;
    }

    console.log(`[Instagram] Published! Post ID: ${published.id}`);
    return published.id;
  } catch (err) {
    console.error('[Instagram] Publish error:', err.message);
    return null;
  }
}

// --- Save post to DB ---
async function savePost(content, imageUrl, postId, status) {
  try {
    await db.query(`
      INSERT INTO instagram_posts (caption, image_url, post_id, pillar, topic, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [content.caption, imageUrl, postId, content.pillar, content.topic, status]);
  } catch (err) {
    if (err.message.includes('does not exist')) {
      await db.query(`
        CREATE TABLE IF NOT EXISTS instagram_posts (
          id SERIAL PRIMARY KEY,
          caption TEXT,
          image_url TEXT,
          post_id TEXT,
          pillar VARCHAR(50),
          topic VARCHAR(100),
          status VARCHAR(20) DEFAULT 'pending',
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await db.query(`
        INSERT INTO instagram_posts (caption, image_url, post_id, pillar, topic, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [content.caption, imageUrl, postId, content.pillar, content.topic, status]);
    }
  }
}

// --- Notify ADM group ---
async function notify(text) {
  try {
    const token = getTokenForWid(AUGUSTO_WID);
    if (ADM_GROUP_JID) {
      await postToOpsInbox('Instagram — Publicação', text, { labels: ['instagram', 'social-media'] });
    }
  } catch (err) {
    console.error('[Instagram] Notify error:', err.message);
  }
}

// --- Morning: Generate content for the day ---
async function generateDailyContent() {
  console.log('[Instagram] Generating daily content...');

  dailyQueue = [];

  for (let i = 1; i <= 2; i++) {
    const content = await generateContent(i);
    if (!content) continue;

    const imageUrl = await generateImage(content.image_prompt);
    if (!imageUrl) continue;

    dailyQueue.push({ content, imageUrl });
    console.log(`[Instagram] Post ${i} ready: ${content.pillar} — ${content.topic}`);
    await emit('bia.content_generated', 'bia', { topic: content.topic, pillar: content.pillar });
  }

  if (dailyQueue.length > 0) {
    await notify(`*[IG] Conteúdo do dia gerado*\n\n${dailyQueue.map((p, i) =>
      `Post ${i + 1}: ${p.content.pillar} — ${p.content.topic}`
    ).join('\n')}\n\nPublicação: 12h e 19h`);
  } else {
    console.error('[Instagram] Failed to generate any content');
  }
  await setStatus('bia', 'online');
}

// --- Publish post from queue ---
async function publishFromQueue(index) {
  if (!dailyQueue[index]) {
    console.log(`[Instagram] No post at index ${index} to publish`);
    return;
  }

  const { content, imageUrl } = dailyQueue[index];
  console.log(`[Instagram] Publishing post ${index + 1}: ${content.topic}`);

  const postId = await publishToInstagram(imageUrl, content.caption);
  const status = postId ? 'published' : 'failed';

  await savePost(content, imageUrl, postId, status);

  if (postId) {
    await notify(`*[IG] Post publicado*\n\n${content.pillar}: ${content.topic}\nhttps://instagram.com/p/${postId}`);
    await emit('bia.post_published', 'bia', { platform: 'instagram' });
  } else {
    await notify(`*[IG] Falha ao publicar*\n\nPost: ${content.topic}\nVerificar logs.`);
  }
}

// --- Public API ---
export async function getInstagramStats() {
  try {
    const { rows } = await db.query(`
      SELECT status, COUNT(*) as count FROM instagram_posts 
      WHERE created_at > NOW() - INTERVAL '7 days' 
      GROUP BY status
    `);
    return rows;
  } catch (e) { return []; }
}

export async function publishNow(caption, imagePrompt) {
  const imageUrl = await generateImage(imagePrompt);
  if (!imageUrl) return { error: 'Failed to generate image' };
  const postId = await publishToInstagram(imageUrl, caption);
  return { postId, imageUrl };
}

// --- Scheduler ---
export function startInstagramScheduler() {
  if (!META_ACCESS_TOKEN || !INSTAGRAM_ACCOUNT_ID || !OPENAI_API_KEY) {
    console.log('[Instagram] Missing credentials, publisher disabled');
    return;
  }

  console.log('[Instagram] Auto-Publisher ATIVADO — Conteúdo (09h) + Posts (12h, 19h)');

  // 09:00 BRT = 12:00 UTC — Generate daily content
  cron.schedule('0 12 * * 1-6', () => generateDailyContent(), { timezone: 'UTC' });

  // 12:00 BRT = 15:00 UTC — Publish post 1
  cron.schedule('0 15 * * 1-6', () => publishFromQueue(0), { timezone: 'UTC' });

  // 19:00 BRT = 22:00 UTC — Publish post 2
  cron.schedule('0 22 * * 1-6', () => publishFromQueue(1), { timezone: 'UTC' });
}
