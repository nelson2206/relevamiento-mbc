-- Migración 026 (2026-11-11): embudo de puntos de contacto (registro de eventos con fecha + foto diaria de avance).
-- Solo agrega tablas nuevas: no altera ninguna existente. Aplicar UNA vez, con punto de restauración previo:
--   npx wrangler d1 time-travel info voz-relevamiento
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-026.sql
-- Orden de despliegue: aplicar ESTA migración antes de publicar el Worker. Si el Worker se publica sin ella, la encuesta sigue funcionando
-- (el registro de eventos falla en silencio y queda en el log como evento_error), pero no se guarda ningún evento.
-- Definiciones y campos: docs/EMBUDO-definiciones.md y docs/EMBUDO-diccionario.md.
CREATE TABLE IF NOT EXISTS eventos (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  tipo TEXT NOT NULL,                       -- catálogo cerrado en src/embudo.js (EVENTOS)
  actor_tipo TEXT NOT NULL DEFAULT '',      -- gerente | supervisor | cliente | persona | admin | anonimo | sistema
  actor_id TEXT NOT NULL DEFAULT '',        -- supervisores.id, encuestados.id o ''
  persona_id TEXT NOT NULL DEFAULT '',      -- persona sobre la que trata el evento (encuestados.id)
  gerencia TEXT NOT NULL DEFAULT '',        -- copia del momento
  seccion TEXT NOT NULL DEFAULT '',
  proceso_id TEXT NOT NULL DEFAULT '',
  canal TEXT NOT NULL DEFAULT '',           -- correo | enlace | invitacion | outlook | copiar | whatsapp | otro
  visitante TEXT NOT NULL DEFAULT '',       -- UUID aleatorio del navegador: solo une una apertura anónima con la persona que luego se identifica
  reconstruido INTEGER NOT NULL DEFAULT 0,  -- 1 = creado por el backfill desde datos anteriores (aproximado)
  clave TEXT,                               -- idempotencia: NULL = evento que se repite
  detalle TEXT NOT NULL DEFAULT '{}',       -- JSON con lista blanca de claves; nunca textos, PIN, claves, tokens ni correos
  creado TEXT NOT NULL                      -- ISO UTC, igual que el resto de tablas
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ev_clave ON eventos(clave);   -- los NULL no chocan entre sí
CREATE INDEX IF NOT EXISTS ix_ev_tipo ON eventos(campana_id, tipo, creado);
CREATE INDEX IF NOT EXISTS ix_ev_persona ON eventos(campana_id, persona_id, tipo, creado);
CREATE INDEX IF NOT EXISTS ix_ev_visitante ON eventos(visitante, tipo, creado) WHERE visitante <> '';

CREATE TABLE IF NOT EXISTS avance_diario (
  campana_id TEXT NOT NULL,
  dia TEXT NOT NULL,                        -- AAAA-MM-DD en hora de Lima (UTC-5, sin horario de verano)
  gerencia TEXT NOT NULL,
  seccion TEXT NOT NULL,
  procesos_vigentes INTEGER NOT NULL DEFAULT 0,      -- procesos con fuera_alcance=0
  procesos_sin_cobertura INTEGER NOT NULL DEFAULT 0, -- estado de cobertura.js
  procesos_en_curso INTEGER NOT NULL DEFAULT 0,
  procesos_respondidos INTEGER NOT NULL DEFAULT 0,
  procesos_no_vigentes INTEGER NOT NULL DEFAULT 0,
  procesos_validados INTEGER NOT NULL DEFAULT 0,     -- procesos.validacion='validado' (lo marca MBC)
  puntos_cubiertos INTEGER NOT NULL DEFAULT 0,       -- suma de cobertura(pid).puntos
  puntos_total INTEGER NOT NULL DEFAULT 0,           -- suma de cobertura(pid).total
  personas INTEGER NOT NULL DEFAULT 0,
  personas_con_acceso INTEGER NOT NULL DEFAULT 0,    -- pin_hash <> ''
  personas_con_respuesta INTEGER NOT NULL DEFAULT 0, -- con al menos una respuesta con contenido
  reconstruido INTEGER NOT NULL DEFAULT 0,           -- 1 = foto inicial tomada al desplegar, no al cierre del día
  generado TEXT NOT NULL,
  PRIMARY KEY (campana_id, dia, gerencia, seccion)
);
