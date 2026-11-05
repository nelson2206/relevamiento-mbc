-- Migración 024 (2026-11-05): lectura independiente por proceso de un documento multiclasificado (HU03-b).
-- Aplicar UNA vez:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-024.sql
-- documento_extracciones.estado pasa a: pendiente (en cola) -> leyendo -> procesando -> generado | error. El antiguo «ok» se convierte en «generado».
-- documento_extraccion_historial: una fila por ejecución de un par (documento, proceso); sobrevive a quitar el proceso del documento.
CREATE TABLE IF NOT EXISTS documento_extraccion_historial (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  documento_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  origen TEXT NOT NULL,                        -- confirmacion | reproceso | automatico
  solicitado_por TEXT NOT NULL DEFAULT '',
  inicio TEXT NOT NULL,                        -- ISO, p. ej. 2026-11-05T17:05:16.678Z
  fin TEXT NOT NULL DEFAULT '',
  resultado TEXT NOT NULL DEFAULT 'en_curso',  -- en_curso | generado | error
  mensaje TEXT NOT NULL DEFAULT '',
  puntos INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_dxh_doc ON documento_extraccion_historial(documento_id, proceso_id, inicio);
UPDATE documento_extracciones SET estado='generado' WHERE estado='ok';
