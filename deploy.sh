#!/bin/bash
# Script para desplegar el voice bot en Railway
# Ejecuta esto en tu terminal una sola vez

PROJECT_ID="781e1e1f-a219-42a3-97df-1f359b07be44"
ENVIRONMENT_ID="56c0d42c-de61-426c-8276-7cabdc6cea60"
SERVICE_ID="dfc07d88-6e00-494f-abc7-84946e6517b0"

echo "🚂 Iniciando deploy en Railway..."

# 1. Login (abre el navegador)
railway login

# 2. Vincular proyecto/entorno/servicio
railway link \
  --project "$PROJECT_ID" \
  --environment "$ENVIRONMENT_ID" \
  --service "$SERVICE_ID"

# 3. Subir y desplegar
railway up --ci

echo "✅ Deploy completado!"
