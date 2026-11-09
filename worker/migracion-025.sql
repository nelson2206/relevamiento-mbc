-- Migración 025 (2026-11-09): tope diario de dictado por voz (Whisper).
-- Con Workers Paid lo que pasa del cupo gratuito de la cuenta se cobra sin tope de Cloudflare; esta tabla lleva los
-- segundos de audio enviados por día (UTC, que es cuando Cloudflare reinicia el cupo). Tope en wrangler.toml: IA_MINUTOS_DIA.
-- Aplicar UNA vez:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-025.sql
CREATE TABLE IF NOT EXISTS uso_ia (
  dia TEXT PRIMARY KEY,              -- AAAA-MM-DD en UTC
  segundos REAL NOT NULL DEFAULT 0,  -- audio enviado a Whisper (cada intento cuenta, también los reintentos)
  llamadas INTEGER NOT NULL DEFAULT 0
);
