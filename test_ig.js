import Anthropic from '@anthropic-ai/sdk';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY, dangerouslyAllowBrowser: true });

const BIA_PROMPT = `Você é Bia, social media da CredPositivo. Crie um post para Instagram.

SOBRE A CREDPOSITIVO:
- Empresa de serviços financeiros que ajuda pessoas a recuperar e construir crédito
- Produtos: Diagnóstico de Rating (R$97), Limpa Nome (R$497), Rating Bancário (R$997)
- Site: credpositivo.com/cadastro
- Tom: acessível, empoderador, direto, educativo

REGRAS:
- Português brasileiro informal mas profissional
- Máximo 2-3 emojis
- NUNCA mencione preço do Rating (R$997)
- CTA pro Diagnóstico ou link na bio

Responda APENAS JSON:
{
  "caption": "Legenda completa com hashtags",
  "image_prompt": "Prompt em inglês para DALL-E. Imagem profissional, cores azul/verde, SEM texto na imagem.",
  "pillar": "educativo",
  "topic": "Tema em 3 palavras"
}`;

async function run() {
  console.log('[1/3] Gerando conteúdo com Bia (Claude)...');
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{ role: 'user', content: 'Crie 1 post educativo sobre score de crédito para Instagram. Responda APENAS JSON.' }],
    system: BIA_PROMPT,
  });

  const text = msg.content[0].text.trim().replace(/```json?\n?/g, '').replace(/```/g, '').trim();
  const content = JSON.parse(text);
  console.log('Caption:', content.caption.substring(0, 100) + '...');
  console.log('Topic:', content.topic);
  console.log('Image prompt:', content.image_prompt.substring(0, 80) + '...');

  console.log('\n[2/3] Gerando imagem com DALL-E...');
  const imgRes = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt: 'Professional social media post image. ' + content.image_prompt + '. Clean design, no text overlays, high quality, Instagram square format 1080x1080.',
      n: 1, size: '1024x1024', quality: 'standard',
    }),
  });
  const imgData = await imgRes.json();
  if (imgData.error) { console.error('DALL-E error:', imgData.error.message); process.exit(1); }
  const imageUrl = imgData.data[0].url;
  console.log('Image URL:', imageUrl.substring(0, 80) + '...');

  console.log('\n[3/3] Publicando no Instagram @_credpositivo...');
  // Step 1: Create container
  const cRes = await fetch('https://graph.facebook.com/v21.0/' + INSTAGRAM_ACCOUNT_ID + '/media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: imageUrl, caption: content.caption, access_token: META_ACCESS_TOKEN }),
  });
  const container = await cRes.json();
  if (container.error) { console.error('Container error:', container.error.message); process.exit(1); }
  console.log('Container ID:', container.id);

  // Step 2: Wait for processing
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const sRes = await fetch('https://graph.facebook.com/v21.0/' + container.id + '?fields=status_code&access_token=' + META_ACCESS_TOKEN);
    const s = await sRes.json();
    console.log('Status:', s.status_code);
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR') { console.error('Processing error'); process.exit(1); }
  }

  // Step 3: Publish
  const pRes = await fetch('https://graph.facebook.com/v21.0/' + INSTAGRAM_ACCOUNT_ID + '/media_publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: container.id, access_token: META_ACCESS_TOKEN }),
  });
  const pub = await pRes.json();
  if (pub.error) { console.error('Publish error:', pub.error.message); process.exit(1); }
  console.log('\nPUBLICADO! Post ID:', pub.id);
  console.log('https://www.instagram.com/_credpositivo/');
}

run().catch(e => console.error('Error:', e.message));
