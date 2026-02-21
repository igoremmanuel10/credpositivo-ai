# Arquitetura e Infraestrutura - CredPositivo
## "Do nome sujo ao crédito aprovado"

**Data:** 14 de Fevereiro de 2026
**Versão:** 1.0
**Status:** Planejamento Técnico

---

## Sumário Executivo

Este documento apresenta a arquitetura completa do CredPositivo, unificando o site atual (HTML/CSS/JS + MariaDB), o agente de IA "Augusto" (Node.js + PostgreSQL) e os dashboards (admin + cliente) em uma infraestrutura otimizada na DigitalOcean.

**Objetivos principais:**
- ✅ Unificar bancos de dados (MariaDB + PostgreSQL → PostgreSQL único)
- ✅ Migrar de Hostinger para DigitalOcean com Docker
- ✅ Implementar gateway de pagamento (Mercado Pago + PIX)
- ✅ Criar dashboards funcionais (cliente + admin)
- ✅ Ecossistema de 6 agentes IA (consultor, follow-up, upsell, suporte, conteúdo, notificador)
- ✅ Otimizar custos operacionais
- ✅ Preparar para escala horizontal

**Custo mensal estimado:** ~USD $55-75/mês (detalhes na seção 11)

---

## 1. Visão Geral da Arquitetura

### Diagrama da Arquitetura Completa

```
┌─────────────────────────────────────────────────────────────────────┐
│                        INTERNET / CLIENTES                          │
└────────────┬────────────────────────────────────────┬───────────────┘
             │                                        │
             │ HTTPS                                  │ WhatsApp
             │                                        │
┌────────────▼────────────────────────────────────────▼───────────────┐
│                    DIGITALOCEAN DROPLET                             │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    NGINX (Reverse Proxy + SSL)                │  │
│  │               credpositivo.com.br (Let's Encrypt)             │  │
│  └─────┬──────────────────┬─────────────────┬──────────────┬─────┘  │
│        │                  │                 │              │        │
│  ┌─────▼─────┐     ┌─────▼─────┐    ┌──────▼──────┐ ┌────▼─────┐  │
│  │    WEB    │     │    API    │    │    AGENT    │ │ EVOLUTION│  │
│  │  Next.js  │     │  Express  │    │   Augusto   │ │   API    │  │
│  │  :3000    │     │   :3001   │    │   :3002     │ │  :8080   │  │
│  └───────────┘     └─────┬─────┘    └──────┬──────┘ └────┬─────┘  │
│                          │                  │             │        │
│                    ┌─────▼──────────────────▼─────────────▼─────┐  │
│                    │            REDIS (Cache + Queue)           │  │
│                    │                :6379                        │  │
│                    └─────┬──────────────────────────────────────┘  │
│                          │                                         │
│                    ┌─────▼──────────────────────────────────────┐  │
│                    │        PostgreSQL (DB Unificado)           │  │
│                    │              :5432                          │  │
│                    │  - users, customers, orders, payments      │  │
│                    │  - conversations, messages, followups      │  │
│                    │  - admin_users, audit_events, tokens       │  │
│                    └────────────────────────────────────────────┘  │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    WORKER (Background Jobs)                   │  │
│  │         - Follow-ups agendados                                │  │
│  │         - Processamento de webhooks                           │  │
│  │         - Envio de emails/notificações                        │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                               │
                               │ HTTPS
                               ▼
                    ┌──────────────────────┐
                    │  SERVIÇOS EXTERNOS   │
                    │  - Mercado Pago API  │
                    │  - Claude API        │
                    │  - Evolution API     │
                    └──────────────────────┘
```

### Fluxo de Dados Principal

1. **Cliente acessa site** → Nginx → Next.js (web) → API → PostgreSQL
2. **Cliente compra produto** → API → Mercado Pago → Webhook → API → Agent (notifica via WhatsApp)
3. **Cliente conversa WhatsApp** → Evolution API → Agent (Augusto) → Claude API → Agent → Evolution API
4. **Admin gerencia** → Next.js (admin) → API → PostgreSQL

---

## 2. Organização dos Serviços (Monorepo)

### Estrutura Completa do Projeto

```
credpositivo/
├── README.md
├── package.json (workspaces)
├── .gitignore
├── .env.example
├── .env.local
├── .env.production
│
├── services/
│   ├── api/                          # Backend Principal (Express/Fastify)
│   │   ├── src/
│   │   │   ├── index.ts              # Entry point
│   │   │   ├── server.ts             # Express/Fastify setup
│   │   │   ├── routes/
│   │   │   │   ├── auth.routes.ts    # POST /auth/register, /auth/login
│   │   │   │   ├── products.routes.ts # GET /products
│   │   │   │   ├── orders.routes.ts  # POST /orders, GET /orders/:id
│   │   │   │   ├── payments.routes.ts # POST /payments/checkout
│   │   │   │   ├── webhooks.routes.ts # POST /webhooks/mercadopago
│   │   │   │   ├── admin.routes.ts   # GET /admin/customers, etc.
│   │   │   │   └── agent.routes.ts   # Internal: POST /agent/notify
│   │   │   ├── controllers/
│   │   │   ├── services/
│   │   │   │   ├── auth.service.ts
│   │   │   │   ├── payment.service.ts
│   │   │   │   ├── order.service.ts
│   │   │   │   └── mercadopago.service.ts
│   │   │   ├── middlewares/
│   │   │   │   ├── auth.middleware.ts
│   │   │   │   ├── ratelimit.middleware.ts
│   │   │   │   └── validation.middleware.ts
│   │   │   ├── utils/
│   │   │   └── types/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── Dockerfile
│   │
│   ├── agent/                        # Agente WhatsApp "Augusto"
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── server.ts
│   │   │   ├── handlers/
│   │   │   │   ├── message.handler.ts
│   │   │   │   ├── webhook.handler.ts
│   │   │   │   └── followup.handler.ts
│   │   │   ├── services/
│   │   │   │   ├── claude.service.ts
│   │   │   │   ├── evolution.service.ts
│   │   │   │   ├── conversation.service.ts
│   │   │   │   └── api.client.ts      # Comunica com /api
│   │   │   ├── prompts/
│   │   │   │   └── augusto.prompt.ts
│   │   │   └── utils/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── Dockerfile
│   │
│   ├── web/                          # Frontend Next.js
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx              # Landing page
│   │   │   ├── bio/
│   │   │   │   └── page.tsx
│   │   │   ├── login/
│   │   │   │   └── page.tsx
│   │   │   ├── cadastro/
│   │   │   │   └── page.tsx
│   │   │   ├── dashboard/            # Cliente autenticado
│   │   │   │   ├── layout.tsx
│   │   │   │   ├── page.tsx
│   │   │   │   ├── servicos/
│   │   │   │   ├── financeiro/
│   │   │   │   └── loja/
│   │   │   └── admin/                # Painel administrativo
│   │   │       ├── layout.tsx
│   │   │       ├── page.tsx
│   │   │       ├── clientes/
│   │   │       ├── pedidos/
│   │   │       ├── kanban/
│   │   │       └── metricas/
│   │   ├── components/
│   │   │   ├── ui/                   # Shadcn/ui components
│   │   │   ├── dashboard/
│   │   │   └── admin/
│   │   ├── lib/
│   │   │   ├── api-client.ts         # Fetch wrapper para /api
│   │   │   └── auth.ts               # Client-side auth helpers
│   │   ├── hooks/
│   │   ├── public/
│   │   ├── styles/
│   │   ├── package.json
│   │   ├── next.config.js
│   │   ├── tsconfig.json
│   │   └── Dockerfile
│   │
│   └── worker/                       # Background Jobs
│       ├── src/
│       │   ├── index.ts
│       │   ├── queues/
│       │   │   ├── followup.queue.ts
│       │   │   ├── webhook.queue.ts
│       │   │   └── email.queue.ts
│       │   ├── jobs/
│       │   │   ├── send-followup.job.ts
│       │   │   ├── process-webhook.job.ts
│       │   │   └── send-email.job.ts
│       │   └── utils/
│       ├── package.json
│       ├── tsconfig.json
│       └── Dockerfile
│
├── packages/
│   ├── database/                     # Prisma Schema + Migrations
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   ├── migrations/
│   │   │   └── seed.ts
│   │   ├── src/
│   │   │   ├── index.ts              # Export Prisma client
│   │   │   └── types.ts              # Generated types
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── shared/                       # Código compartilhado
│       ├── src/
│       │   ├── constants/
│       │   │   ├── products.ts       # Diagnóstico, Limpa Nome, Rating
│       │   │   └── status.ts         # Order status, payment status
│       │   ├── types/
│       │   │   ├── user.types.ts
│       │   │   ├── order.types.ts
│       │   │   └── payment.types.ts
│       │   ├── utils/
│       │   │   ├── validators.ts     # CPF, email, phone validation
│       │   │   ├── formatters.ts
│       │   │   └── crypto.ts
│       │   └── index.ts
│       ├── package.json
│       └── tsconfig.json
│
├── infra/
│   ├── docker-compose.yml            # Desenvolvimento local
│   ├── docker-compose.prod.yml       # Produção
│   ├── nginx/
│   │   ├── nginx.conf
│   │   ├── conf.d/
│   │   │   ├── credpositivo.conf
│   │   │   └── ssl.conf
│   │   └── Dockerfile
│   ├── scripts/
│   │   ├── deploy.sh
│   │   ├── backup.sh
│   │   ├── migrate.sh
│   │   └── health-check.sh
│   └── terraform/                    # Opcional: IaC para DigitalOcean
│       ├── main.tf
│       └── variables.tf
│
├── .github/
│   └── workflows/
│       ├── ci.yml                    # Testes
│       └── deploy.yml                # Deploy automático
│
└── docs/
    ├── api/
    │   └── openapi.yaml              # Spec OpenAPI 3.0
    ├── architecture.md
    └── deployment.md
```

### Justificativa do Monorepo

- **Compartilhamento de código:** Types, utils, validações usadas por todos os serviços
- **Versionamento unificado:** Deploy coordenado de mudanças
- **Developer Experience:** Única instalação de dependências, único repo para clonar
- **Ferramentas:** Turborepo ou pnpm workspaces para builds rápidos

---

## 3. Infraestrutura DigitalOcean

### Comparação de Opções

| Opção | Prós | Contras | Custo/mês |
|-------|------|---------|-----------|
| **Droplet + Docker Compose** ✅ | Controle total, mais barato, flexível | Requer configuração manual | $24-48 |
| App Platform | Fácil deploy, auto-scaling | Mais caro, menos controle | $100+ |
| Kubernetes (DOKS) | Alta escala, orquestração avançada | Complexo, caro para startup | $120+ |

### Recomendação: Droplet + Docker Compose

**Para a fase atual (< 1000 usuários), recomendo:**

- **Droplet:** Premium Intel 4GB RAM / 2 vCPUs / 80GB SSD - **$24/mês**
- **Região:** São Paulo (SAMP1) - menor latência para Brasil
- **OS:** Ubuntu 22.04 LTS
- **Volumes:** 50GB para backups de banco - **$5/mês**

**Por quê?**
- Custo 4x menor que App Platform
- Suficiente para 1000+ usuários simultâneos
- Fácil upgrade vertical quando necessário
- Controle total sobre Docker, nginx, SSL

### Upgrade Path (quando necessário)

```
Fase 1: Droplet 4GB ($24/mês) → até 1k usuários
Fase 2: Droplet 8GB ($48/mês) → até 5k usuários
Fase 3: Multi-droplet + Load Balancer ($24 + $24 + $12 = $60/mês) → 10k+ usuários
Fase 4: Kubernetes ou App Platform → 50k+ usuários
```

### Configuração do Droplet

```bash
# 1. Criar droplet via CLI
doctl compute droplet create credpositivo-prod \
  --region samp1 \
  --size s-2vcpu-4gb \
  --image ubuntu-22-04-x64 \
  --ssh-keys <YOUR_SSH_KEY_ID>

# 2. Conectar e configurar
ssh root@<DROPLET_IP>

# 3. Instalar Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# 4. Instalar Docker Compose
apt-get update
apt-get install -y docker-compose-plugin

# 5. Configurar firewall
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS
ufw enable

# 6. Criar diretórios
mkdir -p /opt/credpositivo/{data,logs,backups}
```

---

## 4. Banco de Dados Unificado

### Migração: MariaDB + PostgreSQL → PostgreSQL Único

**Estado atual:**
- MariaDB (Hostinger): admin_users, customers, orders, tokens, audit_events, users
- PostgreSQL (Docker): conversations, messages, followups

**Estratégia de migração:**
1. Export MariaDB → SQL dump
2. Converter MySQL SQL → PostgreSQL SQL
3. Import no PostgreSQL unificado
4. Rodar migrations para normalizar schema
5. Validar dados migrados
6. Cutover (swap connection strings)

