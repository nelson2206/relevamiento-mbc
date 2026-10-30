-- Voz MBC · Relevamiento de procesos — base D1 (voz-relevamiento)
-- Base nueva: npx wrangler d1 execute voz-relevamiento --remote --file=schema.sql   (trae TODO el estado actual, hasta la migración 021:
--   NO apliques después las migraciones 002 a 021, que solo sirven para actualizar una base que ya existía).
-- Base existente: aplicar, en orden, las migraciones posteriores a la última que ya tiene (migracion-NNN.sql).
-- El audio NUNCA se guarda: solo el texto que el encuestado revisa y confirma.

CREATE TABLE IF NOT EXISTS campanas (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  cliente TEXT NOT NULL,
  glosario TEXT NOT NULL DEFAULT '',   -- términos para mejorar la transcripción (siglas, sistemas, marcas)
  creada TEXT NOT NULL,
  codigo_publico TEXT,                 -- código del enlace abierto (?c=)
  abierta INTEGER NOT NULL DEFAULT 0,  -- 1 = el enlace abierto acepta registros
  dominio TEXT NOT NULL DEFAULT '',    -- dominio de correo exigido al registrarse (opcional)
  logo TEXT NOT NULL DEFAULT '',       -- logo del cliente (data URI) que se muestra en la encuesta
  ia_auto INTEGER NOT NULL DEFAULT 1,  -- 1 = la tarea programada completa la matriz con la IA
  umbral_confianza REAL NOT NULL DEFAULT 0.7,  -- bajo este valor, la clasificación de un documento se resalta como de baja confianza (migracion-019.sql)
  estandares TEXT NOT NULL DEFAULT '',  -- glosario de estándares (TPS, Toyota Way, ISO…); vacío = el glosario base del Worker
  codigo_cliente TEXT,                  -- código de acceso de la administradora del cliente (migracion-011.sql)
  cliente_activo INTEGER NOT NULL DEFAULT 0,
  cliente_ultimo TEXT,                  -- último ingreso del cliente
  invitacion TEXT NOT NULL DEFAULT '',  -- texto de invitación de la campaña (vacío = texto base)
  cliente_alias TEXT NOT NULL DEFAULT '' -- nombre de la dirección del panel del cliente (migracion-012.sql)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_camp_codigo ON campanas(codigo_publico);

CREATE TABLE IF NOT EXISTS encuestados (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  correo TEXT NOT NULL DEFAULT '',
  gerencia TEXT NOT NULL,
  seccion TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT '',        -- líder / soporte
  estado TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente / en_curso / enviado
  actualizado TEXT,
  origen TEXT NOT NULL DEFAULT 'carga',      -- carga (Excel) / abierto (se registró solo)
  creado TEXT,                               -- cuándo se cargó o registró (para medir inactividad)
  pin_hash TEXT NOT NULL DEFAULT '',         -- PIN de 4 dígitos: huella PBKDF2 con sal propia
  pin_sal TEXT NOT NULL DEFAULT '',
  pin_fallos INTEGER NOT NULL DEFAULT 0,
  pin_bloqueo TEXT NOT NULL DEFAULT '',      -- ISO: sin intentos hasta esa hora
  ultimo_acceso TEXT
);
CREATE INDEX IF NOT EXISTS ix_enc_campana ON encuestados(campana_id);
CREATE INDEX IF NOT EXISTS ix_enc_correo ON encuestados(campana_id, correo);

CREATE TABLE IF NOT EXISTS procesos (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  codigo TEXT NOT NULL DEFAULT '',
  gerencia TEXT NOT NULL,
  seccion TEXT NOT NULL,
  macroproceso TEXT NOT NULL DEFAULT '',
  proceso TEXT NOT NULL DEFAULT '',
  subproceso TEXT NOT NULL DEFAULT '',
  descripcion TEXT NOT NULL DEFAULT '',
  fuente TEXT NOT NULL DEFAULT 'inventario',   -- inventario / nuevo (encuestado) / consultor
  creado_por TEXT,                              -- encuestado que lo agregó (si es nuevo)
  orden INTEGER NOT NULL DEFAULT 0,
  matriz TEXT NOT NULL DEFAULT '{}',            -- fila de la matriz (JSON): columnas del inventario del cliente + contrato
  validacion TEXT NOT NULL DEFAULT '',          -- '' / actualizado / validado
  validado_por TEXT NOT NULL DEFAULT '',        -- cargo de quien validó
  validado_en TEXT,
  actualizado_en TEXT,
  entrevista TEXT NOT NULL DEFAULT '',          -- '' (pendiente) / agendada / realizada
  entrevista_fecha TEXT,                        -- AAAA-MM-DD
  entrevistado TEXT NOT NULL DEFAULT '',        -- cargo o persona entrevistada
  fuera_alcance INTEGER NOT NULL DEFAULT 0,     -- 1 = no se levanta en la encuesta (p. ej. compra de bienes y servicios)
  personas TEXT NOT NULL DEFAULT '',            -- nombres del inventario anterior, uno por línea (buscador por persona)
  matriz_ia TEXT NOT NULL DEFAULT '{}',         -- campos de la matriz que llenó la IA: {campo: {estado, en}}
  quitado_por TEXT NOT NULL DEFAULT ''          -- quién quitó el proceso de la lista (migracion-014.sql)
);
CREATE INDEX IF NOT EXISTS ix_proc_campana ON procesos(campana_id, gerencia, seccion);

-- Lo que cada encuestado dice del proceso precargado: sigue vigente, cambió o ya no se hace.
CREATE TABLE IF NOT EXISTS revisiones (
  encuestado_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  estado TEXT NOT NULL,          -- vigente / cambio / no_participo / no_existe
  comentario TEXT NOT NULL DEFAULT '',
  actualizado TEXT NOT NULL,
  PRIMARY KEY (encuestado_id, proceso_id)
);

-- Procesos que una persona eligió con el buscador (pueden ser de cualquier gerencia).
CREATE TABLE IF NOT EXISTS asignaciones (
  encuestado_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  creado TEXT NOT NULL,
  origen TEXT NOT NULL DEFAULT 'encuestado',   -- encuestado (lo eligió) / consultor / inventario (por su nombre)
  PRIMARY KEY (encuestado_id, proceso_id)
);
CREATE INDEX IF NOT EXISTS ix_asig_proceso ON asignaciones(proceso_id);

CREATE TABLE IF NOT EXISTS respuestas (
  encuestado_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  pregunta TEXT NOT NULL,        -- q1..q6
  texto TEXT NOT NULL DEFAULT '',
  sistemas TEXT NOT NULL DEFAULT '[]',   -- JSON: sistemas del catálogo marcados (q3 o bloque 2)
  checklist TEXT NOT NULL DEFAULT '{}',  -- JSON por punto del bloque: {estado: cubierto/falta/no_aplica, fuente: ia/persona, evidencia}
  actualizado TEXT NOT NULL,
  PRIMARY KEY (encuestado_id, proceso_id, pregunta)
);
CREATE INDEX IF NOT EXISTS ix_resp_proceso ON respuestas(proceso_id);

CREATE TABLE IF NOT EXISTS sistemas (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_sis_campana ON sistemas(campana_id);

-- Resultado de la estructuración con IA, una fila por proceso (se sobrescribe al regenerar).
CREATE TABLE IF NOT EXISTS estructurado (
  proceso_id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  datos TEXT NOT NULL,           -- JSON con campos {valor, estado, evidencia} y preguntas de validación
  modelo TEXT NOT NULL,
  generado TEXT NOT NULL
);

-- Precarga del checklist desde documentos cargados en la consola (2026-10-13). El texto es interno: la encuesta solo recibe qué puntos están cubiertos.
CREATE TABLE IF NOT EXISTS precarga (
  proceso_id TEXT NOT NULL,
  bloque TEXT NOT NULL,
  punto TEXT NOT NULL,
  texto TEXT NOT NULL DEFAULT '',
  archivos TEXT NOT NULL DEFAULT '[]',
  creado TEXT NOT NULL,
  actualizado TEXT NOT NULL,
  PRIMARY KEY (proceso_id, punto)
);
CREATE INDEX IF NOT EXISTS ix_precarga_proceso ON precarga(proceso_id);

-- Enlaces por sección (2026-10-16): disponibilidad por fecha de cada sección, texto de invitación y acceso del cliente (solo lectura).
-- (campanas.codigo_cliente / cliente_activo / cliente_ultimo / invitacion: migracion-011.sql, ya incluidas arriba.)
CREATE TABLE IF NOT EXISTS ventanas (
  campana_id TEXT NOT NULL,
  gerencia TEXT NOT NULL,
  seccion TEXT NOT NULL,
  abre TEXT NOT NULL DEFAULT '',
  cierra TEXT NOT NULL DEFAULT '',
  mensaje TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (campana_id, gerencia, seccion)
);

-- Perfil Supervisor, delegaciones, acciones y límite de intentos (migracion-013.sql)
CREATE TABLE IF NOT EXISTS supervisores (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  nombre TEXT NOT NULL,
  correo TEXT NOT NULL DEFAULT '',
  clave_hash TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1,
  alcance TEXT NOT NULL DEFAULT '{"todo":false}',
  creado TEXT NOT NULL,
  ultimo TEXT NOT NULL DEFAULT '',
  perfil TEXT NOT NULL DEFAULT 'gerente',   -- supervisor (su sección) / gerente (su gerencia, con validación final)
  encuestado_id TEXT NOT NULL DEFAULT ''    -- persona a la que se le dio el perfil desde la consola ('' = lo creó el cliente)
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_sup_clave ON supervisores(clave_hash);
CREATE INDEX IF NOT EXISTS ix_sup_camp ON supervisores(campana_id);
CREATE INDEX IF NOT EXISTS ix_sup_enc ON supervisores(encuestado_id);

CREATE TABLE IF NOT EXISTS delegaciones (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  encuestado_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  actor_tipo TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  actor_nombre TEXT NOT NULL DEFAULT '',
  creado TEXT NOT NULL,
  activa INTEGER NOT NULL DEFAULT 1,
  quitada TEXT NOT NULL DEFAULT '',
  quitada_por TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_del_camp ON delegaciones(campana_id, activa);
CREATE INDEX IF NOT EXISTS ix_del_enc ON delegaciones(encuestado_id, proceso_id);

CREATE TABLE IF NOT EXISTS acciones (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  actor_tipo TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  actor_nombre TEXT NOT NULL DEFAULT '',
  accion TEXT NOT NULL,
  detalle TEXT NOT NULL DEFAULT '',
  creado TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_acc_camp ON acciones(campana_id, creado);

CREATE TABLE IF NOT EXISTS login_intentos (
  ip TEXT NOT NULL,
  ventana INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, ventana)
);

-- Flujo guiado del Supervisor (migracion-014.sql)
CREATE TABLE IF NOT EXISTS flujo_pasos (
  campana_id TEXT NOT NULL,
  supervisor_id TEXT NOT NULL,
  paso INTEGER NOT NULL,
  confirmado_en TEXT NOT NULL,
  PRIMARY KEY (supervisor_id, paso)
);
CREATE INDEX IF NOT EXISTS ix_flujo_camp ON flujo_pasos(campana_id);
CREATE TABLE IF NOT EXISTS aprobaciones (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  supervisor_id TEXT NOT NULL,
  gerente TEXT NOT NULL DEFAULT '',
  gerencias TEXT NOT NULL DEFAULT '[]',
  procesos INTEGER NOT NULL DEFAULT 0,
  aprobado_en TEXT NOT NULL,
  activa INTEGER NOT NULL DEFAULT 1,
  reabierta_en TEXT NOT NULL DEFAULT '',
  reabierta_por TEXT NOT NULL DEFAULT '',
  motivo TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_aprob_camp ON aprobaciones(campana_id, activa);
CREATE INDEX IF NOT EXISTS ix_aprob_sup ON aprobaciones(supervisor_id, activa);

-- Esqueleto Área > Gerencia > Sección (migracion-015.sql)
CREATE TABLE IF NOT EXISTS estructura (
  campana_id TEXT NOT NULL,
  clave TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT '',
  gerencia TEXT NOT NULL,
  seccion TEXT NOT NULL DEFAULT '',
  orden INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campana_id, clave)
);

-- Documentos y su clasificación en procesos (migracion-019.sql); el archivo va a R2 (binding DOCS).
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

-- Historial de cambios de la matriz (HU03, migración 020): quién cambió qué campo, cuándo y desde dónde.
CREATE TABLE IF NOT EXISTS matriz_historial (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  campo TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'cambio',
  anterior TEXT NOT NULL DEFAULT '',
  nuevo TEXT NOT NULL DEFAULT '',
  origen TEXT NOT NULL,
  actor_rol TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL DEFAULT '',
  actor_nombre TEXT NOT NULL DEFAULT '',
  creado TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mh_proc ON matriz_historial(proceso_id, campo, creado);
CREATE INDEX IF NOT EXISTS ix_mh_camp ON matriz_historial(campana_id, creado);

-- Borradores de precarga extraídos de un documento al confirmar su proceso (migracion-021.sql). Hasta que el administrador los aprueba
-- no llegan a precarga, a la matriz ni a la encuesta.
CREATE TABLE IF NOT EXISTS precarga_borrador (
  id TEXT PRIMARY KEY,
  campana_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  documento_id TEXT NOT NULL,
  punto TEXT NOT NULL,
  bloque TEXT NOT NULL DEFAULT '',
  texto TEXT NOT NULL DEFAULT '',
  cita TEXT NOT NULL DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'borrador',
  editado INTEGER NOT NULL DEFAULT 0,
  creado TEXT NOT NULL,
  actualizado TEXT NOT NULL,
  resuelto_por TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pb_par_punto ON precarga_borrador(documento_id, proceso_id, punto);
CREATE INDEX IF NOT EXISTS ix_pb_proc ON precarga_borrador(proceso_id, estado);
CREATE TABLE IF NOT EXISTS documento_extracciones (
  documento_id TEXT NOT NULL,
  proceso_id TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  mensaje TEXT NOT NULL DEFAULT '',
  puntos INTEGER NOT NULL DEFAULT 0,
  descartados INTEGER NOT NULL DEFAULT 0,
  motivo TEXT NOT NULL DEFAULT '',
  actualizado TEXT NOT NULL,
  PRIMARY KEY (documento_id, proceso_id)
);
