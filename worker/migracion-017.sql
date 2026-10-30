-- Migración 017 (2026-10-28): PIN de 4 dígitos del colaborador (solo su huella con sal), bloqueo por intentos y último acceso.
-- Solo agrega columnas. Quien ya estaba registrado crea su PIN en su próximo ingreso. Aplicar UNA vez:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-017.sql
ALTER TABLE encuestados ADD COLUMN pin_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE encuestados ADD COLUMN pin_sal TEXT NOT NULL DEFAULT '';
ALTER TABLE encuestados ADD COLUMN pin_fallos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE encuestados ADD COLUMN pin_bloqueo TEXT NOT NULL DEFAULT '';   -- ISO: no se admiten intentos hasta esa hora
ALTER TABLE encuestados ADD COLUMN ultimo_acceso TEXT;