### Schema PostgreSQL Completo (Prisma)

```prisma
// packages/database/prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ========================================
// AUTENTICAÇÃO E USUÁRIOS
// ========================================

model User {
  id            String    @id @default(cuid())
  email         String    @unique
  phone         String?   @unique
  passwordHash  String    @map("password_hash")
  name          String
  cpf           String    @unique // CPF brasileiro (11 dígitos)
  role          UserRole  @default(CLIENT)

  emailVerified Boolean   @default(false) @map("email_verified")
  phoneVerified Boolean   @default(false) @map("phone_verified")

  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")
  deletedAt     DateTime? @map("deleted_at")

  // Relações
  customer      Customer?
  orders        Order[]
  auditEvents   AuditEvent[]
  tokens        Token[]

  @@index([email])
  @@index([cpf])
  @@index([phone])
  @@map("users")
}

enum UserRole {
  CLIENT      // Cliente comum
  ADMIN       // Administrador
  SUPER_ADMIN // Super administrador
}

model Customer {
  id              String    @id @default(cuid())
  userId          String    @unique @map("user_id")
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  // Dados pessoais
  cpf             String    @unique
  fullName        String    @map("full_name")
  birthDate       DateTime? @map("birth_date")
  phone           String
  whatsappPhone   String?   @map("whatsapp_phone")

  // Endereço
  address         String?
  city            String?
  state           String?
  zipCode         String?   @map("zip_code")

  // Dados financeiros
  monthlyIncome   Decimal?  @map("monthly_income") @db.Decimal(10, 2)
  employmentStatus String?  @map("employment_status")

  // Análise de crédito
  creditScore     Int?      @map("credit_score")
  hasNegativeName Boolean   @default(false) @map("has_negative_name")

  // Metadata
  metadata        Json?     // Dados extras flexíveis

  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")

  // Relações
  conversations   Conversation[]
  orders          Order[]

  @@index([cpf])
  @@index([phone])
  @@map("customers")
}

// ========================================
// PRODUTOS E PEDIDOS
// ========================================

model Product {
  id          String   @id @default(cuid())
  name        String
  slug        String   @unique
  description String
  price       Decimal  @db.Decimal(10, 2)

  // Configuração
  active      Boolean  @default(true)
  features    Json     // Lista de features do produto

  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  // Relações
  orders      Order[]

  @@map("products")
}

model Order {
  id              String      @id @default(cuid())
  orderNumber     String      @unique @map("order_number") // ORD-2026-00001

  userId          String      @map("user_id")
  user            User        @relation(fields: [userId], references: [id])

  customerId      String      @map("customer_id")
  customer        Customer    @relation(fields: [customerId], references: [id])

  productId       String      @map("product_id")
  product         Product     @relation(fields: [productId], references: [id])

  // Valores
  amount          Decimal     @db.Decimal(10, 2)
  discount        Decimal?    @default(0) @db.Decimal(10, 2)
  total           Decimal     @db.Decimal(10, 2)

  // Status
  status          OrderStatus @default(PENDING)
  paymentStatus   PaymentStatus @default(PENDING) @map("payment_status")

  // Datas
  createdAt       DateTime    @default(now()) @map("created_at")
  updatedAt       DateTime    @updatedAt @map("updated_at")
  completedAt     DateTime?   @map("completed_at")
  cancelledAt     DateTime?   @map("cancelled_at")

  // Relações
  payment         Payment?

  @@index([userId])
  @@index([customerId])
  @@index([status])
  @@index([createdAt])
  @@map("orders")
}

enum OrderStatus {
  PENDING         // Aguardando pagamento
  PROCESSING      // Em processamento
  IN_PROGRESS     // Em andamento (serviço sendo executado)
  COMPLETED       // Concluído
  CANCELLED       // Cancelado
  REFUNDED        // Reembolsado
}

enum PaymentStatus {
  PENDING         // Aguardando
  PROCESSING      // Processando
  APPROVED        // Aprovado
  REJECTED        // Rejeitado
  REFUNDED        // Reembolsado
  CANCELLED       // Cancelado
}

// ========================================
// PAGAMENTOS
// ========================================

model Payment {
  id                String        @id @default(cuid())

  orderId           String        @unique @map("order_id")
  order             Order         @relation(fields: [orderId], references: [id])

  // Gateway
  gateway           PaymentGateway // MERCADOPAGO, STRIPE
  gatewayPaymentId  String?       @map("gateway_payment_id") // ID no gateway
  gatewayPreferenceId String?     @map("gateway_preference_id")

  // Método
  method            PaymentMethod

  // Valores
  amount            Decimal       @db.Decimal(10, 2)
  fee               Decimal?      @default(0) @db.Decimal(10, 2)
  netAmount         Decimal?      @map("net_amount") @db.Decimal(10, 2)

  // Status
  status            PaymentStatus @default(PENDING)

  // PIX específico
  pixQrCode         String?       @map("pix_qr_code")
  pixQrCodeBase64   String?       @map("pix_qr_code_base64")
  pixCopyPaste      String?       @map("pix_copy_paste")
  pixExpiresAt      DateTime?     @map("pix_expires_at")

  // Boleto específico
  boletoUrl         String?       @map("boleto_url")
  boletoBarcode     String?       @map("boleto_barcode")
  boletoExpiresAt   DateTime?     @map("boleto_expires_at")

  // Metadata
  metadata          Json?

  // Datas
  createdAt         DateTime      @default(now()) @map("created_at")
  updatedAt         DateTime      @updatedAt @map("updated_at")
  paidAt            DateTime?     @map("paid_at")

  @@index([orderId])
  @@index([gatewayPaymentId])
  @@index([status])
  @@map("payments")
}

enum PaymentGateway {
  MERCADOPAGO
  STRIPE
}

enum PaymentMethod {
  PIX
  CREDIT_CARD
  DEBIT_CARD
  BOLETO
  WALLET // Mercado Pago wallet, etc.
}

// ========================================
// AGENTE IA - CONVERSAS
// ========================================

model Conversation {
  id              String    @id @default(cuid())

  customerId      String    @map("customer_id")
  customer        Customer  @relation(fields: [customerId], references: [id])

  // WhatsApp
  whatsappNumber  String    @map("whatsapp_number")
  evolutionInstanceId String? @map("evolution_instance_id")

  // Estado
  status          ConversationStatus @default(ACTIVE)
  context         Json?     // Contexto da conversa (histórico resumido, variáveis)

  // Metadata
  lastMessageAt   DateTime? @map("last_message_at")

  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")
  closedAt        DateTime? @map("closed_at")

  // Relações
  messages        Message[]
  followups       Followup[]

  @@index([customerId])
  @@index([whatsappNumber])
  @@map("conversations")
}

enum ConversationStatus {
  ACTIVE
  WAITING
  CLOSED
}

model Message {
  id              String    @id @default(cuid())

  conversationId  String    @map("conversation_id")
  conversation    Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  // Origem
  direction       MessageDirection
  sender          String    // "customer" | "agent" | "system"

  // Conteúdo
  content         String    @db.Text
  contentType     String    @default("text") @map("content_type") // text, image, audio, document

  // IA
  claudeMessageId String?   @map("claude_message_id")
  tokensUsed      Int?      @map("tokens_used")

  // Metadata
  metadata        Json?

  createdAt       DateTime  @default(now()) @map("created_at")

  @@index([conversationId])
  @@index([createdAt])
  @@map("messages")
}

enum MessageDirection {
  INBOUND   // Cliente → Agent
  OUTBOUND  // Agent → Cliente
}

model Followup {
  id              String    @id @default(cuid())

  conversationId  String    @map("conversation_id")
  conversation    Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  // Agendamento
  scheduledFor    DateTime  @map("scheduled_for")
  message         String    @db.Text

  // Status
  status          FollowupStatus @default(PENDING)
  sentAt          DateTime? @map("sent_at")
  failedAt        DateTime? @map("failed_at")
  errorMessage    String?   @map("error_message")

  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")

  @@index([conversationId])
  @@index([scheduledFor])
  @@index([status])
  @@map("followups")
}

enum FollowupStatus {
  PENDING
  SENT
  FAILED
  CANCELLED
}

// ========================================
// AUDITORIA E SEGURANÇA
// ========================================

model AuditEvent {
  id          String    @id @default(cuid())

  userId      String?   @map("user_id")
  user        User?     @relation(fields: [userId], references: [id])

  action      String    // "user.login", "order.created", "payment.approved"
  entity      String    // "User", "Order", "Payment"
  entityId    String?   @map("entity_id")

  metadata    Json?     // Dados extras do evento
  ipAddress   String?   @map("ip_address")
  userAgent   String?   @map("user_agent")

  createdAt   DateTime  @default(now()) @map("created_at")

  @@index([userId])
  @@index([action])
  @@index([createdAt])
  @@map("audit_events")
}

model Token {
  id          String    @id @default(cuid())

  userId      String    @map("user_id")
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  type        TokenType
  token       String    @unique

  expiresAt   DateTime  @map("expires_at")
  usedAt      DateTime? @map("used_at")

  createdAt   DateTime  @default(now()) @map("created_at")

  @@index([token])
  @@index([userId])
  @@map("tokens")
}

enum TokenType {
  EMAIL_VERIFICATION
  PASSWORD_RESET
  REFRESH_TOKEN
}
```

### Seeds Iniciais (Produtos)

```typescript
// packages/database/prisma/seed.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Produtos
  const diagnostico = await prisma.product.upsert({
    where: { slug: 'diagnostico' },
    update: {},
    create: {
      name: 'Diagnóstico de Crédito',
      slug: 'diagnostico',
      description: 'Análise completa do seu perfil de crédito com relatório detalhado',
      price: 97.00,
      active: true,
      features: [
        'Análise de score',
        'Identificação de pendências',
        'Plano de ação personalizado',
        'Suporte via WhatsApp'
      ]
    }
  });

  const limpaNome = await prisma.product.upsert({
    where: { slug: 'limpa-nome' },
    update: {},
    create: {
      name: 'Limpa Nome',
      slug: 'limpa-nome',
      description: 'Remoção de nome negativado + acesso a cartão de crédito parceiro',
      price: 600.00,
      active: true,
      features: [
        'Remoção de negativações',
        'Negociação com credores',
        'Cartão de crédito aprovado',
        'Acompanhamento até conclusão',
        'Suporte prioritário'
      ]
    }
  });

  const rating = await prisma.product.upsert({
    where: { slug: 'rating' },
    update: {},
    create: {
      name: 'Rating - Reconstrução de Perfil Bancário',
      slug: 'rating',
      description: 'Programa completo de reconstrução do seu perfil bancário (inclui diagnóstico)',
      price: 1200.00,
      active: true,
      features: [
        'Diagnóstico completo incluso',
        'Estratégia de reconstrução',
        'Aumento de score',
        'Acesso a linhas de crédito',
        'Acompanhamento por 6 meses',
        'Suporte VIP'
      ]
    }
  });

  console.log('✅ Produtos criados:', { diagnostico, limpaNome, rating });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

### Script de Migração MariaDB → PostgreSQL

```bash
# infra/scripts/migrate-mariadb-to-postgres.sh

#!/bin/bash
set -e

echo "=== Migração MariaDB → PostgreSQL ==="

# 1. Backup MariaDB
echo "1. Fazendo backup do MariaDB..."
mysqldump -h hostinger_host -u user -p db_name > /tmp/mariadb_backup.sql

# 2. Converter SQL
echo "2. Convertendo SQL para PostgreSQL..."
# Substituições comuns
sed -i 's/ENGINE=InnoDB//g' /tmp/mariadb_backup.sql
sed -i 's/AUTO_INCREMENT/SERIAL/g' /tmp/mariadb_backup.sql
sed -i 's/`//g' /tmp/mariadb_backup.sql

# 3. Import no PostgreSQL
echo "3. Importando para PostgreSQL..."
psql postgresql://user:pass@localhost:5432/credpositivo < /tmp/mariadb_backup.sql

# 4. Rodar migrations Prisma
echo "4. Aplicando schema Prisma..."
cd packages/database
npx prisma migrate deploy

echo "✅ Migração concluída!"
```

---

## 5. API Backend

### Estrutura de Rotas

```typescript
// services/api/src/routes/index.ts

import { Router } from 'express';
import authRoutes from './auth.routes';
import productsRoutes from './products.routes';
import ordersRoutes from './orders.routes';
import paymentsRoutes from './payments.routes';
import webhooksRoutes from './webhooks.routes';
import adminRoutes from './admin.routes';
import agentRoutes from './agent.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/products', productsRoutes);
router.use('/orders', ordersRoutes);
router.use('/payments', paymentsRoutes);
router.use('/webhooks', webhooksRoutes);
router.use('/admin', adminRoutes);
router.use('/agent', agentRoutes);

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;
```

### Rotas Detalhadas

#### 1. Autenticação (`/auth`)

```typescript
// services/api/src/routes/auth.routes.ts

