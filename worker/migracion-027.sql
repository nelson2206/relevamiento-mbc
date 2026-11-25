-- Migración 027 (2026-11-25): registro de los borrados forzados del Constructor (procesos con validación, precarga o matriz que se borraron a propósito).
-- Solo agrega una tabla nueva. Aplicar UNA vez, con punto de restauración previo:
--   npx wrangler d1 time-travel info voz-relevamiento
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-027.sql
-- Orden de despliegue: aplicar ESTA migración antes de publicar el Worker (sin ella el borrado forzado falla y no borra nada).
CREATE TABLE IF NOT EXISTS borrados_forzados (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  gerencia TEXT NOT NULL DEFAULT '',
  seccion TEXT NOT NULL DEFAULT '',
  macroproceso TEXT NOT NULL DEFAULT '',
  proceso TEXT NOT NULL DEFAULT '',
  subproceso TEXT NOT NULL DEFAULT '',
  alcance TEXT NOT NULL DEFAULT 'proceso',   -- proceso | grupo (macroproceso o proceso borrado con sus subprocesos)
  motivos TEXT NOT NULL DEFAULT '',          -- validado, precarga, matriz (lo que se perdió)
  nombre_confirmado TEXT NOT NULL DEFAULT '',-- lo que escribió la persona para confirmar
  validacion TEXT NOT NULL DEFAULT '',
  matriz TEXT NOT NULL DEFAULT '{}',         -- copia de la matriz al borrar (permite reconstruirla)
  precarga TEXT NOT NULL DEFAULT '[]',       -- copia de la precarga al borrar: [{punto, texto, archivos}]
  actor_nombre TEXT NOT NULL DEFAULT '',
  creado TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bf_camp ON borrados_forzados(campana_id, creado);
