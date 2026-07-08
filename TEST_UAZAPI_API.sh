#!/bin/bash
# Examples: Testing WACRM uazapi integration
# Usage: Run this file or copy individual curl commands

BASE_URL="http://localhost:3000"
NGROK_URL="${NGROK_URL:-https://your-ngrok-url.ngrok.io}"  # Set this!

echo "🧪 WACRM uazapi Integration Tests"
echo "=================================="
echo ""

# ============================================================
# 1. CHECK WEBHOOK (Health check)
# ============================================================
echo "1️⃣  Webhook Health Check"
echo "GET $BASE_URL/api/whatsapp/webhook"
echo ""
curl -s "$BASE_URL/api/whatsapp/webhook" | jq . || echo "No GET handler (expected)"
echo ""
echo ""

# ============================================================
# 2. CHECK CONFIGURATION STATUS
# ============================================================
echo "2️⃣  Check WhatsApp Config Status"
echo "GET $BASE_URL/api/whatsapp/config"
echo "(You'll need to be authenticated - use your session cookie)"
echo ""
# curl -s "$BASE_URL/api/whatsapp/config" -H "Cookie: auth-token=your-token" | jq .
echo "# Run this with your auth cookie:"
echo "curl -s '$BASE_URL/api/whatsapp/config' \\"
echo "  -H 'Cookie: your-auth-cookie' | jq ."
echo ""
echo ""

# ============================================================
# 3. INITIATE uazapi CONNECTION
# ============================================================
echo "3️⃣  Initiate uazapi Connection (QR Code)"
echo "POST $BASE_URL/api/whatsapp/config/connect-uazapi"
echo "(Returns QR code to scan with WhatsApp)"
echo ""
echo "curl -X POST '$BASE_URL/api/whatsapp/config/connect-uazapi' \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -H 'Cookie: your-auth-cookie' \\"
echo "  -d '{\"phone\": \"5511999999999\"}' | jq ."
echo ""
echo ""

# ============================================================
# 4. TEST WEBHOOK RECEIVER (Simulate uazapi sending)
# ============================================================
echo "4️⃣  Simulate Incoming Message from uazapi"
echo "POST $BASE_URL/api/whatsapp/webhook"
echo "(This is what uazapi sends when a message arrives)"
echo ""
echo "curl -X POST '$BASE_URL/api/whatsapp/webhook' \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -H 'Authorization: Bearer test-token' \\"
echo "  -d '{
  \"event\": \"messages.new\",
  \"data\": {
    \"instanceId\": \"your-instance-id\",
    \"chatId\": \"5511999999999\",
    \"from\": \"5511999999999\",
    \"messageId\": \"true_5511999999999_123456789\",
    \"body\": \"Olá! Isso é um teste!\",
    \"type\": \"conversation\",
    \"timestamp\": 1234567890
  }
}' | jq ."
echo ""
echo ""

# ============================================================
# 5. TEST MESSAGE STATUS UPDATE
# ============================================================
echo "5️⃣  Simulate Message Status Update from uazapi"
echo "POST $BASE_URL/api/whatsapp/webhook"
echo "(This is what uazapi sends when a message is delivered)"
echo ""
echo "curl -X POST '$BASE_URL/api/whatsapp/webhook' \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -H 'Authorization: Bearer test-token' \\"
echo "  -d '{
  \"event\": \"message.status\",
  \"data\": {
    \"instanceId\": \"your-instance-id\",
    \"messageId\": \"true_5511999999999_123456789\",
    \"status\": \"delivered\",
    \"timestamp\": 1234567891
  }
}' | jq ."
echo ""
echo ""

# ============================================================
# 6. SEND MESSAGE (via uazapi)
# ============================================================
echo "6️⃣  Send Message via uazapi"
echo "POST $BASE_URL/api/whatsapp/send-message"
echo "(Sends a text message - requires valid conversation_id)"
echo ""
echo "curl -X POST '$BASE_URL/api/whatsapp/send-message' \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -H 'Cookie: your-auth-cookie' \\"
echo "  -d '{
  \"conversationId\": \"your-conversation-uuid\",
  \"messageType\": \"text\",
  \"contentText\": \"Oi! Sua mensagem via uazapi!\",
  \"replyToMessageId\": null
}' | jq ."
echo ""
echo ""

# ============================================================
# SETUP INSTRUCTIONS
# ============================================================
echo "📋 SETUP INSTRUCTIONS"
echo "====================="
echo ""
echo "Before running these tests:"
echo ""
echo "1. Make sure Next.js is running:"
echo "   cd wacrm && npm run dev"
echo ""
echo "2. Make sure ngrok is exposing port 3000:"
echo "   ngrok http 3000"
echo ""
echo "3. Update NGROK_URL above with the ngrok URL"
echo ""
echo "4. Configure webhook in uazapi dashboard:"
echo "   Webhook URL: \$NGROK_URL/api/whatsapp/webhook"
echo ""
echo "5. Connect a WhatsApp number (get QR code from Passo 3)"
echo ""
echo "6. Then run tests 4 & 5 to simulate incoming messages"
echo ""
