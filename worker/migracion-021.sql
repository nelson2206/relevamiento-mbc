-- Migración 021 (2026-10-29): extracción de precarga al confirmar el proceso de un documento (borradores para revisión del administrador).
-- Solo crea tablas e índices. Aplicar UNA vez:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-021.sql
-- Los borradores viven aparte de `precarga`: la encuesta, la revisión por bloque y la estructuración con IA no los ven hasta que se aprueban.
CREATE TABLE IF NOT EXISTS precarga_borrador (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  documento_id TEXT NOT NULL,
  punto TEXT NOT NULL,
  bloque TEXT NOT NULL DEFAULT '',
  texto TEXT NOT NULL DEFAULT '',
  cita TEXT NOT NULL DEFAULT '',            -- fragmento literal del documento que sustenta el texto
  estado TEXT NOT NULL DEFAULT 'borrador',  -- borrador | aprobado | descartado
  editado INTEGER NOT NULL DEFAULT 0,       -- 1 = el administrador cambió el texto: una reextracción no lo pisa
  creado TEXT NOT NULL,
  actualizado TEXT NOT NULL,
  resuelto_por TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pb_par_punto ON precarga_borrador(documento_id, proceso_id, punto);
CREATE INDEX IF NOT EXISTS ix_pb_proc ON precarga_borrador(proceso_id, estado);

-- Estado de la extracción de cada par (documento, proceso): para mostrarlo en la bandeja y poder reintentar.
CREATE TABLE IF NOT EXISTS documento_extracciones (
  documento_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | ok | error
  mensaje TEXT NOT NULL DEFAULT '',
  puntos INTEGER NOT NULL DEFAULT 0,
  descartados INTEGER NOT NULL DEFAULT 0,   -- puntos sin cita válida que se descartaron
  motivo TEXT NOT NULL DEFAULT '',          -- si el documento no trata del proceso, qué se ve
  actualizado TEXT NOT NULL,
  PRIMARY KEY (documento_id, proceso_id)
);
