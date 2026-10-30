-- Migración 019 (2026-10-28): documentos cargados en bloque (HU01) y su clasificación en procesos con IA (HU02).
-- Solo crea tablas y agrega una columna. Aplicar UNA vez:
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-019.sql
-- El archivo en sí va a R2 (binding DOCS, ver wrangler.toml): aquí solo queda su clave.
CREATE TABLE IF NOT EXISTS documentos (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT '',            -- extensión: pdf, docx, jpg, png...
  gerencia TEXT NOT NULL,                   -- metadato obligatorio; el administrador puede cambiarlo después
  clave_r2 TEXT NOT NULL DEFAULT '',
  tamano INTEGER NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'pendiente', -- pendiente (de clasificación) | clasificado
  estado_ia TEXT NOT NULL DEFAULT 'sin_analizar', -- sin_analizar | analizado | error
  confianza_min REAL,                       -- la menor confianza entre las sugerencias vigentes (para priorizar la revisión)
  cargado_por TEXT NOT NULL DEFAULT '',
  creado TEXT NOT NULL,
  actualizado TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_doc_camp ON documentos(campana_id, estado, creado);
CREATE INDEX IF NOT EXISTS ix_doc_ger ON documentos(campana_id, gerencia);

-- Historial de asociaciones documento-proceso: no se sobrescribe, lo quitado queda con vigente = 0.
CREATE TABLE IF NOT EXISTS documento_procesos (
  id TEXT PRIMARY KEY,
  documento_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  origen TEXT NOT NULL,                     -- ia | manual
  confianza REAL,                           -- 0 a 1; solo si origen = ia
  confirmado INTEGER NOT NULL DEFAULT 0,
  vigente INTEGER NOT NULL DEFAULT 1,
  actor TEXT NOT NULL DEFAULT '',
  creado TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_docproc_doc ON documento_procesos(documento_id, vigente);
CREATE INDEX IF NOT EXISTS ix_docproc_proc ON documento_procesos(proceso_id, vigente, confirmado);

-- Umbral de confianza (0 a 1) por debajo del cual la clasificación se resalta como de baja confianza.
ALTER TABLE campanas ADD COLUMN umbral_confianza REAL NOT NULL DEFAULT 0.7;
