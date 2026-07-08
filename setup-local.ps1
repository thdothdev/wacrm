# Quick setup script for WACRM + uazapi local development
# Uso: powershell -ExecutionPolicy Bypass -File "setup-local.ps1"

Write-Host "🚀 WACRM + uazapi Local Setup" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Check Node.js
Write-Host "✓ Checking Node.js..." -ForegroundColor Yellow
$nodeVersion = node --version 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  Node.js $nodeVersion found ✓" -ForegroundColor Green
} else {
    Write-Host "  ERROR: Node.js not found. Please install from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# Step 2: Install dependencies
Write-Host ""
Write-Host "✓ Installing npm dependencies..." -ForegroundColor Yellow
cd "c:\Users\Matheus Henrique\Desktop\wacrm\wacrm"
npm install --silent
if ($LASTEXITCODE -eq 0) {
    Write-Host "  Dependencies installed ✓" -ForegroundColor Green
} else {
    Write-Host "  ERROR: npm install failed" -ForegroundColor Red
    exit 1
}

# Step 3: Check .env.local
Write-Host ""
Write-Host "✓ Checking .env.local..." -ForegroundColor Yellow
if (Test-Path ".env.local") {
    $envContent = Get-Content ".env.local" | Select-String "UAZAPI"
    if ($envContent) {
        Write-Host "  .env.local configured with uazapi ✓" -ForegroundColor Green
    } else {
        Write-Host "  WARNING: UAZAPI variables not found in .env.local" -ForegroundColor Yellow
    }
} else {
    Write-Host "  ERROR: .env.local not found" -ForegroundColor Red
    exit 1
}

# Step 4: Check ngrok
Write-Host ""
Write-Host "✓ Checking ngrok..." -ForegroundColor Yellow
$ngrokVersion = ngrok version 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ngrok is installed ✓" -ForegroundColor Green
} else {
    Write-Host "  WARNING: ngrok not found. Installing globally..." -ForegroundColor Yellow
    npm install -g ngrok --silent
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ngrok installed ✓" -ForegroundColor Green
    }
}

# Step 5: Ready to start
Write-Host ""
Write-Host "================================" -ForegroundColor Cyan
Write-Host "✅ Setup Complete!" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "📋 Next Steps:" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. START DEV SERVER (Terminal 1):" -ForegroundColor Yellow
Write-Host "   cd 'c:\Users\Matheus Henrique\Desktop\wacrm\wacrm'" -ForegroundColor Gray
Write-Host "   npm run dev" -ForegroundColor Gray
Write-Host ""
Write-Host "2. START NGROK (Terminal 2):" -ForegroundColor Yellow
Write-Host "   ngrok http 3000" -ForegroundColor Gray
Write-Host "   (Copie a URL como https://xxxx-xx.ngrok.io)" -ForegroundColor Gray
Write-Host ""
Write-Host "3. CONFIGURE WEBHOOK in uazapi Dashboard:" -ForegroundColor Yellow
Write-Host "   Webhook URL: https://seu-ngrok-url/api/whatsapp/webhook" -ForegroundColor Gray
Write-Host ""
Write-Host "4. CONNECT NUMBER (Terminal 3):" -ForegroundColor Yellow
Write-Host "   curl -X POST http://localhost:3000/api/whatsapp/config/connect-uazapi" -ForegroundColor Gray
Write-Host ""
Write-Host "📚 For more details, see UAZAPI_SETUP.md" -ForegroundColor Cyan
Write-Host ""
Write-Host "🆘 Having issues? Check UAZAPI_SETUP.md troubleshooting section" -ForegroundColor Cyan
