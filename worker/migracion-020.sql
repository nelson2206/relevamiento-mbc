-- Migración 020 (2026-10-29): historial de cambios de la matriz (HU03, sincronización matriz ↔ encuesta).
-- Solo crea una tabla y un índice. Aplicar UNA vez:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-020.sql
-- procesos.matriz es la única fuente de las respuestas por campo; aquí queda quién cambió qué, cuándo y desde dónde.
CREATE TABLE IF NOT EXISTS matriz_historial (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  campo TEXT NOT NULL,                      -- clave de MATRIZ_CLAVES
  tipo TEXT NOT NULL DEFAULT 'cambio',      -- cambio | validacion (la persona confirmó que sigue vigente) | revocacion (deshizo esa confirmación)
  anterior TEXT NOT NULL DEFAULT '',
  nuevo TEXT NOT NULL DEFAULT '',
  origen TEXT NOT NULL,                     -- ia | precarga | documento | encuesta | consola | importacion
  actor_rol TEXT NOT NULL DEFAULT '',       -- admin | encuestado | ia
  actor_id TEXT NOT NULL DEFAULT '',
  actor_nombre TEXT NOT NULL DEFAULT '',
  creado TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mh_proc ON matriz_historial(proceso_id, campo, creado);
CREATE INDEX IF NOT EXISTS ix_mh_camp ON matriz_historial(campana_id, creado);