/**
 * POST /auth/register
 * Body: { email, password, name, cpf, phone }
 * Response: { user, token }
 */

/**
 * POST /auth/login
 * Body: { email, password }
 * Response: { user, token, refreshToken }
 */

/**
 * POST /auth/refresh
 * Body: { refreshToken }
 * Response: { token }
 */

/**
 * POST /auth/forgot-password
 * Body: { email }
 * Response: { message }
 */

/**
 * POST /auth/reset-password
 * Body: { token, newPassword }
 * Response: { message }
 */

/**
 * POST /auth/verify-email
 * Body: { token }
 * Response: { message }
 */

/**
 * GET /auth/me
 * Headers: Authorization: Bearer <token>
 * Response: { user }
 */
```

#### 2. Produtos (`/products`)

```typescript
/**
 * GET /products
 * Query: ?active=true
 * Response: { products: Product[] }
 */

/**
 * GET /products/:slug
 * Response: { product: Product }
 */
```

#### 3. Pedidos (`/orders`)

```typescript
/**
 * POST /orders
 * Headers: Authorization: Bearer <token>
 * Body: { productId, customerId? }
 * Response: { order: Order }
 */

/**
 * GET /orders
 * Headers: Authorization: Bearer <token>
 * Query: ?status=PENDING&limit=10&offset=0
 * Response: { orders: Order[], total: number }
 */

/**
 * GET /orders/:id
 * Headers: Authorization: Bearer <token>
 * Response: { order: Order }
 */

/**
 * PATCH /orders/:id/status
 * Headers: Authorization: Bearer <token>
 * Body: { status: OrderStatus }
 * Response: { order: Order }
 */
```

#### 4. Pagamentos (`/payments`)

```typescript
/**
 * POST /payments/checkout
 * Headers: Authorization: Bearer <token>
 * Body: { orderId, method: "PIX" | "CREDIT_CARD" | "BOLETO" }
 * Response: { payment: Payment, checkoutUrl?: string }
 */

/**
 * GET /payments/:id
 * Headers: Authorization: Bearer <token>
 * Response: { payment: Payment }
 */

/**
 * GET /payments/:id/status
 * Headers: Authorization: Bearer <token>
 * Response: { status: PaymentStatus, paidAt?: string }
 */
```

#### 5. Webhooks (`/webhooks`)

```typescript
/**
 * POST /webhooks/mercadopago
 * Headers: x-signature (validação)
 * Body: MercadoPagoWebhook
 * Response: 200 OK
 */

/**
 * POST /webhooks/evolution
 * Body: EvolutionWebhook
 * Response: 200 OK
 */

/**
 * POST /webhooks/site-events
 * Body: { event: string, data: any }
 * Response: 200 OK
 */
```

#### 6. Admin (`/admin`)

```typescript
/**
 * GET /admin/customers
 * Headers: Authorization: Bearer <admin_token>
 * Query: ?search=cpf&limit=20&offset=0
 * Response: { customers: Customer[], total: number }
 */

/**
 * GET /admin/customers/:id
 * Response: { customer: Customer, orders: Order[] }
 */

/**
 * GET /admin/orders
 * Query: ?status=PENDING&startDate=2026-01-01&endDate=2026-12-31
 * Response: { orders: Order[], total: number }
 */

/**
 * GET /admin/metrics
 * Response: {
 *   totalRevenue: number,
 *   ordersCount: number,
 *   customersCount: number,
 *   conversionRate: number
 * }
 */

/**
 * GET /admin/kanban
 * Response: {
 *   pending: Order[],
 *   processing: Order[],
 *   inProgress: Order[],
 *   completed: Order[]
 * }
 */
```

#### 7. Agent (Internal) (`/agent`)

```typescript
/**
 * POST /agent/notify
 * Body: {
 *   event: "purchase_completed" | "signup_completed",
 *   customerId: string,
 *   metadata?: any
 * }
 * Response: 200 OK
 */

/**
 * GET /agent/conversations/:id
 * Response: { conversation: Conversation, messages: Message[] }
 */
```

### Middlewares

```typescript
// services/api/src/middlewares/auth.middleware.ts

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido' });
  }
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'ADMIN' && req.user?.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  next();
};
```

```typescript
// services/api/src/middlewares/ratelimit.middleware.ts

import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { createClient } from 'redis';

const redisClient = createClient({ url: process.env.REDIS_URL });

export const apiLimiter = rateLimit({
  store: new RedisStore({
    client: redisClient,
    prefix: 'rl:api:'
  }),
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // 100 requisições por IP
  message: 'Muitas requisições deste IP, tente novamente mais tarde'
});

export const authLimiter = rateLimit({
  store: new RedisStore({
    client: redisClient,
    prefix: 'rl:auth:'
  }),
  windowMs: 15 * 60 * 1000,
  max: 5, // 5 tentativas de login
  message: 'Muitas tentativas de login, tente novamente em 15 minutos'
});
```

```typescript
// services/api/src/middlewares/validation.middleware.ts

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

export const validate = (schema: z.ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Validação falhou',
          details: error.errors
        });
      }
      next(error);
    }
  };
};

// Exemplo de uso
export const registerSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(8, 'Senha deve ter no mínimo 8 caracteres'),
  name: z.string().min(3, 'Nome deve ter no mínimo 3 caracteres'),
  cpf: z.string().regex(/^\d{11}$/, 'CPF inválido (11 dígitos)'),
  phone: z.string().regex(/^\d{10,11}$/, 'Telefone inválido')
});
```

### Setup do Servidor

```typescript
// services/api/src/server.ts

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import routes from './routes';
import { apiLimiter } from './middlewares/ratelimit.middleware';

const app = express();

// Middlewares globais
app.use(helmet()); // Segurança
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true
}));
app.use(morgan('combined')); // Logs
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
app.use(apiLimiter);

// Rotas
app.use('/api', routes);

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);

  res.status(err.status || 500).json({
    error: err.message || 'Erro interno do servidor',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`🚀 API rodando na porta ${PORT}`);
});

export default app;
```

---

## 6. Gateway de Pagamento

### Recomendação: Mercado Pago (Principal) + Stripe (Opcional)

**Por que Mercado Pago?**
- Líder no Brasil
- Suporte nativo a PIX (essencial!)
- Taxas competitivas: 3.99% + R$0.40 por transação
- Boleto e cartões locais
- SDK em português
- Compliance com regulamentação brasileira

**Quando usar Stripe?**
- Expansão internacional futura
- Necessidade de features avançadas (assinaturas complexas)

### Integração Mercado Pago

#### 1. Instalação

```bash
cd services/api
npm install mercadopago
```

#### 2. Service de Pagamento

```typescript
// services/api/src/services/mercadopago.service.ts

import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { prisma } from '@credpositivo/database';

const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN!,
  options: { timeout: 5000 }
});

const preference = new Preference(client);
const paymentApi = new Payment(client);

export class MercadoPagoService {

