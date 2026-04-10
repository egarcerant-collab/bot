@echo off
title Deploy Voice Bot a Railway
echo.
echo  ==========================================
echo   DEPLOY VOICE BOT -^> RAILWAY
echo  ==========================================
echo.

cd /d "%~dp0"

echo [1/3] Iniciando sesion en Railway...
echo       (Se abrira el navegador para confirmar)
echo.
railway login

echo.
echo [2/3] Vinculando proyecto...
railway link --project 781e1e1f-a219-42a3-97df-1f359b07be44 --environment 56c0d42c-de61-426c-8276-7cabdc6cea60 --service dfc07d88-6e00-494f-abc7-84946e6517b0

echo.
echo [3/3] Subiendo y desplegando codigo...
railway up --ci

echo.
echo  ==========================================
echo   DEPLOY COMPLETADO! Bot activo en Railway
echo  ==========================================
echo.
pause
