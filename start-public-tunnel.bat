@echo off
title WhatsApp Direct Sender - Public Cloudflare Tunnel
echo ========================================================
echo  WhatsApp Direct Sender - Cloudflare Public Tunnel
echo ========================================================
echo.
echo Forwarding port 3000 to a free, secure Cloudflare HTTPS URL...
echo Look for the link ending in .trycloudflare.com below:
echo.
.\cloudflared.exe tunnel --url http://localhost:3000
pause
