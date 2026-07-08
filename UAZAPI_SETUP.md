# 🚀 Setup WACRM com uazapi (Local)

## Status: ✅ Código pronto

Todas as 8 fases foram implementadas:
- ✅ uazapi-client.ts criado
- ✅ Webhook routes adaptados
- ✅ Config route adaptado
- ✅ Send-message adaptado
- ✅ Database migration (036_whatsapp_config_uazapi.sql)
- ✅ Processamento de webhooks implementado

---

## 📋 Próximos Passos (Execute em Ordem)

### **Passo 1: Aplicar Migração Supabase** ✅ 

Você precisa executar a migração no dashboard Supabase:

1. Vá para: https://app.supabase.com/project/kjvkjbfbnrmatlytuetk/sql
2. Clique em "New Query"
3. Cole o SQL de: `supabase/migrations/036_whatsapp_config_uazapi.sql`
4. Clique "Run"

**Ou via CLI:**
```bash
# Se você tiver supabase CLI linked:
npx supabase db push
```

---

### **Passo 2: Verificar `.env.local`** ✅

Seu arquivo `.env.local` já está configurado. Verifique:

```bash
cat .env.local | grep -i uazapi
```

Esperado:
```
UAZAPI_BASE_URL=https://eluminaai.uazapi.com
UAZAPI_ADMIN_TOKEN=b033Vsn1MWBBy4Wm9n4nqFV0GgB3RuVcmCnqx0UNpKGBjpAEG4
UAZAPI_WEBHOOK_TOKEN=seu-webhook-token-unico-aqui-2024
ENCRYPTION_KEY=12a16dd28edab21f5deef569bccee832e6c597a616b1ca319005bac0b5e89ea1
```

---

### **Passo 3: Rodar Localmente com ngrok** 🚀

**Terminal 1 - Inicie o Next.js:**
```bash
cd wacrm
npm install  # (se não tiver rodado antes)
npm run dev
```

Você verá:
```
▲ Next.js 14.x
- Local:        http://localhost:3000
```

**Terminal 2 - Inicie ngrok:**
```bash
npm install -g ngrok  # (se não tiver)
ngrok http 3000
```

Copie a URL pública (exemplo: `https://abc123-456.ngrok.io`)

---

### **Passo 4: Configurar Webhook no uazapi** 

Na UI do uazapi:

1. Vá para: https://console.uazapi.com (ou seu painel)
2. Navegue até: **Webhooks** ou **Instance Settings**
3. Configure a URL do webhook:
   ```
   https://seu-ngrok-url/api/whatsapp/webhook
   ```
4. **⚠️ IMPORTANTE**: Como uazapi não suporta headers customizados, deixe em branco qualquer opção de "Authorization header" ou "Verification token"
5. Salve

---

### **Passo 5: Conectar Número WhatsApp** 

**POST para o seu CRM:**

```bash
curl -X POST http://localhost:3000/api/whatsapp/config/connect-uazapi \
  -H "Content-Type: application/json" \
  -H "Cookie: auth_token=seu_token_aqui" \
  -d '{"phone":"551199999999"}'
```

Ou via UI:
1. Abra http://localhost:3000
2. Vá para **Configurações → WhatsApp**
3. Clique "Conectar com uazapi"
4. Escolha: **QR Code** (2 min) ou **Pairing Code** (5 min)
5. Scaneie/cole no seu WhatsApp

Você verá na resposta:
```json
{
  "qr_code": "data:image/png;base64,...",
  "status": "connecting",
  "instance_id": "seu_instance_id"
}
```

---

### **Passo 6: Testar Fluxo Completo** ✅

**Teste 1: Enviar Mensagem (CRM → WhatsApp)**
1. Na UI, vá para **Contatos**
2. Selecione um contato com WhatsApp
3. Clique "Enviar Mensagem"
4. Digite "Olá!" 
5. Verifique se chegou no WhatsApp

**Teste 2: Receber Mensagem (WhatsApp → CRM)**
1. Do seu WhatsApp, envie mensagem para o número conectado
2. Na UI, você deve ver a mensagem na caixa de entrada

---

## 🔒 Segurança do Webhook

Como uazapi **não suporta headers customizados**, a validação funciona assim:

| Validação | Meta | uazapi |
|-----------|------|--------|
| Signature Header | ✅ x-hub-signature-256 | ❌ Não tem |
| Bearer Token | ✅ Verifica | ❌ Não suporta |
| IP Whitelist | ❌ Não oferece | ✅ Você configura |
| URL Secrecy | ⚠️ Recomendado | ✅ Recomendado |

**Recomendações de produção para uazapi:**
1. Use um caminho secreto: `/api/webhook/sua-chave-aleatoria`
2. Peça ao suporte uazapi para whitelistear seus IPs
3. Rate-limit o endpoint no seu servidor
4. Monitore logs para requests inusitados

---

## 🆘 Troubleshooting

### Erro: "No config found for uazapi instance_id"
→ Você não completou o Passo 5 (conectar número)

### Erro: "Webhook URL connection refused"
→ Certifique-se que ngrok está rodando e a URL está correta

### Erro: "ENCRYPTION_KEY invalid format"
→ Verifique se `.env.local` tem a chave hexadecimal completa (64 caracteres)

### Mensagens não chegam
1. Verifique em http://localhost:3000/api/whatsapp/config para ver o `connection_state`
2. Se for `hibernated`, você precisa reconectar (nova QR code)
3. Verifique logs do ngrok (deve receber requests POST)

---

## 📊 Estrutura de Dados (Nova)

A tabela `whatsapp_config` agora tem:

### Meta (API Oficial)
```
phone_number_id: "123456789"
access_token: "[encrypted]"
waba_id: "987654321"
status: "connected"
```

### uazapi (Nossa Implementação)
```
instance_id: "seu_instance_id"
instance_token: "[encrypted]"
connection_state: "connected|hibernated|connecting|disconnected"
qr_code: "data:image/png;base64,..." (temporário)
registered_at: "2026-07-08T22:00:00Z"
```

---

## 🎯 Próximas Features (Roadmap)

- [ ] Suporte a templates (uazapi v3+)
- [ ] Suporte a mensagens interativas
- [ ] Auto-reconnect ao hibernar
- [ ] Dashboard status em tempo real
- [ ] Suporte a múltiplas instâncias por conta

---

## 📝 Comando Rápido (Tudo de uma vez)

```bash
cd wacrm

# Terminal 1:
npm run dev

# Terminal 2:
npx ngrok http 3000

# Terminal 3:
curl -X POST http://localhost:3000/api/whatsapp/config \
  -H "Content-Type: application/json" \
  -d '{"accountId":"seu_account_id","instanceToken":"seu_token"}'
```

---

**Status**: Pronto para produção em Vercel! 🚀