  /**
   * Criar checkout PIX
   */
  async createPixCheckout(orderId: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { product: true, customer: true }
    });

    if (!order) throw new Error('Pedido não encontrado');

    const body = {
      items: [
        {
          id: order.product.id,
          title: order.product.name,
          description: order.product.description,
          quantity: 1,
          unit_price: Number(order.total),
          currency_id: 'BRL'
        }
      ],
      payer: {
        name: order.customer.fullName,
        email: order.customer.user.email,
        identification: {
          type: 'CPF',
          number: order.customer.cpf
        }
      },
      payment_methods: {
        excluded_payment_methods: [],
        excluded_payment_types: [
          { id: 'credit_card' },
          { id: 'debit_card' },
          { id: 'ticket' }
        ],
        installments: 1
      },
      back_urls: {
        success: `${process.env.FRONTEND_URL}/dashboard/pagamento/sucesso`,
        failure: `${process.env.FRONTEND_URL}/dashboard/pagamento/falha`,
        pending: `${process.env.FRONTEND_URL}/dashboard/pagamento/pendente`
      },
      auto_return: 'approved',
      notification_url: `${process.env.API_URL}/api/webhooks/mercadopago`,
      external_reference: order.id
    };

    const response = await preference.create({ body });

    // Salvar payment no banco
    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        gateway: 'MERCADOPAGO',
        gatewayPreferenceId: response.id,
        method: 'PIX',
        amount: order.total,
        status: 'PENDING'
      }
    });

    return {
      payment,
      checkoutUrl: response.init_point, // URL para redirecionar cliente
      pixQrCode: response.point_of_interaction?.transaction_data?.qr_code,
      pixQrCodeBase64: response.point_of_interaction?.transaction_data?.qr_code_base64,
      pixCopyPaste: response.point_of_interaction?.transaction_data?.qr_code
    };
  }

  /**
   * Criar checkout com cartão de crédito
   */
  async createCreditCardCheckout(orderId: string, installments: number = 1) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { product: true, customer: true }
    });

    if (!order) throw new Error('Pedido não encontrado');

    const body = {
      items: [
        {
          id: order.product.id,
          title: order.product.name,
          quantity: 1,
          unit_price: Number(order.total),
          currency_id: 'BRL'
        }
      ],
      payer: {
        name: order.customer.fullName,
        email: order.customer.user.email,
        identification: {
          type: 'CPF',
          number: order.customer.cpf
        }
      },
      payment_methods: {
        excluded_payment_types: [{ id: 'ticket' }],
        installments: installments
      },
      back_urls: {
        success: `${process.env.FRONTEND_URL}/dashboard/pagamento/sucesso`,
        failure: `${process.env.FRONTEND_URL}/dashboard/pagamento/falha`,
        pending: `${process.env.FRONTEND_URL}/dashboard/pagamento/pendente`
      },
      auto_return: 'approved',
      notification_url: `${process.env.API_URL}/api/webhooks/mercadopago`,
      external_reference: order.id
    };

    const response = await preference.create({ body });

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        gateway: 'MERCADOPAGO',
        gatewayPreferenceId: response.id,
        method: 'CREDIT_CARD',
        amount: order.total,
        status: 'PENDING'
      }
    });

    return {
      payment,
      checkoutUrl: response.init_point
    };
  }

  /**
   * Consultar status de pagamento
   */
  async getPaymentStatus(paymentId: string) {
    const payment = await paymentApi.get({ id: paymentId });
    return payment;
  }

  /**
   * Processar webhook
   */
  async processWebhook(data: any) {
    const { type, data: webhookData } = data;

    if (type === 'payment') {
      const paymentId = webhookData.id;
      const mpPayment = await this.getPaymentStatus(paymentId);

      // Buscar payment no banco pelo external_reference (orderId)
      const order = await prisma.order.findUnique({
        where: { id: mpPayment.external_reference }
      });

      if (!order) {
        console.error('Order não encontrado:', mpPayment.external_reference);
        return;
      }

      const payment = await prisma.payment.findUnique({
        where: { orderId: order.id }
      });

      if (!payment) {
        console.error('Payment não encontrado para order:', order.id);
        return;
      }

      // Atualizar status do pagamento
      let newStatus: PaymentStatus = 'PENDING';

      switch (mpPayment.status) {
        case 'approved':
          newStatus = 'APPROVED';
          break;
        case 'rejected':
        case 'cancelled':
          newStatus = 'REJECTED';
          break;
        case 'refunded':
          newStatus = 'REFUNDED';
          break;
        case 'in_process':
        case 'in_mediation':
          newStatus = 'PROCESSING';
          break;
      }

      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: newStatus,
          gatewayPaymentId: paymentId.toString(),
          paidAt: newStatus === 'APPROVED' ? new Date() : null,
          metadata: mpPayment
        }
      });

      // Atualizar order
      if (newStatus === 'APPROVED') {
        await prisma.order.update({
          where: { id: order.id },
          data: {
            paymentStatus: 'APPROVED',
            status: 'PROCESSING'
          }
        });

        // Notificar agente AI
        await this.notifyAgent('purchase_completed', order.customerId, {
          orderId: order.id,
          productName: order.product.name,
          amount: order.total
        });
      } else if (newStatus === 'REJECTED') {
        await prisma.order.update({
          where: { id: order.id },
          data: {
            paymentStatus: 'REJECTED',
            status: 'CANCELLED'
          }
        });
      }
    }
  }

  /**
   * Notificar agente AI sobre evento
   */
  private async notifyAgent(event: string, customerId: string, metadata: any) {
    try {
      await fetch(`${process.env.AGENT_URL}/webhooks/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, customerId, metadata })
      });
    } catch (error) {
      console.error('Erro ao notificar agent:', error);
    }
  }
}

export const mercadoPagoService = new MercadoPagoService();
```

#### 3. Rota de Webhook

```typescript
// services/api/src/routes/webhooks.routes.ts

import { Router } from 'express';
import { mercadoPagoService } from '../services/mercadopago.service';
import crypto from 'crypto';

const router = Router();

router.post('/mercadopago', async (req, res) => {
  try {
    // Validar assinatura (segurança)
    const xSignature = req.headers['x-signature'] as string;
    const xRequestId = req.headers['x-request-id'] as string;

    // Opcional: validar assinatura conforme docs do Mercado Pago
    // https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks

    await mercadoPagoService.processWebhook(req.body);

    res.status(200).send('OK');
  } catch (error) {
    console.error('Erro ao processar webhook Mercado Pago:', error);
    res.status(500).send('Error');
  }
});

export default router;
```

### Fluxo Completo de Pagamento

```
1. Cliente seleciona produto no dashboard
   ↓
2. Frontend: POST /api/orders { productId }
   ↓
3. API cria Order com status PENDING
   ↓
4. Frontend: POST /api/payments/checkout { orderId, method: "PIX" }
   ↓
5. API chama MercadoPago.createPixCheckout()
   ↓
6. MercadoPago retorna: QR Code PIX, checkoutUrl
   ↓
7. Frontend exibe QR Code ou redireciona para checkoutUrl
   ↓
8. Cliente paga via PIX (instantâneo)
   ↓
9. MercadoPago envia webhook para /api/webhooks/mercadopago
   ↓
10. API processa webhook:
    - Atualiza Payment.status = APPROVED
    - Atualiza Order.paymentStatus = APPROVED
    - Atualiza Order.status = PROCESSING
    ↓
11. API notifica Agent: POST /agent/webhooks/internal
    { event: "purchase_completed", customerId, metadata }
    ↓
12. Agent envia WhatsApp: "Seu pagamento foi confirmado! Em breve
    iniciaremos seu [produto]. Dúvidas? Fale comigo!"
```

---

## 7. Dashboard (Frontend)

### Recomendação: Next.js 14+ (App Router) + Tailwind CSS + shadcn/ui

**Stack:**
- Next.js 14+ (SSR, API routes, Server Components)
- TypeScript
- Tailwind CSS (estilização)
- shadcn/ui (componentes prontos e customizáveis)
- React Hook Form + Zod (formulários)
- TanStack Query (cache de API)
- Zustand (state management leve)

### Estrutura de Páginas

```
app/
├── layout.tsx                    # Layout global
├── page.tsx                      # Landing page (/)
├── bio/
│   └── page.tsx                  # Página /bio
├── login/
│   └── page.tsx                  # Login
├── cadastro/
│   └── page.tsx                  # Registro
│
├── dashboard/                    # CLIENTE AUTENTICADO
│   ├── layout.tsx                # Layout do dashboard (sidebar, header)
│   ├── page.tsx                  # Overview (/dashboard)
│   ├── servicos/
│   │   └── page.tsx              # Meus serviços contratados
│   ├── financeiro/
│   │   └── page.tsx              # Histórico de pagamentos
│   └── loja/
│       └── page.tsx              # Loja de produtos
│       └── [slug]/
│           └── page.tsx          # Detalhes do produto
│           └── checkout/
│               └── page.tsx      # Checkout
│
└── admin/                        # ADMIN AUTENTICADO
    ├── layout.tsx                # Layout admin
    ├── page.tsx                  # Dashboard admin (/admin)
    ├── clientes/
    │   ├── page.tsx              # Lista de clientes
    │   └── [id]/
    │       └── page.tsx          # Detalhes do cliente
    ├── pedidos/
    │   ├── page.tsx              # Lista de pedidos
    │   └── [id]/
    │       └── page.tsx          # Detalhes do pedido
    ├── kanban/
    │   └── page.tsx              # Kanban de pedidos
    └── metricas/
        └── page.tsx              # Métricas e analytics
```

### Autenticação (JWT + httpOnly Cookies)

```typescript
// app/lib/auth.ts (Client-side)

import { jwtDecode } from 'jwt-decode';

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'CLIENT' | 'ADMIN' | 'SUPER_ADMIN';
}

export async function login(email: string, password: string) {
  const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    credentials: 'include' // Envia cookies
  });

  if (!response.ok) {
    throw new Error('Credenciais inválidas');
  }

  const data = await response.json();

  // Salvar token no localStorage (ou sessionStorage)
  localStorage.setItem('token', data.token);
  localStorage.setItem('user', JSON.stringify(data.user));

  return data.user;
}

export async function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = '/login';
}

export function getToken(): string | null {
  return localStorage.getItem('token');
}

export function getUser(): User | null {
  const userStr = localStorage.getItem('user');
  return userStr ? JSON.parse(userStr) : null;
}

export function isAuthenticated(): boolean {
  const token = getToken();
  if (!token) return false;

  try {
    const decoded: any = jwtDecode(token);
    return decoded.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}
```

```typescript
// app/lib/api-client.ts (Fetch wrapper)

const API_URL = process.env.NEXT_PUBLIC_API_URL;

export async function apiClient(endpoint: string, options: RequestInit = {}) {
  const token = localStorage.getItem('token');

  const headers = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
    ...options.headers
  };

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers
  });

  if (response.status === 401) {
    // Token expirado, redirecionar para login
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
    throw new Error('Sessão expirada');
  }

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Erro na requisição');
  }

  return response.json();
}
```

### Exemplo: Página de Checkout

```typescript
// app/dashboard/loja/[slug]/checkout/page.tsx

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';

interface Product {
  id: string;
  name: string;
  price: number;
  description: string;
}

export default function CheckoutPage({ params }: { params: { slug: string } }) {
  const router = useRouter();
  const [paymentMethod, setPaymentMethod] = useState<'PIX' | 'CREDIT_CARD'>('PIX');

  // Buscar produto
  const { data: product, isLoading } = useQuery<Product>({
    queryKey: ['product', params.slug],
    queryFn: () => apiClient(`/api/products/${params.slug}`)
  });

  // Criar pedido + checkout
  const checkoutMutation = useMutation({
    mutationFn: async () => {
      // 1. Criar order
      const orderResponse = await apiClient('/api/orders', {
        method: 'POST',
        body: JSON.stringify({ productId: product!.id })
      });

      // 2. Criar checkout
      const checkoutResponse = await apiClient('/api/payments/checkout', {
        method: 'POST',
        body: JSON.stringify({
          orderId: orderResponse.order.id,
          method: paymentMethod
        })
      });

      return checkoutResponse;
    },
    onSuccess: (data) => {
      if (paymentMethod === 'PIX') {
        // Exibir QR Code em modal
        router.push(`/dashboard/pagamento/pix?paymentId=${data.payment.id}`);
      } else {
        // Redirecionar para checkout Mercado Pago
        window.location.href = data.checkoutUrl;
      }
    }
  });

  if (isLoading) {
    return <div>Carregando...</div>;
  }

  if (!product) {
    return <div>Produto não encontrado</div>;
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Finalizar Compra</h1>

      {/* Resumo do produto */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-xl font-semibold mb-2">{product.name}</h2>
        <p className="text-gray-600 mb-4">{product.description}</p>
        <div className="text-3xl font-bold text-green-600">
          R$ {product.price.toFixed(2)}
        </div>
      </div>

      {/* Método de pagamento */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h3 className="text-lg font-semibold mb-4">Método de Pagamento</h3>

        <RadioGroup value={paymentMethod} onValueChange={(v: any) => setPaymentMethod(v)}>
          <div className="flex items-center space-x-2 mb-3">
            <RadioGroupItem value="PIX" id="pix" />
            <Label htmlFor="pix" className="cursor-pointer">
              PIX (Aprovação instantânea)
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="CREDIT_CARD" id="card" />
            <Label htmlFor="card" className="cursor-pointer">
              Cartão de Crédito (Parcelamento disponível)
            </Label>
          </div>
        </RadioGroup>
      </div>

      {/* Botão finalizar */}
      <Button
        onClick={() => checkoutMutation.mutate()}
        disabled={checkoutMutation.isPending}
        className="w-full"
        size="lg"
      >
        {checkoutMutation.isPending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Processando...
          </>
        ) : (
          `Pagar R$ ${product.price.toFixed(2)}`
        )}
      </Button>
    </div>
  );
}
```

### Exemplo: Página Admin - Kanban

```typescript
// app/admin/kanban/page.tsx

'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';

interface Order {
  id: string;
  orderNumber: string;
  customer: { fullName: string };
  product: { name: string };
  total: number;
  status: 'PENDING' | 'PROCESSING' | 'IN_PROGRESS' | 'COMPLETED';
}

export default function KanbanPage() {
  const { data, isLoading } = useQuery<{ [key: string]: Order[] }>({
    queryKey: ['admin-kanban'],
    queryFn: () => apiClient('/api/admin/kanban')
  });

  if (isLoading) return <div>Carregando...</div>;

  const columns = [
    { id: 'pending', title: 'Pendente', orders: data?.pending || [] },
    { id: 'processing', title: 'Processando', orders: data?.processing || [] },
    { id: 'inProgress', title: 'Em Andamento', orders: data?.inProgress || [] },
    { id: 'completed', title: 'Concluído', orders: data?.completed || [] }
  ];

  const handleDragEnd = async (result: any) => {
    // Implementar atualização de status via API
    const { draggableId, destination } = result;
    if (!destination) return;

    await apiClient(`/api/orders/${draggableId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: destination.droppableId.toUpperCase() })
    });
  };

  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold mb-6">Kanban de Pedidos</h1>

      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="grid grid-cols-4 gap-4">
          {columns.map((column) => (
            <div key={column.id} className="bg-gray-100 rounded-lg p-4">
              <h2 className="font-semibold mb-4">{column.title}</h2>

              <Droppable droppableId={column.id}>
                {(provided) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className="space-y-2"
                  >
                    {column.orders.map((order, index) => (
                      <Draggable key={order.id} draggableId={order.id} index={index}>
                        {(provided) => (
                          <div
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                            {...provided.dragHandleProps}
                            className="bg-white p-3 rounded shadow"
                          >
                            <div className="font-semibold">{order.orderNumber}</div>
                            <div className="text-sm text-gray-600">{order.customer.fullName}</div>
                            <div className="text-sm">{order.product.name}</div>
                            <div className="text-sm font-semibold text-green-600">
                              R$ {order.total}
                            </div>
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </div>
          ))}
        </div>
      </DragDropContext>
    </div>
  );
}
```

---

## 8. Integração AI Agent ↔ API

### Comunicação Bidirecional

```
API → Agent:
- Webhook interno quando eventos ocorrem (signup, purchase)
- Consulta de dados via endpoints internos

Agent → API:
- Buscar dados de clientes
- Criar/atualizar conversas
- Registrar follow-ups
```

### Webhooks Internos (API → Agent)

```typescript
// services/agent/src/server.ts

app.post('/webhooks/internal', async (req, res) => {
  const { event, customerId, metadata } = req.body;

  switch (event) {
    case 'signup_completed':
      await handleSignup(customerId);
      break;

    case 'purchase_completed':
      await handlePurchase(customerId, metadata);
      break;

    case 'payment_failed':
      await handlePaymentFailed(customerId, metadata);
      break;
  }

  res.status(200).send('OK');
});

async function handlePurchase(customerId: string, metadata: any) {
  const customer = await apiClient.get(`/api/admin/customers/${customerId}`);

  const message = `
Olá ${customer.fullName}! 🎉

Seu pagamento de R$ ${metadata.amount} foi confirmado com sucesso!

Produto contratado: *${metadata.productName}*

Vou iniciar seu atendimento agora mesmo. Em alguns instantes você receberá as próximas instruções.

Qualquer dúvida, estou à disposição!

Atenciosamente,
*Augusto* - CredPositivo
  `.trim();

  await evolutionService.sendMessage(customer.whatsappPhone, message);
}
```

### Client HTTP (Agent → API)

```typescript
// services/agent/src/services/api.client.ts

import { getToken } from './auth';

const API_URL = process.env.API_URL || 'http://api:3001';

class ApiClient {
  private async request(endpoint: string, options: RequestInit = {}) {
    const response = await fetch(`${API_URL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.AGENT_API_KEY}`, // Key interna
        ...options.headers
      }
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.statusText}`);
    }

    return response.json();
  }

  async getCustomer(customerId: string) {
    return this.request(`/api/admin/customers/${customerId}`);
  }

  async getCustomerByPhone(phone: string) {
    return this.request(`/api/admin/customers?phone=${phone}`);
  }

  async createConversation(customerId: string, whatsappNumber: string) {
    return this.request('/api/agent/conversations', {
      method: 'POST',
      body: JSON.stringify({ customerId, whatsappNumber })
    });
  }

  async addMessage(conversationId: string, content: string, direction: 'INBOUND' | 'OUTBOUND') {
    return this.request('/api/agent/messages', {
      method: 'POST',
      body: JSON.stringify({ conversationId, content, direction })
    });
  }

  async scheduleFollowup(conversationId: string, message: string, scheduledFor: Date) {
    return this.request('/api/agent/followups', {
      method: 'POST',
      body: JSON.stringify({ conversationId, message, scheduledFor })
    });
  }
}

export const apiClient = new ApiClient();
```

### Redis como Event Bus

```typescript
// packages/shared/src/redis-events.ts

import { createClient } from 'redis';

const redisClient = createClient({ url: process.env.REDIS_URL });

export class EventBus {

  async publish(channel: string, data: any) {
    await redisClient.publish(channel, JSON.stringify(data));
  }

  async subscribe(channel: string, handler: (data: any) => void) {
    const subscriber = redisClient.duplicate();
    await subscriber.connect();

    await subscriber.subscribe(channel, (message) => {
      const data = JSON.parse(message);
      handler(data);
    });
  }
}

// Uso no Agent
const eventBus = new EventBus();

eventBus.subscribe('orders:created', async (data) => {
  console.log('Novo pedido criado:', data.orderId);
  // Notificar cliente via WhatsApp
});

// Uso na API
await eventBus.publish('orders:created', { orderId: order.id, customerId: order.customerId });
```

---

## 9. Docker Compose Produção

### docker-compose.prod.yml Completo

```yaml
# infra/docker-compose.prod.yml

version: '3.9'

services:
  # ========================================
  # NGINX - Reverse Proxy + SSL
  # ========================================
  nginx:
    image: nginx:alpine
    container_name: credpositivo-nginx
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/conf.d:/etc/nginx/conf.d:ro
      - ./nginx/ssl:/etc/nginx/ssl:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
      - /var/lib/letsencrypt:/var/lib/letsencrypt:ro
    depends_on:
      - web
      - api
    networks:
      - credpositivo-network
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  # ========================================
  # WEB - Next.js Frontend
  # ========================================
  web:
    build:
      context: ../
      dockerfile: services/web/Dockerfile
    container_name: credpositivo-web
    restart: always
    environment:
      - NODE_ENV=production
      - NEXT_PUBLIC_API_URL=https://api.credpositivo.com.br
    networks:
      - credpositivo-network
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
        reservations:
          cpus: '0.25'
          memory: 256M

  # ========================================
  # API - Backend Principal
  # ========================================
  api:
    build:
      context: ../
      dockerfile: services/api/Dockerfile
    container_name: credpositivo-api
    restart: always
    environment:
      - NODE_ENV=production
      - PORT=3001
      - DATABASE_URL=postgresql://credpositivo:${DB_PASSWORD}@postgres:5432/credpositivo
      - REDIS_URL=redis://redis:6379
      - JWT_SECRET=${JWT_SECRET}
      - MERCADOPAGO_ACCESS_TOKEN=${MERCADOPAGO_ACCESS_TOKEN}
      - CLAUDE_API_KEY=${CLAUDE_API_KEY}
      - FRONTEND_URL=https://credpositivo.com.br
      - AGENT_URL=http://agent:3002
    depends_on:
      - postgres
      - redis
    networks:
      - credpositivo-network
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 1G
        reservations:
          cpus: '0.5'
          memory: 512M

  # ========================================
  # AGENT - WhatsApp AI "Augusto"
  # ========================================
  agent:
    build:
      context: ../
      dockerfile: services/agent/Dockerfile
    container_name: credpositivo-agent
    restart: always
    environment:
      - NODE_ENV=production
      - PORT=3002
      - DATABASE_URL=postgresql://credpositivo:${DB_PASSWORD}@postgres:5432/credpositivo
      - REDIS_URL=redis://redis:6379
      - CLAUDE_API_KEY=${CLAUDE_API_KEY}
      - EVOLUTION_API_URL=http://evolution-api:8080
      - EVOLUTION_API_KEY=${EVOLUTION_API_KEY}
      - API_URL=http://api:3001
      - AGENT_API_KEY=${AGENT_API_KEY}
    depends_on:
      - postgres
      - redis
      - evolution-api
    networks:
      - credpositivo-network
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3002/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    deploy:
      resources:
        limits:
          cpus: '0.75'
          memory: 768M
        reservations:
          cpus: '0.5'
          memory: 512M

  # ========================================
  # WORKER - Background Jobs
  # ========================================
  worker:
    build:
      context: ../
      dockerfile: services/worker/Dockerfile
    container_name: credpositivo-worker
    restart: always
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://credpositivo:${DB_PASSWORD}@postgres:5432/credpositivo
      - REDIS_URL=redis://redis:6379
      - API_URL=http://api:3001
    depends_on:
      - postgres
      - redis
    networks:
      - credpositivo-network
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
        reservations:
          cpus: '0.25'
          memory: 256M

  # ========================================
  # EVOLUTION API - WhatsApp Gateway
  # ========================================
  evolution-api:
    image: atendai/evolution-api:latest
    container_name: credpositivo-evolution
    restart: always
    ports:
      - "8080:8080"
    environment:
      - SERVER_URL=https://evolution.credpositivo.com.br
      - AUTHENTICATION_API_KEY=${EVOLUTION_API_KEY}
      - DATABASE_ENABLED=true
      - DATABASE_PROVIDER=postgresql
      - DATABASE_CONNECTION_URI=postgresql://credpositivo:${DB_PASSWORD}@postgres:5432/evolution
      - DATABASE_SAVE_DATA_INSTANCE=true
      - DATABASE_SAVE_DATA_NEW_MESSAGE=true
      - DATABASE_SAVE_MESSAGE_UPDATE=true
      - DATABASE_SAVE_DATA_CONTACTS=true
      - DATABASE_SAVE_DATA_CHATS=true
    volumes:
      - evolution-data:/evolution/instances
      - evolution-store:/evolution/store
    depends_on:
      - postgres
    networks:
      - credpositivo-network
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
        reservations:
          cpus: '0.25'
          memory: 256M

  # ========================================
  # POSTGRESQL - Banco de Dados Principal
  # ========================================
  postgres:
    image: postgres:15-alpine
    container_name: credpositivo-postgres
    restart: always
    environment:
      - POSTGRES_DB=credpositivo
      - POSTGRES_USER=credpositivo
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - PGDATA=/var/lib/postgresql/data/pgdata
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./postgres/init.sql:/docker-entrypoint-initdb.d/init.sql
    networks:
      - credpositivo-network
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U credpositivo"]
      interval: 10s
      timeout: 5s
      retries: 5
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 1G
        reservations:
          cpus: '0.5'
          memory: 512M

  # ========================================
  # REDIS - Cache + Queue
  # ========================================
  redis:
    image: redis:7-alpine
    container_name: credpositivo-redis
    restart: always
    command: redis-server --appendonly yes --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis-data:/data
    networks:
      - credpositivo-network
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 256M
        reservations:
          cpus: '0.25'
          memory: 128M

# ========================================
# VOLUMES
# ========================================
volumes:
  postgres-data:
    driver: local
  redis-data:
    driver: local
  evolution-data:
    driver: local
  evolution-store:
    driver: local

# ========================================
# NETWORKS
# ========================================
networks:
  credpositivo-network:
    driver: bridge
```

### Configuração Nginx

```nginx
# infra/nginx/conf.d/credpositivo.conf

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name credpositivo.com.br www.credpositivo.com.br;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS Server
server {
    listen 443 ssl http2;
    server_name credpositivo.com.br www.credpositivo.com.br;

    # SSL Certificates (Let's Encrypt)
    ssl_certificate /etc/letsencrypt/live/credpositivo.com.br/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/credpositivo.com.br/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Security Headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Logs
    access_log /var/log/nginx/credpositivo-access.log;
    error_log /var/log/nginx/credpositivo-error.log;

    # Max upload size
    client_max_body_size 10M;

    # API Routes
    location /api {
        proxy_pass http://api:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 60s;
    }

    # Next.js Frontend (SSR)
    location / {
        proxy_pass http://web:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}

# Evolution API (subdomain)
server {
    listen 443 ssl http2;
    server_name evolution.credpositivo.com.br;

    ssl_certificate /etc/letsencrypt/live/credpositivo.com.br/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/credpositivo.com.br/privkey.pem;

    location / {
        proxy_pass http://evolution-api:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Script de Deploy

```bash
# infra/scripts/deploy.sh

#!/bin/bash
set -e

echo "=== Deploy CredPositivo para Produção ==="

# Variáveis
DROPLET_IP="your_droplet_ip"
DEPLOY_USER="root"
DEPLOY_DIR="/opt/credpositivo"

echo "1. Copiando arquivos para droplet..."
rsync -avz --exclude 'node_modules' --exclude '.git' \
  ../ ${DEPLOY_USER}@${DROPLET_IP}:${DEPLOY_DIR}/

echo "2. Conectando ao droplet..."
ssh ${DEPLOY_USER}@${DROPLET_IP} << 'EOF'
  cd /opt/credpositivo

  echo "3. Parando containers..."
  cd infra
  docker-compose -f docker-compose.prod.yml down

  echo "4. Limpando imagens antigas..."
  docker system prune -af --volumes

  echo "5. Buildando novas imagens..."
  docker-compose -f docker-compose.prod.yml build

  echo "6. Subindo containers..."
  docker-compose -f docker-compose.prod.yml up -d

  echo "7. Rodando migrations..."
  docker exec credpositivo-api npx prisma migrate deploy

  echo "8. Verificando health..."
  sleep 10
  docker-compose -f docker-compose.prod.yml ps

  echo "✅ Deploy concluído!"
EOF
```

---

## 10. Deploy & CI/CD

### GitHub Actions

```yaml
# .github/workflows/deploy.yml

name: Deploy to Production

on:
  push:
    branches:
      - main

jobs:
  deploy:
    name: Deploy to DigitalOcean
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Setup SSH
        uses: webfactory/ssh-agent@v0.8.0
        with:
          ssh-private-key: ${{ secrets.DROPLET_SSH_KEY }}

      - name: Deploy to Droplet
        env:
          DROPLET_IP: ${{ secrets.DROPLET_IP }}
          DEPLOY_USER: root
        run: |
          # Adicionar host ao known_hosts
          ssh-keyscan -H $DROPLET_IP >> ~/.ssh/known_hosts

          # Rsync código
          rsync -avz --exclude 'node_modules' --exclude '.git' \
            ./ ${DEPLOY_USER}@${DROPLET_IP}:/opt/credpositivo/

          # Deploy
          ssh ${DEPLOY_USER}@${DROPLET_IP} << 'EOF'
            cd /opt/credpositivo/infra

            # Backup atual
            docker-compose -f docker-compose.prod.yml exec -T postgres \
              pg_dump -U credpositivo credpositivo > /opt/credpositivo/backups/backup-$(date +%Y%m%d-%H%M%S).sql

            # Build e deploy com zero downtime
            docker-compose -f docker-compose.prod.yml build
            docker-compose -f docker-compose.prod.yml up -d --no-deps --build api web agent

            # Migrations
            docker exec credpositivo-api npx prisma migrate deploy

            # Health check
            sleep 10
            curl -f http://localhost/api/health || exit 1
          EOF

      - name: Notify Deployment
        if: success()
        run: echo "✅ Deploy realizado com sucesso!"
```

### Estratégia Zero-Downtime

```bash
# infra/scripts/zero-downtime-deploy.sh

#!/bin/bash
set -e

SERVICE=$1

if [ -z "$SERVICE" ]; then
  echo "Uso: ./zero-downtime-deploy.sh <api|web|agent>"
  exit 1
fi

echo "=== Deploy Zero-Downtime: $SERVICE ==="

# 1. Build nova imagem
docker-compose -f docker-compose.prod.yml build $SERVICE

# 2. Scale up (2 instâncias)
docker-compose -f docker-compose.prod.yml up -d --scale $SERVICE=2 --no-recreate

# 3. Aguardar health check
sleep 15

# 4. Scale down (1 instância, remove antiga)
docker-compose -f docker-compose.prod.yml up -d --scale $SERVICE=1 --no-recreate

# 5. Cleanup
docker system prune -f

echo "✅ Deploy concluído sem downtime!"
```

---

## 11. Estimativa de Custos Mensal

| Item | Descrição | Custo (USD) |
|------|-----------|-------------|
| **DigitalOcean Droplet** | Premium Intel 4GB / 2 vCPUs / 80GB SSD | $24.00 |
| **Block Storage** | 50GB para backups | $5.00 |
| **Domain (.com.br)** | Registro anual / 12 | ~$2.00 |
| **SSL Certificate** | Let's Encrypt (grátis) | $0.00 |
| **Claude API** | ~500 conversas/mês (~50k tokens) | ~$15.00 |
| **Evolution API** | Self-hosted (grátis) | $0.00 |
| **Mercado Pago** | Taxa por transação (3.99% + R$0.40) | Variável* |
| **Backups** | Incluído no droplet | $0.00 |
| **Monitoramento** | UptimeRobot (free tier) | $0.00 |
| **Email Transacional** | Resend (3k emails/mês grátis) | $0.00 |
| **Total Fixo** | - | **~$46/mês** |

**Notas:**
- *Mercado Pago cobra por transação aprovada (não é custo fixo)
- Claude API: estimativa conservadora, pode variar
- Expansão futura: adicionar $24/mês por droplet adicional quando necessário

### Simulação de Receita vs Custos

**Cenário: 20 vendas/mês (mix de produtos)**

| Produto | Vendas/mês | Preço | Receita |
|---------|-----------|-------|---------|
| Diagnóstico | 10 | R$ 97 | R$ 970 |
| Limpa Nome | 7 | R$ 600 | R$ 4.200 |
| Rating | 3 | R$ 1.200 | R$ 3.600 |
| **TOTAL** | **20** | - | **R$ 8.770** |

**Custos:**
- Infraestrutura: R$ 230 (~$46 × 5)
- Mercado Pago (3.99%): R$ 350
- **Custo Total:** R$ 580
- **Lucro Bruto:** R$ 8.190 (93% de margem!)

---

## 12. Roadmap de Implementação

### Fase 1: Fundação (Semanas 1-2)

**Objetivo:** Infraestrutura básica funcionando

- [ ] Configurar monorepo (workspaces, Turborepo)
- [ ] Setup PostgreSQL unificado com Prisma
- [ ] Migrar dados MariaDB → PostgreSQL
- [ ] Criar seeds de produtos
- [ ] Configurar Droplet DigitalOcean
- [ ] Docker Compose produção básico
- [ ] Deploy inicial (API + DB + Redis)

**Entregável:** API rodando em produção, banco de dados unificado

---

### Fase 2: Autenticação e Backend Core (Semanas 3-4)

**Objetivo:** API completa com autenticação

- [ ] Implementar rotas de autenticação (/auth)
- [ ] JWT + refresh tokens
- [ ] Middleware de autenticação
- [ ] Rate limiting com Redis
- [ ] Rotas de produtos (/products)
- [ ] Rotas de pedidos (/orders)
- [ ] Validação com Zod
- [ ] Logging estruturado

**Entregável:** API REST completa e segura

---

### Fase 3: Gateway de Pagamento (Semana 5)

**Objetivo:** Integração Mercado Pago funcionando

- [ ] Setup conta Mercado Pago
- [ ] Implementar service de pagamento
- [ ] Criar checkout PIX
- [ ] Criar checkout cartão de crédito
- [ ] Webhook handler
- [ ] Testes de pagamento em sandbox
- [ ] Configurar ambiente produção

**Entregável:** Fluxo de pagamento end-to-end testado

---

### Fase 4: Dashboard Cliente (Semanas 6-7)

**Objetivo:** Interface de cliente funcionando

- [ ] Setup Next.js 14 + Tailwind + shadcn/ui
- [ ] Página de login/cadastro
- [ ] Dashboard overview
- [ ] Loja de produtos
- [ ] Checkout flow
- [ ] Página de sucesso/falha pagamento
- [ ] Histórico de pedidos
- [ ] Responsividade mobile

**Entregável:** Dashboard cliente completo

---

### Fase 5: Dashboard Admin (Semana 8)

**Objetivo:** Painel administrativo

- [ ] Layout admin
- [ ] Lista de clientes (busca, filtros)
- [ ] Lista de pedidos (filtros por status, data)
- [ ] Kanban de pedidos (drag-and-drop)
- [ ] Métricas básicas (revenue, conversão)
- [ ] Detalhes de cliente/pedido
- [ ] Proteção de rotas (role-based)

**Entregável:** Painel admin operacional

---

### Fase 6: Integração AI Agent (Semana 9)

**Objetivo:** WhatsApp integrado com sistema

- [ ] Refatorar agent para usar API unificada
- [ ] Implementar webhooks internos
- [ ] Notificação de compra via WhatsApp
- [ ] Notificação de cadastro
- [ ] Sincronizar conversas com DB
- [ ] Testing end-to-end

**Entregável:** Agent totalmente integrado

---

### Fase 7: Background Workers (Semana 10)

**Objetivo:** Jobs assíncronos

- [ ] Setup worker service
- [ ] Queue de follow-ups
- [ ] Processamento de webhooks assíncrono
- [ ] Envio de emails transacionais
- [ ] Cron jobs (limpeza, relatórios)

**Entregável:** Sistema assíncrono robusto

---

### Fase 8: Nginx + SSL + CI/CD (Semana 11)

**Objetivo:** Produção profissional

- [ ] Configurar Nginx reverse proxy
- [ ] Setup Let's Encrypt SSL
- [ ] Domínio apontado para droplet
- [ ] GitHub Actions CI/CD
- [ ] Script de backup automatizado
- [ ] Monitoring básico (UptimeRobot)
- [ ] Logging centralizado

**Entregável:** Deploy automatizado e seguro

---

### Fase 9: Testes & Refinamento (Semana 12)

**Objetivo:** Sistema estável

- [ ] Testes de carga (API)
- [ ] Correção de bugs
- [ ] Otimização de queries
- [ ] Caching estratégico
- [ ] Documentação OpenAPI
- [ ] Documentação de deploy

**Entregável:** Sistema production-ready

---

### Fase 10: Launch & Monitoramento (Semana 13+)

**Objetivo:** Go-live

- [ ] Testes com usuários beta
- [ ] Ajustes finais
- [ ] Launch oficial
- [ ] Monitoramento ativo (erros, performance)
- [ ] Suporte a clientes
- [ ] Iterações com base em feedback

**Entregável:** Produto ao vivo e operacional

---

## Apêndices

### A. Variáveis de Ambiente

```bash
# .env.production

# Database
DATABASE_URL=postgresql://credpositivo:SENHA_FORTE@postgres:5432/credpositivo

# Redis
REDIS_URL=redis://:SENHA_FORTE@redis:6379
REDIS_PASSWORD=SENHA_FORTE

# JWT
JWT_SECRET=SENHA_SUPER_FORTE_MINIMO_32_CHARS
JWT_EXPIRES_IN=1h
JWT_REFRESH_EXPIRES_IN=7d

# APIs Externas
MERCADOPAGO_ACCESS_TOKEN=APP_USR-xxxxxxxxxx
CLAUDE_API_KEY=sk-ant-xxxxxxxxxx
EVOLUTION_API_KEY=CHAVE_FORTE_EVOLUTION
EVOLUTION_API_URL=http://evolution-api:8080

# URLs
API_URL=https://api.credpositivo.com.br
FRONTEND_URL=https://credpositivo.com.br
AGENT_URL=http://agent:3002

# Agent
AGENT_API_KEY=CHAVE_INTERNA_FORTE

# Email (Resend)
RESEND_API_KEY=re_xxxxxxxxxx
EMAIL_FROM=contato@credpositivo.com.br

# Sentry (opcional)
SENTRY_DSN=https://xxxxx@sentry.io/xxxxx

# Ambiente
NODE_ENV=production
```

### B. Comandos Úteis

```bash
# Desenvolvimento local
npm install
docker-compose up -d
npx prisma migrate dev
npx prisma studio  # GUI do banco
npm run dev

# Build produção
docker-compose -f docker-compose.prod.yml build
docker-compose -f docker-compose.prod.yml up -d

# Logs
docker logs -f credpositivo-api
docker logs -f credpositivo-agent

# Backup manual
docker exec credpositivo-postgres pg_dump -U credpositivo credpositivo > backup.sql

# Restore
docker exec -i credpositivo-postgres psql -U credpositivo credpositivo < backup.sql

# Migrations
docker exec credpositivo-api npx prisma migrate deploy
docker exec credpositivo-api npx prisma db push

# Acesso ao banco
docker exec -it credpositivo-postgres psql -U credpositivo

# Health checks
curl https://credpositivo.com.br/api/health
curl https://evolution.credpositivo.com.br/health
```

### C. Checklist de Segurança (LGPD)

- [ ] Criptografia de senhas (bcrypt)
- [ ] Tokens JWT com expiração
- [ ] Rate limiting em todas as rotas
- [ ] Sanitização de inputs
- [ ] CORS configurado corretamente
- [ ] Headers de segurança (Helmet)
- [ ] SSL/TLS habilitado
- [ ] Logs de auditoria (audit_events)
- [ ] Anonimização de dados em logs
- [ ] Política de retenção de dados
- [ ] Endpoint para LGPD (download, exclusão de dados)
- [ ] Termos de uso e privacidade
- [ ] Consentimento explícito para WhatsApp
- [ ] Backup criptografado
- [ ] Secrets em variáveis de ambiente (nunca no código)

### D. Links Úteis

- [Prisma Docs](https://www.prisma.io/docs)
- [Next.js Docs](https://nextjs.org/docs)
- [Mercado Pago Developers](https://www.mercadopago.com.br/developers/pt)
- [Evolution API Docs](https://doc.evolution-api.com/)
- [DigitalOcean Tutorials](https://www.digitalocean.com/community/tutorials)
- [Let's Encrypt](https://letsencrypt.org/)
- [Docker Compose Docs](https://docs.docker.com/compose/)

---

## 13. Ecossistema de Agentes IA

O CredPositivo opera com um **ecossistema de agentes inteligentes** que trabalham de forma coordenada. Não é apenas o "Augusto" no WhatsApp — são múltiplos agentes especializados com papéis distintos, todos rodando dentro da infraestrutura Docker.

### Visão Geral dos Agentes

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ECOSSISTEMA DE AGENTES IA                           │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                 ORQUESTRADOR DE AGENTES                           │  │
│  │         (services/agent/src/orchestrator.ts)                      │  │
│  │                                                                   │  │
│  │  Decide QUAL agente responde, baseado em:                         │  │
│  │  - Fase da conversa (0-5)                                         │  │
│  │  - Evento recebido (webhook, mensagem, timer)                     │  │
│  │  - Status do cliente (prospect, comprou, pós-venda)               │  │
│  └────┬──────────┬──────────┬──────────┬──────────┬─────────────────┘  │
│       │          │          │          │          │                     │
│  ┌────▼───┐ ┌───▼────┐ ┌──▼───┐ ┌───▼────┐ ┌──▼──────┐              │
│  │AUGUSTO │ │FOLLOW  │ │UPSELL│ │SUPORTE │ │CONTEÚDO │              │
│  │Consultor│ │  UP    │ │Agent │ │Pós-Vend│ │Instagram│              │
│  │Crédito │ │ Agent  │ │      │ │   a    │ │  Agent  │              │
│  └────┬───┘ └───┬────┘ └──┬───┘ └───┬────┘ └──┬──────┘              │
│       │         │         │         │          │                      │
│       ▼         ▼         ▼         ▼          ▼                      │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │                    CAMADA DE COMUNICAÇÃO                        │   │
│  │  - Evolution API (WhatsApp)                                    │   │
│  │  - Email (Resend)                                              │   │
│  │  - Redis (eventos internos)                                    │   │
│  │  - API REST (dados do sistema)                                 │   │
│  └────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### Agente 1: AUGUSTO — Consultor de Crédito (Principal)

**Função:** Especialista de crédito que conduz toda a jornada do lead no WhatsApp.
**Trigger:** Mensagem recebida de lead que ainda NÃO comprou.
**Canal:** WhatsApp (via Evolution API)

```typescript
// services/agent/src/agents/augusto-consultor.ts

export const augustoConsultor = {
  name: 'augusto-consultor',
  description: 'Agente principal de vendas consultivas via WhatsApp',

  // Quando este agente é ativado
  shouldHandle(context: AgentContext): boolean {
    return (
      context.trigger === 'whatsapp_message' &&
      context.customerStatus !== 'POST_SALE' &&
      context.conversation.phase >= 0 &&
      context.conversation.phase <= 4
    );
  },

  // System prompt base (já existe em system-prompt.js)
  systemPrompt: buildSystemPrompt, // importado de prompts/augusto.prompt.ts

  // Configuração do Claude
  claudeConfig: {
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 500,
    temperature: 0.7,
  },

  // Pós-processamento da resposta
  async postProcess(response: string, state: ConversationState) {
    // 1. Extrair metadata [METADATA]...[/METADATA]
    const { text, metadata } = parseAgentResponse(response);

    // 2. Filtro de compliance (palavras proibidas)
    const filteredText = applyComplianceFilter(text);

    // 3. Atualizar estado da conversa
    const updates = applyMetadataUpdates(state, metadata);

    // 4. Ações colaterais
    if (metadata.should_send_ebook) {
      await actions.sendEbook(state.phone);
    }
    if (metadata.should_send_link) {
      await actions.sendSiteLink(state.phone);
    }
    if (metadata.escalation_flag) {
      await actions.escalateToHuman(state.phone, metadata.escalation_flag);
    }

    return { text: filteredText, updates, metadata };
  },
};
```

**Fases de atuação:**
| Fase | Objetivo | Max mensagens |
|------|----------|---------------|
| 0 | Antiban (salvar contato) | 2 |
| 1 | Acolhimento | 3 |
| 2 | Investigação (mapear situação) | 12 |
| 2→3 | Oferta de ebook gratuito | 1 |
| 3 | Educação + Recomendação de produto | 5 |
| 4 | Direcionamento ao site | 4 |

---

### Agente 2: FOLLOW-UP — Reengajamento Automático

**Função:** Reengajar leads que pararam de responder ou abandonaram o carrinho.
**Trigger:** Timer (cron) + eventos de webhook (purchase_abandoned, link_sent_no_action).
**Canal:** WhatsApp (via Evolution API)

```typescript
// services/agent/src/agents/followup-agent.ts

export const followupAgent = {
  name: 'followup-agent',
  description: 'Reengaja leads inativos com mensagens contextualizadas',

  // Quando este agente é ativado
  shouldHandle(context: AgentContext): boolean {
    return (
      context.trigger === 'scheduled_followup' ||
      context.trigger === 'webhook_purchase_abandoned' ||
      context.trigger === 'webhook_link_sent_no_action'
    );
  },

  // System prompt específico para follow-up
  buildPrompt(state: ConversationState, event: FollowupEvent): string {
    return `Você é AUGUSTO da CredPositivo. Está retomando contato com ${state.name || 'o lead'}.

## CONTEXTO
- Última interação: ${state.last_message_at}
- Fase quando parou: ${state.phase}
- Produto recomendado: ${state.recommended_product || 'não definido ainda'}
- Tentativa de follow-up: ${event.attempt}/3
- Motivo do follow-up: ${event.reason}

## REGRAS DE FOLLOW-UP
- Tentativa 1 (24h): Leve, curioso. "Oi [nome], tava pensando no que conversamos..."
- Tentativa 2 (72h): Valor. Compartilhe insight ou dado relevante sobre a situação dele.
- Tentativa 3 (7 dias): Último toque. "Sei que a vida corre, mas quis checar..."
- NUNCA use urgência artificial ou pressão.
- NUNCA diga "estou te cobrando" ou similar.
- Se o lead já comprou, NÃO faça follow-up de venda.
- Máximo 3 tentativas. Depois, arquivar conversa.

## EVENTO: ${event.type}
${event.type === 'purchase_abandoned' ?
  'O lead clicou no link, acessou o site, mas NÃO completou a compra.' :
  event.type === 'link_sent_no_action' ?
  'O link do site foi enviado, mas o lead NÃO clicou.' :
  'O lead ficou inativo após a última mensagem.'}

Responda com UMA mensagem curta estilo WhatsApp (máx 3-4 linhas).`;
  },

  claudeConfig: {
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 200,
    temperature: 0.8, // Um pouco mais criativo nos follow-ups
  },
};
```

**Cadeia de follow-up:**
```
Lead inativo:
  T+24h  → Mensagem 1 (leve, retomada)
  T+72h  → Mensagem 2 (valor, insight)
  T+7d   → Mensagem 3 (último toque)
  T+7d+  → Arquivar (não insistir mais)

Carrinho abandonado:
  T+1h   → "Vi que você acessou o site! Ficou alguma dúvida?"
  T+24h  → "Sobre o [produto], posso te explicar melhor..."
  T+72h  → Último toque

Link não clicado:
  T+24h  → "O link que te mandei mostra tudo em detalhes..."
  T+72h  → Reenviar link com contexto diferente
  T+7d   → Último toque
```

**Implementação do scheduler:**
```typescript
// services/worker/src/jobs/process-followups.job.ts

import cron from 'node-cron';

// Roda a cada 15 minutos
cron.schedule('*/15 * * * *', async () => {
  const pendingFollowups = await prisma.followup.findMany({
    where: {
      status: 'PENDING',
      scheduledFor: { lte: new Date() },
    },
    include: { conversation: { include: { customer: true } } },
    orderBy: { scheduledFor: 'asc' },
    take: 50, // Batch de 50
  });

  for (const followup of pendingFollowups) {
    try {
      // Verificar se lead respondeu desde agendamento
      const latestMessage = await prisma.message.findFirst({
        where: {
          conversationId: followup.conversationId,
          direction: 'INBOUND',
          createdAt: { gt: followup.createdAt },
        },
      });

      if (latestMessage) {
        // Lead respondeu, cancelar follow-up
        await prisma.followup.update({
          where: { id: followup.id },
          data: { status: 'CANCELLED' },
        });
        continue;
      }

      // Gerar e enviar mensagem de follow-up
      const response = await orchestrator.handle({
        trigger: 'scheduled_followup',
        conversation: followup.conversation,
        event: {
          type: followup.eventType,
          attempt: followup.attempt,
        },
      });

      // Enviar via Evolution API
      await evolutionService.sendMessage(
        followup.conversation.whatsappNumber,
        response.text
      );

      // Atualizar status
      await prisma.followup.update({
        where: { id: followup.id },
        data: { status: 'SENT', sentAt: new Date() },
      });

      // Agendar próximo follow-up se não for o último
      if (followup.attempt < 3) {
        const delays = [24 * 60, 72 * 60, 7 * 24 * 60]; // minutos
        await prisma.followup.create({
          data: {
            conversationId: followup.conversationId,
            eventType: followup.eventType,
            attempt: followup.attempt + 1,
            scheduledFor: new Date(
              Date.now() + delays[followup.attempt] * 60 * 1000
            ),
            status: 'PENDING',
          },
        });
      }
    } catch (error) {
      console.error(`Follow-up ${followup.id} failed:`, error);
      await prisma.followup.update({
        where: { id: followup.id },
        data: { status: 'FAILED', errorMessage: error.message },
      });
    }
  }
});
```

---

### Agente 3: UPSELL — Pós-Compra

**Função:** Fazer upsell inteligente após cliente comprar o primeiro produto.
**Trigger:** Webhook `purchase_completed` + timer pós-compra.
**Canal:** WhatsApp (via Evolution API)

```typescript
// services/agent/src/agents/upsell-agent.ts

export const upsellAgent = {
  name: 'upsell-agent',
  description: 'Faz upsell contextualizado após compra de produto',

  shouldHandle(context: AgentContext): boolean {
    return (
      context.trigger === 'webhook_purchase_completed' ||
      context.trigger === 'scheduled_upsell'
    );
  },

  buildPrompt(state: ConversationState, purchasedProduct: string): string {
    const upsellChain: Record<string, { next: string; pitch: string }> = {
      diagnostico: {
        next: 'limpa_nome',
        pitch: `O diagnóstico vai revelar exatamente o que está travando o crédito do lead.
Quando ele receber o resultado, é o momento perfeito para oferecer o Limpa Nome.
Abordagem: "Agora que você viu o diagnóstico, o próximo passo natural é resolver as pendências..."`,
      },
      limpa_nome: {
        next: 'rating',
        pitch: `O Limpa Nome resolve as negativações. Mas nome limpo ≠ crédito aprovado.
O Rating reconstrói o perfil bancário. É o que faz a diferença.
Abordagem: "Parabéns por limpar o nome! Agora, pra garantir aprovação, o Rating trabalha o que os bancos realmente olham..."
Bonus: Mencionar o cartão de crédito parceiro que ele já ganhou.`,
      },
      rating: {
        next: null,
        pitch: `Rating é o produto final. Não há upsell direto.
Foco: acompanhamento, satisfação, e pedido de indicação.
Abordagem: "Como está indo o processo? Qualquer dúvida, estou aqui. Se conhecer alguém na mesma situação, pode indicar!"`,
      },
    };

    const chain = upsellChain[purchasedProduct];

    return `Você é AUGUSTO da CredPositivo. O cliente acabou de COMPRAR o ${purchasedProduct}.

## CONTEXTO
- Produto comprado: ${purchasedProduct}
- Próximo produto na cadeia: ${chain?.next || 'Nenhum (produto final)'}
- Nome do cliente: ${state.name}
- Perfil coletado: ${JSON.stringify(state.user_profile)}

## OBJETIVO
${chain?.pitch}

## TIMING DE UPSELL
- Diagnóstico comprado → Aguardar ENTREGA do resultado → Depois ofertar Limpa Nome
- Limpa Nome comprado → Aguardar CONCLUSÃO do serviço → Depois ofertar Rating
- NÃO oferecer upsell no mesmo dia da compra
- Primeiro: confirmar pagamento, tranquilizar, acompanhar
- Depois (3-7 dias): iniciar conversa sobre próximo passo

## REGRAS
- NUNCA pressione
- NUNCA use "aproveite", "última chance", "desconto só hoje"
- Abordagem consultiva: "Agora que resolvemos X, o próximo passo natural é Y"
- Se cliente disser não, respeitar. Manter porta aberta.

Responda com UMA mensagem curta estilo WhatsApp.`;
  },

  claudeConfig: {
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 300,
    temperature: 0.7,
  },
};
```

**Cadeia de upsell:**
```
Diagnóstico (R$97)
  └→ Após entrega do resultado (3-7 dias)
      └→ Oferecer Limpa Nome (R$600) se negativado
      └→ Oferecer Rating (R$1200) se nome limpo

Limpa Nome (R$600)
  └→ Após conclusão do serviço
      └→ Mencionar cartão de crédito parceiro ✅
      └→ Oferecer Rating (R$1200)

Rating (R$1200)
  └→ Acompanhamento contínuo
      └→ Pedir indicações / depoimento
```

---

### Agente 4: SUPORTE PÓS-VENDA

**Função:** Atender clientes que já compraram e têm dúvidas sobre o serviço.
**Trigger:** Mensagem de cliente com status = comprou / em andamento.
**Canal:** WhatsApp (via Evolution API)

```typescript
// services/agent/src/agents/suporte-agent.ts

export const suporteAgent = {
  name: 'suporte-posvenda',
  description: 'Suporte para clientes que já compraram',

  shouldHandle(context: AgentContext): boolean {
    return (
      context.trigger === 'whatsapp_message' &&
      context.customerStatus === 'POST_SALE'
    );
  },

  buildPrompt(state: ConversationState, orders: Order[]): string {
    const activeOrders = orders
      .filter((o) => ['PROCESSING', 'IN_PROGRESS'].includes(o.status))
      .map((o) => `- ${o.product.name} (status: ${o.status}, desde ${o.createdAt})`)
      .join('\n');

    return `Você é AUGUSTO da CredPositivo. Está atendendo um CLIENTE que já comprou.

## CONTEXTO DO CLIENTE
- Nome: ${state.name}
- Serviços ativos:
${activeOrders || '  Nenhum serviço ativo no momento'}

## SEU PAPEL AGORA
- Você é SUPORTE, não vendedor
- Responda dúvidas sobre o serviço contratado
- Dê atualizações de status quando possível
- Se não souber status exato, diga que vai verificar internamente
- Seja empático e proativo

## O QUE VOCÊ PODE FAZER
1. Informar status do serviço (consultar dados disponíveis)
2. Explicar próximos passos do processo
3. Responder dúvidas sobre prazos
4. Coletar documentos adicionais se necessário
5. Escalar para humano se for questão técnica que não consegue resolver

## O QUE VOCÊ NÃO PODE FAZER
- Prometer prazos específicos que não estão confirmados
- Dar informações sobre dados internos de análise (Bacen, SCR)
- Fazer reembolso (escalar para admin)
- Alterar status de pedido

## REGRA ESPECIAL: UPSELL NATURAL
- Se o cliente mencionar que quer mais serviços, conduza naturalmente
- Se o Limpa Nome acabou, ofereça Rating como próximo passo
- NÃO force upsell em conversa de suporte

Responda como suporte WhatsApp: curto, útil, empático.`;
  },

  claudeConfig: {
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 300,
    temperature: 0.5, // Mais preciso, menos criativo para suporte
  },
};
```

---

### Agente 5: CONTEÚDO — Geração para Instagram

**Função:** Gerar conteúdo para Instagram seguindo o calendário de 7 dias.
**Trigger:** Manual (admin solicita) ou cron semanal.
**Canal:** Interno (gera texto/roteiro, admin publica)

```typescript
// services/agent/src/agents/conteudo-agent.ts

export const conteudoAgent = {
  name: 'conteudo-instagram',
  description: 'Gera conteúdo para Instagram baseado no calendário editorial',

  shouldHandle(context: AgentContext): boolean {
    return context.trigger === 'admin_request_content';
  },

  buildPrompt(contentType: string, topic: string): string {
    return `Você é o redator de conteúdo da CredPositivo para Instagram.

## MARCA
- Tom: Educativo, acessível, empático
- Nunca promete aprovação de crédito ou aumento de score
- Foco em educação financeira e desmistificação
- Público: Brasileiros adultos com problemas de crédito

## TIPOS DE CONTEÚDO
- Carrossel educativo (5-7 slides)
- Reels roteiro (30-60 segundos)
- Story sequência (3-5 stories)
- Post single (legenda + CTA)

## REGRAS
- Linguagem informal brasileira (sem gírias pesadas)
- Emojis funcionais (✅❌👇💡)
- CTA sempre direcionando para bio/WhatsApp
- Nunca mencionar preço nos posts
- Nunca prometer resultados

## PEDIDO
Tipo: ${contentType}
Tema: ${topic}

Gere o conteúdo completo com:
1. Texto de cada slide/cena
2. Sugestão visual (o que colocar na imagem)
3. Legenda do post
4. Hashtags relevantes (máx 10)
5. CTA final`;
  },

  claudeConfig: {
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 1500,
    temperature: 0.9, // Mais criativo para conteúdo
  },
};
```

---

### Agente 6: NOTIFICADOR — Alertas Internos

**Função:** Notificar admin sobre eventos importantes do sistema.
**Trigger:** Eventos do sistema (nova compra, fallback ativado, erro crítico).
**Canal:** WhatsApp do admin ou email.

```typescript
// services/agent/src/agents/notificador-agent.ts

export const notificadorAgent = {
  name: 'notificador-admin',
  description: 'Envia alertas para admin sobre eventos do sistema',

  // NÃO usa Claude — mensagens são templates fixos
  templates: {
    purchase_completed: (data: any) =>
      `🟢 *NOVA VENDA*\n\nCliente: ${data.customerName}\nProduto: ${data.productName}\nValor: R$ ${data.amount}\nPagamento: ${data.method}\n\nTotal hoje: ${data.dailyTotal}`,

    payment_failed: (data: any) =>
      `🔴 *PAGAMENTO FALHOU*\n\nCliente: ${data.customerName}\nProduto: ${data.productName}\nMotivo: ${data.reason}\n\nAção: verificar no painel admin`,

    fallback_triggered: (data: any) =>
      `⚠️ *FALLBACK ATIVADO*\n\nCliente: ${data.customerName}\nTelefone: ${data.phone}\nMotivo: ${data.reason}\n\nAssuma a conversa como Augusto.`,

    daily_summary: (data: any) =>
      `📊 *RESUMO DO DIA*\n\n` +
      `Conversas iniciadas: ${data.newConversations}\n` +
      `Leads na Fase 4: ${data.phase4Count}\n` +
      `Vendas: ${data.salesCount} (R$ ${data.totalRevenue})\n` +
      `Follow-ups enviados: ${data.followupsSent}\n` +
      `Taxa de resposta: ${data.responseRate}%\n` +
      `Fallbacks: ${data.fallbackCount}`,

    system_error: (data: any) =>
      `🚨 *ERRO CRÍTICO*\n\nServiço: ${data.service}\nErro: ${data.error}\nTimestamp: ${data.timestamp}\n\nVerificar imediatamente.`,
  },

  async notify(event: string, data: any) {
    const template = this.templates[event];
    if (!template) return;

    const message = template(data);
    const adminPhone = process.env.ADMIN_WHATSAPP_NUMBER;

    // Enviar via Evolution API
    await evolutionService.sendMessage(adminPhone, message);

    // Também enviar por email se for crítico
    if (['fallback_triggered', 'system_error'].includes(event)) {
      await emailService.send({
        to: process.env.ADMIN_EMAIL,
        subject: `[CredPositivo] ${event}`,
        text: message,
      });
    }
  },
};
```

---

### Orquestrador de Agentes

O orquestrador é o cérebro que decide qual agente responde a cada evento.

```typescript
// services/agent/src/orchestrator.ts

import { augustoConsultor } from './agents/augusto-consultor';
import { followupAgent } from './agents/followup-agent';
import { upsellAgent } from './agents/upsell-agent';
import { suporteAgent } from './agents/suporte-agent';
import { conteudoAgent } from './agents/conteudo-agent';
import { notificadorAgent } from './agents/notificador-agent';

// Todos os agentes registrados (ordem = prioridade)
const agents = [
  notificadorAgent,    // Prioridade 1: notificações internas
  suporteAgent,        // Prioridade 2: cliente que já comprou
  upsellAgent,         // Prioridade 3: upsell pós-compra
  followupAgent,       // Prioridade 4: reengajamento
  augustoConsultor,    // Prioridade 5: consulta padrão (default)
];

interface AgentContext {
  trigger:
    | 'whatsapp_message'
    | 'webhook_purchase_completed'
    | 'webhook_purchase_abandoned'
    | 'webhook_signup_completed'
    | 'webhook_link_sent_no_action'
    | 'scheduled_followup'
    | 'scheduled_upsell'
    | 'admin_request_content'
    | 'system_event';
  conversation?: ConversationState;
  customerStatus?: 'PROSPECT' | 'POST_SALE' | 'INACTIVE';
  event?: any;
  message?: string;
}

export class AgentOrchestrator {

  async handle(context: AgentContext) {
    // 1. Determinar status do cliente
    if (context.conversation) {
      context.customerStatus = await this.getCustomerStatus(
        context.conversation.customerId
      );
    }

    // 2. Encontrar agente adequado
    const agent = agents.find((a) => a.shouldHandle(context));

    if (!agent) {
      console.warn('Nenhum agente encontrou match para:', context.trigger);
      return null;
    }

    console.log(`[Orchestrator] Agente selecionado: ${agent.name} para trigger: ${context.trigger}`);

    // 3. Log para auditoria
    await this.logAgentSelection(context, agent.name);

    // 4. Executar agente
    if (agent.claudeConfig) {
      // Agentes que usam Claude
      const prompt = agent.buildPrompt
        ? agent.buildPrompt(context.conversation, context.event)
        : agent.systemPrompt(context.conversation);

      const response = await claudeService.chat(prompt, context.message, agent.claudeConfig);

      // Pós-processamento (se existir)
      if (agent.postProcess) {
        return agent.postProcess(response, context.conversation);
      }

      return { text: response, agent: agent.name };
    } else {
      // Agentes sem Claude (notificador)
      return agent.notify(context.trigger, context.event);
    }
  }

  private async getCustomerStatus(customerId: string): Promise<string> {
    const orders = await prisma.order.findMany({
      where: {
        customerId,
        paymentStatus: 'APPROVED',
      },
    });

    if (orders.length > 0) return 'POST_SALE';
    return 'PROSPECT';
  }

  private async logAgentSelection(context: AgentContext, agentName: string) {
    await prisma.auditEvent.create({
      data: {
        action: 'agent.selected',
        entity: 'Agent',
        entityId: agentName,
        metadata: {
          trigger: context.trigger,
          customerStatus: context.customerStatus,
          conversationId: context.conversation?.id,
        },
      },
    });
  }
}

export const orchestrator = new AgentOrchestrator();
```

---

### Estrutura de Pastas dos Agentes

```
services/agent/
├── src/
│   ├── index.ts                      # Entry point
│   ├── server.ts                     # Express server (webhooks)
│   ├── orchestrator.ts               # 🧠 Orquestrador central
│   │
│   ├── agents/                       # 🤖 Cada agente em arquivo separado
│   │   ├── augusto-consultor.ts      # Agente principal (vendas)
│   │   ├── followup-agent.ts         # Reengajamento de leads
│   │   ├── upsell-agent.ts           # Upsell pós-compra
│   │   ├── suporte-agent.ts          # Suporte pós-venda
│   │   ├── conteudo-agent.ts         # Geração de conteúdo Instagram
│   │   └── notificador-agent.ts      # Alertas internos (sem Claude)
│   │
│   ├── prompts/                      # System prompts detalhados
│   │   ├── augusto-base.prompt.ts    # Prompt base (identidade, regras)
│   │   ├── augusto-fases.prompt.ts   # Prompt por fase (0-5)
│   │   ├── followup.prompt.ts        # Templates de follow-up
│   │   ├── upsell.prompt.ts          # Cadeia de upsell
│   │   └── suporte.prompt.ts         # Suporte pós-venda
│   │
│   ├── services/                     # Serviços compartilhados
│   │   ├── claude.service.ts         # Client Claude API
│   │   ├── evolution.service.ts      # Client Evolution API
│   │   ├── api.client.ts             # Client API interna
│   │   └── email.service.ts          # Client Resend (email)
│   │
│   ├── handlers/                     # Handlers de eventos
│   │   ├── message.handler.ts        # Mensagens WhatsApp recebidas
│   │   ├── webhook.handler.ts        # Webhooks do site/pagamento
│   │   └── cron.handler.ts           # Jobs agendados
│   │
│   ├── filters/                      # Filtros pós-resposta
│   │   ├── compliance.filter.ts      # Palavras/frases proibidas
│   │   ├── length.filter.ts          # Limitar tamanho de mensagem
│   │   └── metadata.parser.ts        # Extrair [METADATA] da resposta
│   │
│   └── types/                        # TypeScript types
│       ├── agent.types.ts
│       ├── context.types.ts
│       └── event.types.ts
│
├── package.json
├── tsconfig.json
└── Dockerfile
```

---

### Fluxo de Decisão do Orquestrador

```
Evento recebido
     │
     ▼
┌─────────────────────┐
│ Qual tipo de evento? │
└─────┬───────────────┘
      │
      ├─── system_event (erro, alerta) ──────→ NOTIFICADOR
      │
      ├─── whatsapp_message ──┐
      │                       │
      │               ┌──────▼──────────┐
      │               │ Cliente comprou? │
      │               └──┬────────┬─────┘
      │                  │        │
      │                 SIM      NÃO
      │                  │        │
      │                  ▼        ▼
      │             SUPORTE   AUGUSTO
      │            PÓS-VENDA  CONSULTOR
      │
      ├─── webhook_purchase_completed ───────→ NOTIFICADOR + UPSELL (agendado)
      │
      ├─── webhook_purchase_abandoned ───────→ FOLLOW-UP
      │
      ├─── webhook_link_sent_no_action ──────→ FOLLOW-UP
      │
      ├─── scheduled_followup ───────────────→ FOLLOW-UP
      │
      ├─── scheduled_upsell ─────────────────→ UPSELL
      │
      └─── admin_request_content ────────────→ CONTEÚDO
```

---

### Tabela Resumo dos Agentes

| Agente | Função | Trigger | Usa Claude? | Canal | Prioridade |
|--------|--------|---------|-------------|-------|------------|
| **Augusto Consultor** | Vendas consultivas | Mensagem WhatsApp (prospect) | Sim (Sonnet) | WhatsApp | 5 (default) |
| **Follow-up** | Reengajamento | Timer + webhooks abandono | Sim (Sonnet) | WhatsApp | 4 |
| **Upsell** | Pós-compra | Webhook compra + timer | Sim (Sonnet) | WhatsApp | 3 |
| **Suporte** | Pós-venda | Mensagem WhatsApp (cliente) | Sim (Sonnet) | WhatsApp | 2 |
| **Conteúdo** | Instagram | Solicitação admin | Sim (Sonnet) | Interno | N/A |
| **Notificador** | Alertas admin | Eventos sistema | Não (templates) | WhatsApp + Email | 1 |

### Custo Estimado dos Agentes (Claude API)

| Agente | Chamadas/mês | Tokens médios/chamada | Custo estimado |
|--------|-------------|----------------------|----------------|
| Augusto Consultor | ~500 conversas × 8 msgs = 4.000 | ~800 tokens | ~$10 |
| Follow-up | ~200 mensagens | ~400 tokens | ~$1 |
| Upsell | ~50 mensagens | ~500 tokens | ~$0.50 |
| Suporte | ~100 mensagens | ~500 tokens | ~$1 |
| Conteúdo | ~30 posts/mês | ~2000 tokens | ~$1.50 |
| Notificador | N/A | N/A (templates) | $0 |
| **TOTAL** | - | - | **~$14/mês** |

*Estimativa baseada em pricing do Claude Sonnet: $3/M input, $15/M output tokens.*

---

## Conclusão

Esta arquitetura foi projetada para ser:

1. **Econômica:** ~$46/mês de custos fixos + ~$14/mês de IA
2. **Escalável:** Fácil adicionar droplets quando necessário
3. **Inteligente:** 6 agentes IA especializados trabalhando em coordenação
4. **Segura:** SSL, rate limiting, LGPD-compliant
5. **Manutenível:** Monorepo, TypeScript, testes
6. **Moderna:** Next.js, Prisma, Docker, Redis
7. **Brasileira:** PIX, Mercado Pago, LGPD, português

Com este documento, você tem um blueprint completo para implementar o CredPositivo do zero. Siga o roadmap fase por fase e você terá um sistema production-ready em ~13 semanas.

**Próximos passos:**
1. Criar repositório Git
2. Configurar monorepo
3. Provisionar droplet DigitalOcean
4. Começar Fase 1 do roadmap

Boa sorte com o desenvolvimento! 🚀
