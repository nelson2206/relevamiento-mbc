-- Migración 023 (2026-11-02): carga masiva de documentos con sección y detección de duplicados.
-- Aplicar UNA vez:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-023.sql
-- documentos.seccion: sección (dentro de la gerencia) a la que pertenece el documento; '' = toda la gerencia. La IA clasifica solo dentro de ella.
-- documentos.hash: SHA-256 del archivo, para no cargar dos veces el mismo documento en una campaña.
-- estado_ia gana el valor «analizando» (el análisis automático al cargar sigue en segundo plano); no requiere cambio de columna.
ALTER TABLE documentos ADD COLUMN seccion TEXT NOT NULL DEFAULT '';
ALTER TABLE documentos ADD COLUMN hash TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS ix_doc_hash ON documentos(campana_id, hash);
