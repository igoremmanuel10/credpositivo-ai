# Auditoria de UI/Marca + Mini Design System - CredPositivo

**Data:** 13 de fevereiro de 2026
**Responsavel:** Designer - Fase 1

---

## Resumo Executivo

O CredPositivo apresenta uma identidade visual **fragmentada e inconsistente** entre suas paginas. A marca comunica "confianca financeira", mas a execucao visual transmite amadorismo em pontos criticos. O site tem uma landing page com estrutura persuasiva razoavel, porem a pagina bio (principal porta de entrada via Instagram) e visualmente fraca e sem elementos de credibilidade. O cadastro usa fundo escuro (#050505) que destoa completamente do restante. Nao ha sistema de design unificado -- cada pagina parece ter sido construida de forma independente.

**Problemas centrais:**
- Inconsistencia visual entre paginas (fundos, espacamentos, estilos de botao)
- Pagina bio sem prova social, sem hierarquia visual clara
- Landing page com fotos stock nos depoimentos, comprometendo autenticidade
- Sistema de cadastro/login com estetica desconectada da marca
- Dashboard inexistente (404) -- a area do cliente nao funciona
- Ausencia de design system -- cada componente segue regras proprias
- Elementos que geram desconfianca em um servico financeiro

---

## Auditoria Visual do Site

### Pagina Bio (/bio) -- Porta de Entrada Principal

**Estrutura:** Layout vertical simples, centralizado. Logo no topo, imagem hero, headline, hub de 4 botoes, link WhatsApp flutuante no rodape.

**Problemas encontrados:**

| # | Problema | Severidade | Detalhes |
|---|----------|-----------|---------|
| 1 | **Zero prova social visual** | CRITICA | Nenhum numero, selo, depoimento ou indicador de credibilidade. Lead vindo do Instagram chega numa pagina vazia de validacao |
| 2 | **4 botoes competindo sem hierarquia** | ALTA | Todos os botoes tem o mesmo peso visual. Nao ha CTA primario vs. secundario. O lead nao sabe o que clicar primeiro |
| 3 | **Imagem hero generica** | ALTA | "Especialistas CredPositivo" sem rostos identificaveis ou contexto que gere conexao |
| 4 | **Logo sem dimensoes padronizadas** | MEDIA | Logo referenciado como `logo.png` sem especificacoes de tamanho consistente |
| 5 | **Headline fraca visualmente** | MEDIA | "Descubra por que seu credito nao e aprovado" nao tem destaque tipografico suficiente |
| 6 | **Sem favicon ou meta tags visuais** | BAIXA | Compartilhamento em redes sociais sem preview visual (Open Graph) |
| 7 | **Sem indicadores de seguranca** | ALTA | Pagina financeira sem selos, certificados ou indicacoes de protecao de dados |

---

### Landing Page Principal (credpositivo.com)

**Estrutura:** Layout de funil vertical com hero, comparativo Score vs Rating, depoimentos, FAQ e rodape. Estrutura persuasiva mais elaborada.

**Problemas encontrados:**

| # | Problema | Severidade | Detalhes |
|---|----------|-----------|---------|
| 1 | **Fotos de depoimentos sao stock (Unsplash)** | CRITICA | Tres depoimentos com "compra verificada" mas fotos claramente genericas. Qualquer lead atento percebe e perde confianca |
| 2 | **Botoes com links "#" (placeholder)** | CRITICA | "VER MEU RATING", "QUERO SABER MEU RATING" nao levam a lugar nenhum. CTAs quebrados = conversao zero |
| 3 | **CNPJ placeholder nos termos** | CRITICA | 00.000.000/0001-00 -- ilegalidade e destruicao imediata de credibilidade |
| 4 | **Multiplas variacoes de CTA** | MEDIA | "VER MEU RATING", "QUERO SABER MEU RATING", "QUERO DESCOBRIR MEU RATING" -- falta consistencia na copy dos botoes |
| 5 | **Tabela comparativa sem contexto visual** | MEDIA | Score vs Rating e o diferencial, mas o design da comparacao nao destaca suficientemente a proposta de valor |
| 6 | **Selo "100% Seguro e Criptografado" sem certificado real** | ALTA | Selos de seguranca auto-declarados sem link para certificadora geram mais desconfianca do que confianca |
| 7 | **Rating 3.0 / Classificacao A no hero** | MEDIA | Dashboard mockup no hero e bom conceito, mas precisa parecer mais real e tangivel |
| 8 | **Navegacao duplicada mobile/desktop** | BAIXA | Dois menus renderizados simultaneamente |

---

### Pagina de Cadastro (/cadastro)

**Estrutura:** Layout centrado com formulario de 6 campos, fundo escuro (#050505), max-width 450px.

**Problemas encontrados:**

| # | Problema | Severidade | Detalhes |
|---|----------|-----------|---------|
| 1 | **Fundo escuro (#050505) destoa do site** | ALTA | Restante do site usa fundos claros. Transicao abrupta gera sensacao de "outro site" |
| 2 | **Pede CPF logo no cadastro** | ALTA | Dado extremamente sensivel pedido antes de qualquer entrega de valor. Gera barreira de confianca |
| 3 | **Sem indicadores visuais de seguranca** | ALTA | Formulario pedindo CPF sem selos de seguranca, criptografia ou LGPD visivel |
| 4 | **Sem feedback visual de validacao** | MEDIA | Campos nao mostram estados de erro/sucesso com estilo adequado |
| 5 | **Links "Termos de Uso" e "Politica de Privacidade" com paths relativos** | MEDIA | `../terms.html` pode quebrar. Links legais precisam funcionar sempre |
| 6 | **Tipografia e espacamento desconectados** | MEDIA | Formulario segue padroes visuais proprios, sem conexao com o design da landing page |

---

### Pagina de Login (/login)

**Estrutura:** Layout fullscreen centralizado com flexbox, campos de CPF/Email e senha.

**Problemas encontrados:**

| # | Problema | Severidade | Detalhes |
|---|----------|-----------|---------|
| 1 | **Logo com dimensao fixa (height: 50px)** | BAIXA | Sem responsividade na logo |
| 2 | **Icones sem labels acessiveis** | MEDIA | Tags `<i>` sem aria-label ou alt text |
| 3 | **Sem CAPTCHA ou protecao anti-bot** | ALTA | Formulario de login financeiro sem camada de protecao |
| 4 | **Dashboard destino retorna 404** | CRITICA | Login funciona mas leva a lugar nenhum -- experiencia completamente quebrada |
| 5 | **Uso de CSS variables** | POSITIVO | Unica pagina que usa variaveis CSS (`--color-primary`, etc.), indicando tentativa de sistematizacao |

---

### Dashboard (404)

**Status:** Pagina nao existe. Retorna erro 404.

**Impacto:** Todo o fluxo pos-login esta completamente quebrado. Cliente que se cadastra e faz login chega a uma pagina de erro. Isso e devastador para a confianca, especialmente em um servico financeiro.

O briefing menciona "sidebar nao-funcional" no dashboard -- mas atualmente nem a pagina carrega.

---

## Auditoria da Marca / Instagram

### Presenca no Instagram (@_credpositivo)

Nao foi possivel acessar o conteudo visual do feed do Instagram via ferramenta automatizada (Instagram bloqueia scraping). Com base nas informacoes do contexto e na analise da pagina bio:

**Observacoes:**

| Aspecto | Avaliacao |
|---------|-----------|
| **Handle** | @_credpositivo -- o underscore inicial nao e ideal (mais dificil de encontrar em buscas) |
| **Link na bio** | credpositivo.com/bio -- correto, direciona para hub de links |
| **Continuidade visual Instagram → Site** | FRACA -- pagina bio nao reforca a credibilidade que o conteudo do Instagram constroi |
| **Paleta de cores consistente** | Nao verificavel, mas o site usa azul + tons neutros |
| **Tom de voz** | Proposta de ser "especialista acessivel, educativo" -- precisa se refletir na tipografia e visual |

**Recomendacoes para alinhamento marca/Instagram:**
- Pagina bio deve ter a mesma energia visual dos posts (cores, tipografia, elementos graficos)
- Incluir foto real do especialista/fundador na bio para continuidade
- Usar as mesmas cores dos posts nos botoes da bio
- Adicionar numero de clientes/resultados na bio como prova social imediata

---

## Problemas de Confianca Visual

A confianca visual e o fator mais critico para um servico financeiro. Abaixo, os problemas ordenados por impacto na percepcao de legitimidade:

### Nivel Critico (lead desiste imediatamente)

1. **CNPJ falso nos termos de uso** -- Qualquer lead que clique nos termos ve 00.000.000/0001-00 e associa a golpe
2. **Dashboard 404** -- Cliente cadastrado chega a pagina de erro. Impossivel confiar
3. **CTAs da landing page quebrados** -- Botoes nao levam a lugar nenhum. Promessa sem entrega
4. **Fotos stock nos depoimentos** -- "Compra verificada" com fotos do Unsplash e contraditorio

### Nivel Alto (lead fica desconfiado)

5. **Sem rosto humano real** -- Nenhum fundador, especialista ou equipe visivel em nenhuma pagina
6. **Selos de seguranca auto-declarados** -- "100% Seguro e Criptografado" sem certificadora
7. **CPF pedido antes de qualquer valor entregue** -- Dado extremamente sensivel, barreira alta
8. **Inconsistencia visual entre paginas** -- Parece um conjunto de paginas de sites diferentes

### Nivel Medio (lead hesita)

9. **Sem endereco fisico ou CNPJ real** -- Servico financeiro "sem sede" gera duvida
10. **Sem precificacao visivel** -- Lead nao sabe se e gratis ou pago, desconfia de "taxa oculta"
11. **Conceito de "Rating Bancario" sem explicacao acessivel** -- Termo nao-padrao pode parecer inventado

---

## Mini Design System

### Paleta de Cores

Baseado na analise do site e na proposta da marca (azul + verde):

| Funcao | Cor | Hex | Uso |
|--------|-----|-----|-----|
| **Primaria** | Azul escuro | `#1A3A5C` | Headers, textos principais, elementos de autoridade |
| **Primaria clara** | Azul medio | `#2E6BA6` | Botoes primarios, links, CTAs principais |
| **Primaria hover** | Azul vivo | `#1E7FD9` | Estado hover de botoes e links |
| **Secundaria** | Verde confianca | `#28A745` | Indicadores positivos, selos, verificacoes, sucesso |
| **Secundaria clara** | Verde suave | `#D4EDDA` | Backgrounds de alertas positivos, tags de beneficio |
| **Acento** | Azul claro | `#E8F4FD` | Backgrounds de secoes, cards, destaques suaves |
| **Neutro escuro** | Cinza titulo | `#1A1A2E` | Titulos e textos de destaque |
| **Neutro medio** | Cinza corpo | `#4A4A5A` | Texto corpo, paragrafos |
| **Neutro claro** | Cinza auxiliar | `#8A8A9A` | Textos secundarios, placeholders |
| **Fundo principal** | Branco | `#FFFFFF` | Fundo padrao de todas as paginas |
| **Fundo secao** | Cinza gelo | `#F5F7FA` | Background alternado de secoes |
| **Erro** | Vermelho | `#DC3545` | Mensagens de erro, alertas negativos |
| **Alerta** | Amarelo | `#FFC107` | Avisos, atencao necessaria |
| **Borda** | Cinza borda | `#E0E0E0` | Bordas de inputs, cards, divisores |

### Tipografia

| Elemento | Fonte | Peso | Tamanho | Line-height |
|----------|-------|------|---------|-------------|
| **H1 (Hero)** | Inter ou Poppins | Bold (700) | 36px / 2.25rem | 1.2 |
| **H2 (Secao)** | Inter ou Poppins | Semi-bold (600) | 28px / 1.75rem | 1.3 |
| **H3 (Subsecao)** | Inter ou Poppins | Semi-bold (600) | 22px / 1.375rem | 1.3 |
| **Body** | Inter | Regular (400) | 16px / 1rem | 1.6 |
| **Body small** | Inter | Regular (400) | 14px / 0.875rem | 1.5 |
| **Caption** | Inter | Regular (400) | 12px / 0.75rem | 1.4 |
| **Botao** | Inter | Semi-bold (600) | 16px / 1rem | 1 |
| **Label** | Inter | Medium (500) | 14px / 0.875rem | 1.4 |

**Nota:** Inter e gratuita (Google Fonts), altamente legivel em telas, e amplamente utilizada em fintechs. Poppins como alternativa para titulos traz um tom mais amigavel, alinhado com o posicionamento "especialista acessivel".

### Espacamentos

Sistema de 4px baseado em multiplos:

| Token | Valor | Uso |
|-------|-------|-----|
| `--space-xs` | 4px | Micro espacamentos, gaps internos |
| `--space-sm` | 8px | Padding interno de tags, badges |
| `--space-md` | 16px | Padding de inputs, gap entre elementos |
| `--space-lg` | 24px | Margem entre blocos, padding de cards |
| `--space-xl` | 32px | Separacao entre secoes menores |
| `--space-2xl` | 48px | Separacao entre secoes maiores |
| `--space-3xl` | 64px | Padding de secoes do layout |
| `--space-4xl` | 96px | Espaco entre blocos principais da pagina |

### Border Radius

| Token | Valor | Uso |
|-------|-------|-----|
| `--radius-sm` | 4px | Tags, badges |
| `--radius-md` | 8px | Inputs, botoes |
| `--radius-lg` | 12px | Cards, modais |
| `--radius-xl` | 16px | Cards de destaque |
| `--radius-full` | 9999px | Avatares, pills |

### Sombras

| Token | Valor | Uso |
|-------|-------|-----|
| `--shadow-sm` | `0 1px 3px rgba(0,0,0,0.08)` | Inputs em foco, elementos sutis |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,0.1)` | Cards, dropdowns |
| `--shadow-lg` | `0 8px 24px rgba(0,0,0,0.12)` | Modais, popovers |

### Componentes Padrao

#### Botao Primario
```css
.btn-primary {
  background-color: #2E6BA6;
  color: #FFFFFF;
  font-family: 'Inter', sans-serif;
  font-weight: 600;
  font-size: 16px;
  padding: 14px 28px;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.2s ease;
  width: 100%; /* full-width em mobile */
  max-width: 360px;
  text-align: center;
}
.btn-primary:hover {
  background-color: #1E7FD9;
}
```

#### Botao Secundario
```css
.btn-secondary {
  background-color: transparent;
  color: #2E6BA6;
  font-family: 'Inter', sans-serif;
  font-weight: 600;
  font-size: 16px;
  padding: 14px 28px;
  border: 2px solid #2E6BA6;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}
.btn-secondary:hover {
  background-color: #E8F4FD;
}
```

#### Botao WhatsApp (CTA de alta prioridade)
```css
.btn-whatsapp {
  background-color: #25D366;
  color: #FFFFFF;
  font-family: 'Inter', sans-serif;
  font-weight: 600;
  font-size: 16px;
  padding: 14px 28px;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
```

#### Card de Depoimento
```css
.testimonial-card {
  background: #FFFFFF;
  border: 1px solid #E0E0E0;
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}
.testimonial-card .avatar {
  width: 48px;
  height: 48px;
  border-radius: 9999px;
  object-fit: cover;
}
.testimonial-card .name {
  font-weight: 600;
  font-size: 16px;
  color: #1A1A2E;
}
.testimonial-card .text {
  font-size: 14px;
  color: #4A4A5A;
  line-height: 1.6;
}
```

#### Card de Servico (Bio)
```css
.service-card {
  background: #FFFFFF;
  border: 1px solid #E0E0E0;
  border-radius: 12px;
  padding: 16px 24px;
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  text-decoration: none;
  color: #1A1A2E;
}
.service-card:hover {
  border-color: #2E6BA6;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}
.service-card .icon {
  font-size: 20px;
  color: #2E6BA6;
}
.service-card .label {
  font-weight: 600;
  font-size: 16px;
}
```

#### Input de Formulario
```css
.form-input {
  width: 100%;
  padding: 14px 16px;
  font-family: 'Inter', sans-serif;
  font-size: 16px;
  color: #1A1A2E;
  background: #FFFFFF;
  border: 1px solid #E0E0E0;
  border-radius: 8px;
  transition: border-color 0.2s ease;
}
.form-input:focus {
  border-color: #2E6BA6;
  outline: none;
  box-shadow: 0 0 0 3px rgba(46,107,166,0.15);
}
.form-input::placeholder {
  color: #8A8A9A;
}
```

#### Badge de Confianca
```css
.trust-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #D4EDDA;
  color: #1A3A5C;
  font-size: 12px;
  font-weight: 500;
  padding: 6px 12px;
  border-radius: 4px;
}
```

### Breakpoints Responsivos

| Nome | Largura | Uso |
|------|---------|-----|
| Mobile | < 480px | Layout single-column, botoes full-width |
| Mobile large | 480-768px | Ajustes de espacamento |
| Tablet | 768-1024px | Grid de 2 colunas para cards |
| Desktop | > 1024px | Layout completo, max-width 1200px centralizado |

---

## Lista de Correcoes Prioritarias

Ordenada por impacto na confianca e conversao:

### Prioridade 1 -- CRITICA (impacto imediato na confianca)

| # | Correcao | Pagina | Justificativa |
|---|---------|--------|---------------|
| 1 | **Corrigir CNPJ nos termos de uso** | Landing page | CNPJ 00.000.000/0001-00 e ilegal e grita "golpe" para qualquer lead atento |
| 2 | **Consertar ou remover links para dashboard/cadastro/login** | Bio | Links para paginas quebradas destroem confianca. Remover ate funcionar |
| 3 | **Corrigir CTAs da landing page (links "#")** | Landing page | Botoes que nao funcionam = zero conversao. Direcionar para WhatsApp |
| 4 | **Substituir fotos stock por depoimentos reais** | Landing page | Fotos Unsplash com "compra verificada" e contraditorio e gera desconfianca |

### Prioridade 2 -- ALTA (impacto direto na conversao)

| # | Correcao | Pagina | Justificativa |
|---|---------|--------|---------------|
| 5 | **Adicionar prova social na pagina bio** | Bio | "15.000+ clientes" + 1 depoimento curto. Lead do Instagram precisa de validacao imediata |
| 6 | **Reduzir bio para 2 CTAs com hierarquia clara** | Bio | "Fazer Diagnostico" (primario) + "Falar com Especialista" (secundario). Menos opcoes = mais conversao |
| 7 | **Adicionar foto real do fundador/especialista** | Bio + Landing | Rosto humano real gera 4x mais confianca que ilustracoes genericas |
| 8 | **Unificar paleta visual entre todas as paginas** | Todas | Fundo escuro no cadastro vs. claro no resto gera sensacao de "site diferente" |
| 9 | **Adicionar selo LGPD real com link** | Cadastro | Formulario que pede CPF PRECISA de indicadores de protecao de dados |

### Prioridade 3 -- MEDIA (melhoria de experiencia)

| # | Correcao | Pagina | Justificativa |
|---|---------|--------|---------------|
| 10 | **Implementar design system unificado** | Todas | CSS variables, tipografia, cores e componentes consistentes |
| 11 | **Melhorar tabela Score vs Rating** | Landing page | Diferencial principal precisa de destaque visual mais forte |
| 12 | **Adicionar Open Graph tags** | Todas | Links compartilhados em redes sociais precisam de preview visual |
| 13 | **Corrigir acessibilidade (alt texts, labels)** | Todas | Imagens sem alt, icones sem labels, contraste nao verificado |
| 14 | **Adicionar estados de loading e feedback** | Cadastro, Login | Formularios sem feedback visual de sucesso/erro/carregando |

### Prioridade 4 -- ESTRUTURAL (requer desenvolvimento)

| # | Correcao | Pagina | Justificativa |
|---|---------|--------|---------------|
| 15 | **Reconstruir dashboard funcional** | Dashboard | Area do cliente e essencial para retencao e indicacoes |
| 16 | **Implementar sidebar do dashboard** | Dashboard | Navegacao lateral precisa funcionar para orientar o cliente |
| 17 | **Migrar cadastro para fundo claro** | Cadastro | Alinhar com identidade visual do restante do site |
| 18 | **Criar pagina de resultados do diagnostico** | Nova | CTA principal promete "ver rating" -- precisa entregar resultado visivel |

---

*Documento gerado como parte da Fase 1 de diagnostico do CredPositivo.*
