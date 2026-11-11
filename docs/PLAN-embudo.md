# Plan: embudo de puntos de contacto (fase 1, sin código)

> Fecha: 11-nov-2026 · Cierre del proyecto: 30-nov-2026 · Base: `main` (HEAD 4e90f1e, PR #12) · Pruebas unitarias hoy: 256 de 256 en verde (corrida local).
> Alcance de este documento: solo lectura del código. No se tocó código, esquema ni migraciones; no se llamó a producción. Las cifras del negocio (0 de 304 procesos, 16 personas, 13 gerencias sin iniciar) vienen del prompt y **no se verificaron** aquí.
> Todo número de línea es de `main` al 11-nov-2026 y se verificó en el código.

## 0. Resumen

1. Se agrega un registro de eventos de solo inserción (`eventos`, migración **026**, siguiente libre) y una foto diaria (`avance_diario`), en un solo archivo de migración para tener una sola ventana de producción.
2. Todo el código nuevo vive en `worker/src/embudo.js` (catálogo, registro, backfill, extracción). En `index.js` solo se agregan líneas de enlace en las rutas existentes: baja el riesgo de choque con Matías Tejada.
3. El registro nunca rompe la acción principal: `ctx.waitUntil` con captura de error; si no hay `ctx`, `try/catch` y `log('evento_error')`.
4. Idempotencia con una columna `clave` única (`INSERT OR IGNORE`): los eventos de «primera vez» no se duplican, las visitas sí se repiten.
5. El visitante anónimo del enlace de sección se une con la persona mediante un id aleatorio por navegador (`localStorage`, con `try/catch`) que viaja en `/r/abierta`, `/r/identificar` y `/r/registro`. Sin IP, sin terceros, sin píxeles.
6. El backfill es una ruta de administrador con `INSERT OR IGNORE … SELECT` (una sentencia por tipo), marcada `reconstruido=1`; no inventa aperturas: la fecha de «abrió» se infiere en la extracción y se rotula `inferido`.
7. La extracción es `GET /a/embudo/export` (JSON o CSV con BOM y `;`) con tres conjuntos: `eventos`, `personas`, `avance_diario`. Sin pantalla.
8. **Paquete 1 (2-3 días, ~16 h)**: eventos de los pasos 3 a 6 + backfill + extracción `personas` (y `eventos`). Publicable el 13-nov.
9. Paquetes 2 y 3 completan pasos 1-2, foto diaria, `pin_fallido`, `proceso_completo`, validación y vistas SQL (~22 h más).
10. Hallazgos que cambian el diagnóstico (sección 1): `enlace_copiado` hoy no se dispara desde ninguna pantalla; abrir con `?k=` no deja rastro ni en `ultimo_acceso`; `procesos.validacion` la pone MBC, no el gerente; ya existe la tabla `delegaciones` con persona y fecha.

---

## 1. Correcciones y precisiones al diagnóstico

| # | Dice el prompt | Lo que hay en el código | Dónde |
|---|---|---|---|
| C1 | `enlace_copiado` / `correo_generado` guardan solo la cantidad | Correcto, pero además **`enlace_copiado` no se dispara desde ninguna pantalla**: el único llamado a `/c/enlaces` manda `para: 'correo'`. «Copiar enlace de la sección» e «invitación» son del navegador (`copiarAsyncCl`) y no llaman al servidor. Hoy pasar el enlace por WhatsApp no deja ningún rastro, ni siquiera conteo. | `index.js:2840`; `admin.html:3967`, `:3917-3918` (`enlace-sec`, `invitacion`); botón de la consola MBC `admin.html:3000` |
| C2 | «Con `?k=` solo se toca `encuestados.ultimo_acceso`» | **No se toca nada.** `ultimo_acceso` solo se escribe en `rutaIdentificar` (PIN) y al registrarse. `GET /r/sesion` (ruta de `?k=` y de cada recarga con sesión) no escribe nada. `marcarEnCurso` actualiza `actualizado`, no `ultimo_acceso`. Además el `?k=` ya no se reparte: `/c/enlaces` devuelve sin token y se entra por el enlace de sección con nombre y PIN. | `index.js:391` (sesión), `:828` y `:837` (único `tocarAcceso`), `:893` (registro), `:2837` (comentario «sin token»); `index.html:254`, `:333-338` |
| C3 | `encuestados.estado` pasa a `en_curso` al empezar a completar | `marcarEnCurso` se llama también al **confirmar la relación con un proceso, elegir procesos y crear uno nuevo**, no solo al responder. `en_curso` es más débil que «primera respuesta». | `index.js:366`; llamadas en `:502`, `:562`, `:602`, `:646`, `:672`, `:2456`, `:2475`, `:2480` |
| C4 | `respuestas.actualizado` se sobrescribe | Cierto en `rutaRespuesta` (`:656`) y `respuestaEstructurada` (`:643`). En `guardarChecklist` (`:1957`) el `ON CONFLICT` **no** actualiza `actualizado`: la fecha es la del último guardado de texto, no la de cualquier cambio. Sirve como cota superior de la primera respuesta, no como fecha exacta. | `index.js:1956-1960` |
| C5 | «A qué persona se compartió: no se puede saber» | Sí se sabe para **delegar**: la tabla `delegaciones` guarda persona, proceso, actor y fecha (`creado`). Y `acciones.detalle` de `delegar` trae `persona_id`. Solo `correo_generado`/`enlace_copiado` y `personas_agregadas` traen solo cantidad. | `schema.sql:171-185`; `index.js:2824`, `:2798` |
| C6 | Paso 7: «proceso completo → validado por el gerente» | `procesos.validacion='validado'` lo marca **MBC desde la consola** (`/a/matriz`, `/a/validacion`; `validado_por` es texto libre). El gerente en su panel hace otra cosa: confirma pasos 1-3 (`flujo_pasos.confirmado_en`) y da la **aprobación final** (`aprobaciones.aprobado_en`); su compuerta del paso 4 exige que MBC ya haya validado todos sus procesos. Son tres hitos distintos. | `index.js:1332-1367`, `:1371-1380`; `flujo.js:66`, `:170-193`; `schema.sql:207-228` |
| C7 | «`cobertura.js` es la regla única» | La regla está **duplicada**: `cobertura.js` (servidor) solo la usa `flujo.js:49`; la consola y el panel del cliente usan una copia en el navegador (`admin.html:794-840`). `index.js` no usa `crearCobertura`. El embudo usará `cobertura.js`; conviene una prueba de paridad (P3). | `cobertura.js:19`; `flujo.js:16`, `:49`; `admin.html:794`, `:831` |
| C8 | `supervisores.ultimo` se pisa en cada entrada (~2759) | Exacto. Además solo se escribe si `recarga` no es `1`; el administrador del cliente va a `campanas.cliente_ultimo` (`:2760`). La clave de gerente también se **regenera** (invalida la anterior) cada vez que se descargan enlaces personales: `rutaClavesPerfiles`. Eso puede dejar a un gerente con una clave ya inservible y debe verse en el embudo. | `index.js:2758-2760`; `usuarios.js:236-249` |
| C9 | `GET /r/abierta` (~754) solo hace `log()` | Exacto: función en `:754`, `log` en `:756`, ruta en `:2911`. Es una lectura que el navegador pide **una vez por carga de página** de un enlace `?c=` (`index.html:515`, `:525-526`); no hay sondeo. | — |
| C10 | `enlace_copiado` (~2840), `personas_agregadas` (~2798), `delegar` (~2824) | Líneas exactas. | `index.js` |

Sin diferencias: `acciones` sin persona para copiar/correo; `encuestados.creado` + `origen='abierto'` + `pin_hash` para el paso 5; la PIN de personas precargadas se fija en `exigirPin` (`:803-806`, devuelve `'creado'`) sin guardar la fecha; el cron `*/15` (`wrangler.toml:44`, `scheduled` en `index.js:2887`).

**Observación de producto (no es del embudo):** el flujo del gerente solo ve el avance por persona dentro de su alcance; no hay hoy ningún dato de «cuándo se le entregó la clave». `supervisores.creado` es la fecha de la **primera** clave; las regeneradas por `claves_regeneradas` guardan solo la cantidad.

---

## 2. Catálogo de eventos

### Reglas comunes

- Un evento es una fila de `eventos` (DDL en la sección 3). Constante única `EVENTOS` en `worker/src/embudo.js`; un tipo fuera del catálogo lanza error en pruebas y se ignora (con `log`) en producción.
- **`persona_id` = la persona sobre la que trata el evento** (destinatario del enlace, quien abre, quien responde, o el gerente mismo en sus eventos). `actor_tipo` y `actor_id` dicen quién lo hizo.
- `gerencia` y `seccion` se guardan en el evento (copia del momento): sobreviven a mover o renombrar procesos.
- `actor_tipo`: `gerente`, `supervisor` (perfil de la cuenta, `sup.perfil`), `cliente` (administrador del cliente), `persona`, `admin` (MBC), `anonimo`, `sistema` (backfill, cron). Se amplía el catálogo del prompt con `cliente` y `sistema`.
- `detalle` (JSON) **solo** admite claves de una lista blanca: `procesos` (n), `personas` (n), `pin` (`creado`|`ok`), `perfil`, `motivo`, `supervisor_id`, `bloque`, `punto_listos`, `fuente`, `validado_por`, `reconstruido`, `aprox`. Nunca textos de respuesta, PIN, claves, tokens ni correos. Una prueba lo verifica recorriendo cada emisor.
- Idempotente = lleva `clave` única; `clave` va en `NULL` para los eventos que sí se repiten.

### Paquete 1 — pasos 3 a 6

| Tipo | Paso | Cuándo se dispara | Dónde instrumentar | Campos que llena | Idempotente |
|---|---|---|---|---|---|
| `enlace_compartido` | 3 | El gerente genera el correo (`para:'correo'`) o pide el enlace (`para:'enlace'`) de una persona. Un evento **por persona**. Honestidad: es «generado/preparado», no «enviado» (el .eml queda como borrador de Outlook). | `rutaClienteEnlaces` `index.js:2830-2842`, justo donde hoy está `registrarAccion` (`:2840`); un solo `env.DB.batch` para todas las personas. | actor (tipo por `sup.perfil` o `cliente`, id del supervisor), `persona_id`, gerencia/sección de la persona, `canal` = `correo`\|`enlace` | No (cada recordatorio cuenta como contacto) |
| `procesos_delegados` | 3 | El gerente asigna procesos a una persona (`nuevos.length>0`). | `rutaClienteAsignar` `index.js:2803-2827`, junto a `registrarAccion('delegar')` (`:2824`) | actor, `persona_id`, `detalle.procesos` = n | No |
| `persona_agregada` | 3 | El gerente agrega una persona a su sección. Uno por persona nueva (`r.nuevos`). | `rutaClientePersonas` `index.js:2774-2800`, junto a `:2798` | actor, `persona_id`, gerencia/sección | Sí: `persona_agregada\|<persona_id>` |
| `enlace_abierto` | 4 | Una persona (aún anónima) carga la página del enlace de sección. **Solo si llega un `v` (visitante) válido** y no hubo otro del mismo visitante y misma sección en los últimos 30 minutos. | `rutaAbierta` `index.js:754`; ruta `:2911` pasa a `rutaAbierta(env, url, ctx)`. Se registra después de validar la sección (`:763-766`). | `actor_tipo='anonimo'`, `visitante`, gerencia, sección | No (visitas), pero con ventana anti-ruido de 30 min (una lectura indexada) |
| `persona_identificada` | 4 | La persona entra con nombre + PIN correctos. Une visitante y `persona_id`. Cada ingreso queda (sirve como conteo de visitas). | `rutaIdentificar` `index.js:831-840`, tras `tocarAcceso` (`:837`) | `actor_tipo='persona'`, `persona_id`, `visitante`, `detalle.pin` (`creado`\|`ok`) | No |
| `acceso_creado` | 5 | La persona fija su PIN por primera vez: (a) precargada por Excel → `exigirPin` devuelve `'creado'`; (b) se registra sola → `rutaRegistro`. | (a) `rutaIdentificar` `:836`, cuando `pin==='creado'`; (b) `rutaRegistro` tras el `INSERT` de `:892-893`, antes del `return` (~`:910`) | `persona_id`, `visitante`, `detalle.fuente`=`precargada`\|`registro_abierto` | Sí: `acceso_creado\|<persona_id>` |
| `primera_respuesta` | 6 | Primer guardado **con contenido** de una persona en un proceso (texto no vacío, o sistemas marcados, o respuesta estructurada con datos, o punto marcado «lo mencioné»). No cuenta la verificación de la IA. | Tres puntos de escritura de la persona: `rutaRespuesta` `:650-672` (INSERT `:656`); `respuestaEstructurada` `:637-648` (INSERT `:643`); `rutaPunto` `:2435-2456` y `rutaCampo` `:2463-2475` (ambas vía `guardarChecklist`). **No** `rutaVerificar` (`:2044`, IA). | `persona_id`, `proceso_id`, gerencia/sección, `detalle.bloque` | Sí: `primera_respuesta\|<persona_id>\|<proceso_id>` |

Costo de la idempotencia: `INSERT OR IGNORE` sobre un índice único; si la fila ya existe no escribe, solo lee el índice. Como `estado=en_curso` no es un filtro confiable (C3), se acepta una lectura de índice por guardado con contenido y se mide con `wrangler d1 insights` tras el despliegue (ver riesgos).

### Paquete 2 — pasos 1 y 2, foto diaria y errores

| Tipo | Paso | Cuándo | Dónde | Notas |
|---|---|---|---|---|
| `acceso_gerente_generado` | 1 | Se crea o regenera la clave de un gerente/supervisor. | `aplicarPerfil` `usuarios.js:122-159` (tras `:158`); `rutaClavesPerfiles` `usuarios.js:236-249` (uno por clave, `motivo='descarga_enlaces'`, y hoy **invalida** la anterior); `gestionarSupervisores` crear `:62` y clave nueva `:81` | `persona_id` = ficha del gerente si existe; `detalle.supervisor_id`, `perfil`, `motivo` (`alta`\|`regenerada`\|`descarga_enlaces`) |
| `acceso_gerente_enviado` | 1 | MBC (o el administrador del cliente) pulsa «Marcar como enviado» con canal. Ruta nueva `POST /a/persona/acceso-enviado` y variante `/c/…` para el cliente. | Botón en `dialogoAccesoPerfil` `admin.html:3399-3420` y en `mostrarAccesoSupCl` `admin.html:4122-4140` | `canal` = `outlook`\|`copiar`\|`whatsapp`\|`otro`. Sin píxel de rastreo. |
| `gerente_abrio` | 2 | Primer ingreso con clave al panel `/c` (`sup.ultimo===''` antes de actualizar; ya viene en `actor.sup`, sin lectura extra). | `rutaClienteCampana` `index.js:2758-2762` | Idempotente: `gerente_abrio\|<supervisor_id>` |
| `gerente_entro` | 2 | Cada ingreso (no recarga). | Mismo bloque `:2758` | No. También para el administrador del cliente (`actor_tipo='cliente'`). |
| `pin_fallido` | 5 | PIN incorrecto o cuenta bloqueada. | `exigirPin` `index.js:794`, antes de lanzar el 401 (`:826`) y el 423 (`:824`, `:813`, `:799`); `detalle.motivo`=`incorrecto`\|`bloqueado` | Se agrega al `batch` de `:817-820`; se descarta el tope por ráfaga: un evento por intento ya contado. |
| `enlace_seccion_copiado` | 3 | El gerente copia el enlace o la invitación de una sección (hoy no deja rastro, C1). Ruta nueva `POST /c/evento` con lista cerrada de tipos. | `admin.html:3917-3918` (y barra `:3807`) | Sin `persona_id`; `canal`=`enlace`\|`invitacion`. Sin esto, el paso 3 por WhatsApp es invisible. |

### Paquete 3 — avance y validación

| Tipo | Paso | Cuándo | Dónde | Notas |
|---|---|---|---|---|
| `bloque_completado` | 7 | Todos los puntos de un bloque quedan listos para una persona y proceso. | Tras el guardado en los mismos puntos que `primera_respuesta`, solo si hay `clave` no registrada: una lectura de las respuestas de esa persona y proceso + la precarga del proceso, y `crearCobertura(...).persona(pid, eid)` | Idempotente por persona, proceso y bloque |
| `proceso_completo` | 7 | `avancePersona().completo` pasa a verdadero para una persona y proceso (regla de `cobertura.js`, no otra). | Mismo cálculo | Idempotente. Es completo **de la persona**; el «respondido» del proceso (unión de equipo y documentos) sale en `avance_diario`. |
| `proceso_validado` | 7 | MBC marca `validacion='validado'`. | `rutaMatriz` `index.js:1346-1350` y `rutaValidacion` `:1371-1380` (esta última en bloque: 1 evento por proceso con `batch`) | `actor_tipo='admin'`, `detalle.validado_por` (nombre). No es el gerente (C6). |
| `flujo_paso_confirmado`, `aprobacion_final` | 7 | El gerente confirma un paso (1-3) o da la aprobación final. | `flujo.js:184` y `:192` (hoy solo en `acciones`) | Extensión del catálogo del prompt: es el verdadero hito del gerente. |
| `pin_restablecido`, `pin_desbloqueado` | 5 | MBC restablece o desbloquea. | `index.js:1407`, `:1414` | Opcional; ya están en `acciones` y se reconstruyen. |

---

## 3. DDL propuesto (sin aplicar)

Archivo `worker/migracion-026.sql` (siguiente número libre: la última es 025 y ninguna rama remota trae otra). Debe copiarse al estado final de `worker/schema.sql`: `esquema.test.mjs` falla si falta.

```sql
-- Migración 026 (2026-11-xx): embudo de puntos de contacto (registro de eventos + foto diaria).
-- Aplicar UNA vez (antes: npx wrangler d1 time-travel info voz-relevamiento):
--   npx wrangler d1 execute voz-relevamiento --remote --file=migracion-026.sql
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
  visitante TEXT NOT NULL DEFAULT '',       -- id aleatorio del navegador (UUID), solo para unir apertura anónima con persona
  reconstruido INTEGER NOT NULL DEFAULT 0,  -- 1 = creado por el backfill desde datos anteriores
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
```

Decisiones:
- Un solo archivo para las dos tablas aunque `avance_diario` se llene en el Paquete 2: una sola ventana de producción y un solo punto de restauración.
- Las filas de `avance_diario` son por sección; el total por gerencia sale sumando (todas las columnas son aditivas, incluidas las de personas).
- Foto del día: el cron ya corre cada 15 min; `scheduled` (`index.js:2887`) agrega una cuarta tarea independiente que, a partir de las 23:00 de Lima y si no hay fila del día, toma la foto con una sola lectura de la campaña y un `batch` (≈60 filas/día). Sin fila = día perdido, sin relleno retroactivo.
- Purga: los eventos y la foto se borran con la campaña (`rutaBorrarCampana` `index.js:1487` debe agregar `DELETE FROM eventos WHERE campana_id=?` y lo mismo para `avance_diario`, y `sentenciasRastroDeProcesos`/`rutaImportar modo reemplazar` **no** deben tocar `eventos`).

---

## 4. Cómo se une el visitante anónimo con la persona

1. **Generación**: en `index.html`, junto a la lectura de `params` (`:333-334`), `visitante()` lee `localStorage['relev-v']`; si no existe, `crypto.randomUUID()` y lo guarda, todo en `try/catch`. Si el almacenamiento está bloqueado, usa `sessionStorage`; si tampoco, no manda `v`. Un id aleatorio, sin datos personales, vive solo en ese navegador.
2. **Envío**: `cargarAbierto` agrega `&v=` a `/r/abierta` (`index.html:526`); `identificar` (`:642`) y los dos `POST /r/registro` (`:679`, `:774`) agregan `v` al cuerpo (`api()` ya hace `Object.assign` en `:352`). El servidor valida `^[0-9a-f-]{36}$`; cualquier otra cosa se descarta a `''`.
3. **Registro**: `enlace_abierto` (anónimo, con `visitante`) → luego `persona_identificada` y/o `acceso_creado` traen el mismo `visitante` y el `persona_id`.
4. **Unión en la extracción** (`personas.f_abrio`): se toman los visitantes de los eventos de la persona; `f_abrio` = el primer `enlace_abierto` de esos visitantes.
   - Si un visitante figura con **más de una** persona (equipo compartido), sus aperturas no se atribuyen a ninguna (`f_abrio_origen='ambiguo'`) y se cae a la regla 5.
5. **Respaldo**: si no hay apertura medida y la persona tiene `persona_identificada` o `acceso_creado` (medido o reconstruido), `f_abrio` = el más antiguo de ellos y `f_abrio_origen='inferido'` (para abrir el enlace hubo que cargar la página). Para quien nunca se identificó no hay manera de atribuir: solo queda el conteo por sección (`aperturas_seccion` y `visitantes_seccion` dentro de `avance_diario`/`eventos`).

Limitaciones que se documentan en `EMBUDO-definiciones.md`: el mismo individuo en dos dispositivos cuenta como dos visitantes; quien abre y no se identifica no es atribuible a una persona; navegadores con almacenamiento bloqueado no registran apertura (preferimos subcontar a inflar); no hay medición anterior al despliegue.

Los `?k=` personales antiguos no generan `enlace_abierto`: el token se acepta una vez y pasa a la sesión de pestaña (`index.html:333-338`); ya no se reparten (C2).

---

## 5. Backfill (una vez, idempotente, `reconstruido=1`)

Ruta: `POST /a/embudo/backfill {campana_id}` con código de administrador. Ejecuta un `env.DB.batch` de sentencias `INSERT OR IGNORE INTO eventos … SELECT …` (sin bucles en JavaScript: costo de CPU mínimo) con `id = lower(hex(randomblob(16)))`, `reconstruido=1`, `actor_tipo='sistema'` salvo indicación, `detalle` con `{"reconstruido":true,…}` y una `clave` derivada que hace seguro repetirla. Devuelve las filas insertadas por tipo (`meta.changes`).

| # | Evento | Consulta (origen) | Fecha | Limitación |
|---|---|---|---|---|
| B1 | `acceso_gerente_generado` | `supervisores` (perfil, `encuestado_id`) LEFT JOIN `encuestados`; clave `agg\|<sup.id>\|<creado>` | `supervisores.creado` | Es la **primera** clave. Las regeneradas por `claves_regeneradas` solo guardan cantidad (`acciones.detalle.personas`): se desconoce la fecha de la clave vigente. Las de `supervisor_clave_nueva` y `perfil_asignado` sí traen `supervisor_id` en `acciones.detalle` y se agregan con `json_extract`. |
| B2 | `gerente_abrio` | `MIN(acciones.creado)` por `actor_id` = supervisor (su primera acción prueba que ya había entrado); si no tiene acciones y `ultimo<>''`, `supervisores.ultimo` con `aprox:'ultimo'`. Clave `gabrio\|<sup.id>` | Cota superior de la primera apertura | `ultimo` es la **última** entrada (se pisa): dato de mínima. `ultimo=''` significa que nunca entró (no se crea evento). No hay número de visitas anterior. |
| B3 | `gerente_entro` | `supervisores.ultimo<>''`; clave `gentro\|<sup.id>\|<ultimo>` | `ultimo` | Un solo punto (la última entrada). |
| B4 | `procesos_delegados` | `delegaciones` agrupadas por `encuestado_id` y `actor_id`: `MIN(creado)` y `COUNT(*)` (`detalle.procesos`); actor por `actor_tipo`. Clave `del\|<enc>\|<actor>` | Primera delegación de ese actor a esa persona | Agrupa delegaciones posteriores en una sola. Incluye las quitadas (`activa=0`): se distingue con `detalle`. |
| B5 | `enlace_compartido` | Desde `acciones` (`correo_generado`, `enlace_copiado`): **sin `persona_id`**, `detalle.personas`=n. Clave `acc\|<acciones.id>` | `acciones.creado` | No dice a quién. Para el nivel persona el embudo usa B4 (`f_delegado`) como señal de contacto, y `f_compartido` queda vacío en lo reconstruido. |
| B6 | `persona_agregada` | `encuestados` con alguna `delegaciones` cuyo `actor_tipo` sea `supervisor`/`cliente` y `creado` ≈ `encuestados.creado` (≤ 5 min) | `encuestados.creado` | Aproximada: el alta por Excel y el alta del gerente comparten `origen='carga'` (`index.js:2576-2600`) y `personas_agregadas` no trae ids. |
| B7 | `acceso_creado` | `encuestados` con `pin_hash<>''`. `origen='abierto'`: `creado` (exacto). `origen='carga'`: el mínimo entre `ultimo_acceso`, primera `revisiones.actualizado` y primera `respuestas.actualizado` (cota superior). Clave `acc\|<enc>` | ver columna | En precargados la fecha de fijar el PIN no se guardó nunca; marcada `aprox:'cota'`. |
| B8 | `persona_identificada` | `encuestados.ultimo_acceso<>''`; clave `ident\|<enc>\|<ultimo_acceso>` | `ultimo_acceso` | Solo la última entrada. Sin visitante. |
| B9 | `primera_respuesta` | `respuestas` con contenido (`texto<>''` o `sistemas<>'[]'` o `checklist<>'{}'`) agrupadas por (`encuestado_id`, `proceso_id`), `MIN(actualizado)` | Cota superior de la primera respuesta | `actualizado` se pisa (C4): la fecha real puede ser anterior. |
| B10 | `proceso_validado` | `procesos` con `validacion='validado'` y `validado_en`; `actor_tipo='admin'`, `validado_por` en `detalle`. Clave `val\|<proc>\|<validado_en>` | `validado_en` (exacta) | Solo la última validación vigente. |
| B11 | `flujo_paso_confirmado`, `aprobacion_final` | `flujo_pasos` y `aprobaciones` | `confirmado_en`, `aprobado_en` | Exactas, salvo las reabiertas (`activa=0`). |
| B12 | `proceso_completo` | En JavaScript, una sola vez: carga la campaña, `crearCobertura().persona(pid, eid).completo`, fecha = máximo de `respuestas.actualizado` de esa persona y proceso | Aproximada (C4) | Es el único paso del backfill con CPU relevante: se parte por gerencia si hiciera falta. Va en P3. |
| B13 | Foto inicial | Una fila de `avance_diario` con `reconstruido=1` en la fecha del despliegue (misma función que el cron) | Día del despliegue | No hay curva anterior: no se inventa. |

Lo que **no** se puede reconstruir y debe declararse: aperturas del enlace (paso 4) y cuántas veces entró cada persona o gerente; cuándo se entregó la clave vigente; a qué persona se mandó cada correo o enlace copiado; PIN fallidos históricos (solo el contador actual `pin_fallos`).

Fecha desde la que los datos son completos (para el resumen de negocio): desde el día del despliegue del Paquete 1 para los pasos 3-6, desde el Paquete 2 para los pasos 1-2.

---

## 6. Extracción

### Ruta

`GET /a/embudo/export`, en el bloque `/a/` de `index.js` (después de `GET /a/campana/trazabilidad`, `:2959`), protegida por `exigirAdmin` como las demás. Solo lectura.

| Parámetro | Valores | Notas |
|---|---|---|
| `campana_id` | obligatorio | |
| `conjunto` | `eventos` \| `personas` \| `avance_diario` \| `todos` | `todos` solo en JSON (CSV es una tabla por archivo). Por defecto `todos`. |
| `formato` | `json` (def.) \| `csv` | |
| `desde`, `hasta` | `AAAA-MM-DD` hora de Lima | Filtran `eventos` por `creado` y `avance_diario` por `dia`. `personas` ignora fechas. |
| `limite` | def. 2000, máx. 5000 | Solo `eventos`. |
| `despues` | cursor devuelto como `siguiente` (`<creado>\|<id>`) | Paginación por clave (no `OFFSET`). |

Respuesta JSON: `{ ok, generado, campana_id, eventos:{filas,siguiente}, personas:{filas}, avance_diario:{filas} }`. CSV: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="embudo-<conjunto>-<AAAA-MM-DD>.csv"`, **BOM UTF-8**, separador `;`, comillas dobles y `""` para escapar, fin de línea `\r\n`, decimales con coma, fechas ISO sin coma, saltos de línea internos convertidos a espacio y neutralización de fórmulas (un valor que empiece con `=`, `+`, `-` o `@` se prefija con `'`).

Límites de CPU: `eventos` pagina en SQL con índice `ix_ev_tipo`/`ix_ev_persona` (≤ 5000 filas por llamada); `personas` es una fila por persona (≈ 300 hoy, tope 5000) y se arma con **8 lecturas** de la campaña (como hace `flujo.js` en `cargarCampana`, `:30-50`) más una agregación SQL de `eventos`; `crearCobertura` ya corre sobre la campaña completa en cada petición del flujo del gerente. `avance_diario` es una lectura.

La extracción **nunca** devuelve textos de respuestas, PIN, claves, tokens ni correos. El nombre de la persona y del gerente sí.

### Columnas exactas

**`eventos`** (una fila por evento): `evento_id`, `fecha_utc` (ISO), `fecha_lima` (`AAAA-MM-DD HH:MM:SS`), `tipo`, `actor_tipo`, `actor_nombre`, `perfil` (perfil de la cuenta que actuó: gerente/supervisor/persona/admin/cliente), `gerencia`, `seccion`, `persona_id`, `persona_nombre`, `gerente_nombre` (gerente activo cuyo alcance incluye esa gerencia; vacío si no hay uno), `proceso_id`, `proceso_codigo`, `canal`, `visitante_corto` (8 primeros caracteres), `reconstruido` (0/1), `detalle` (JSON con la lista blanca).

**`personas`** (una fila por persona): `campana_id`, `persona_id`, `persona_nombre`, `gerencia`, `seccion`, `cargo`, `perfil` (responsable/supervisor/gerente), `gerente_nombre`, `origen` (carga/abierto), `f_agregado`, `f_acceso_generado`*, `f_acceso_enviado`*, `f_gerente_abrio`*, `f_delegado`, `f_compartido`, `f_abrio`, `f_abrio_origen` (medido/inferido/ambiguo/vacío), `f_acceso_creado`, `f_acceso_creado_origen` (medido/aprox/vacío), `f_primera_respuesta`, `f_primer_proceso_completo`, `f_ultima_actividad`, `n_aperturas`, `n_ingresos`, `ultimo_paso` (0 sin contacto, 3 compartido/delegado, 4 abrió, 5 acceso creado, 6 primera respuesta, 7 completó todo lo asignado), `ultimo_paso_nombre`, `dias_sin_actividad` (desde `generado` hasta `f_ultima_actividad`; vacío si nunca hubo), `procesos_asignados`, `procesos_con_respuesta`, `procesos_completos`, `procesos_validados`, `pct_procesos_completos`, `pct_puntos`, `bloqueada` (0/1). (*) solo si la persona tiene cuenta de gerente o supervisor.
- `f_*` = primera vez en cada paso, hora UTC en ISO; vacío = no ocurrió o no se pudo medir.
- `procesos_asignados` = procesos vigentes de su sección (sin los que creó ella ni los que MBC excluyó) más los asignados, elegidos o con relación confirmada; es la misma lista que muestra la encuesta (`index.js:777-782`). `procesos_completos` = `crearCobertura().persona().completo`; `pct_procesos_completos` = completos / asignados; `pct_puntos` = suma de puntos listos / (asignados × puntos por proceso). `procesos_validados` = completos cuyo proceso tiene `validacion='validado'`.
- `ultimo_paso` es el máximo paso con fecha (medida, inferida o aproximada), no un estado exclusivo: una persona puede tener `f_primera_respuesta` sin `f_abrio` medido (inferido).

**`avance_diario`**: `dia`, `gerencia`, `seccion`, `procesos_vigentes`, `procesos_sin_cobertura`, `procesos_en_curso`, `procesos_respondidos`, `procesos_no_vigentes`, `procesos_validados`, `puntos_cubiertos`, `puntos_total`, `personas`, `personas_con_acceso`, `personas_con_respuesta`, `reconstruido`, `generado`.

### Alternativa con consulta directa (P3)

Vistas `v_embudo_eventos` y `v_embudo_eventos_dia` (las columnas que no requieren `cobertura.js`) en una migración 027. Consulta de ejemplo, sin vista:

```
cd worker
npx wrangler d1 execute voz-relevamiento --remote --json --command "SELECT tipo, COUNT(*) n, MIN(creado) desde, MAX(creado) hasta FROM eventos WHERE campana_id='<ID>' GROUP BY tipo ORDER BY n DESC"
```

El `% de avance` no se puede dar en SQL (regla de `cobertura.js`): para eso es la ruta.

---

## 7. Paquetes, archivos, pruebas y estimación

Reglas de cada paquete: un PR a `nelson2206/relevamiento-mbc`, Matías revisa y fusiona; suite completa (256 + nuevas) en verde; prueba local con `wrangler dev --local` y campaña PRUEBA recorriendo los pasos; producción solo con OK explícito, tras `npx wrangler d1 time-travel info voz-relevamiento` y desde `cd worker && npm run deploy`.

### Paquete 1 — pasos 3 a 6 + backfill + `personas` (≈ 16 h, 2-3 días)

**Entrega**: eventos `enlace_compartido`, `procesos_delegados`, `persona_agregada`, `enlace_abierto`, `persona_identificada`, `acceso_creado`, `primera_respuesta`; migración 026 (ambas tablas); backfill B1, B2-B11 (sin B12 ni foto); extracción `personas` y `eventos` en JSON y CSV; `docs/EMBUDO-definiciones.md` y `docs/EMBUDO-diccionario.md` (versión inicial).

| Archivo | Cambio |
|---|---|
| `worker/migracion-026.sql` | **Nuevo** (sección 3) |
| `worker/schema.sql` | Estado final: las dos tablas e índices |
| `worker/src/embudo.js` | **Nuevo**: `EVENTOS` (catálogo), `registrarEvento(env, ctx, ev)` y `registrarEventos` (con `batch`, `waitUntil`, lista blanca de `detalle`), `visitanteValido`, `backfillEmbudo`, `exportarEmbudo` (personas/eventos, CSV) |
| `worker/src/index.js` | Líneas de enlace: `rutaAbierta` (`:754`, `:2911`), `rutaIdentificar` (`:831`), `rutaRegistro` (`:874`), `rutaRespuesta` (`:650`), `respuestaEstructurada` (`:637`), `rutaPunto` (`:2435`), `rutaCampo` (`:2463`), `rutaClientePersonas` (`:2774`), `rutaClienteAsignar` (`:2803`), `rutaClienteEnlaces` (`:2830`); router: pasar `ctx` a `rutaRegistro`/`rutaIdentificar`/`rutaRespuesta`/`rutaPunto`/`rutaCampo` (`:2918-2928`) y agregar `POST /a/embudo/backfill`, `GET /a/embudo/export`; purga en `rutaBorrarCampana` (`:1487`) |
| `index.html` | Id de visitante (`:333`) y `v` en `/r/abierta`, `/r/identificar`, `/r/registro`; frase en el aviso de privacidad (`:724`, `:838`) |
| `docs/` | `EMBUDO-definiciones.md`, `EMBUDO-diccionario.md` |

Pruebas a agregar (en `worker/test/unit/`, mismo estilo que `acceso-pin.test.mjs`: `worker.fetch` sobre `crearD1()`):
- `embudo-catalogo.test.mjs`: tipo fuera del catálogo rechazado; `detalle` con claves no permitidas se descarta; ningún emisor guarda correos, PIN ni tokens (barrido de las filas generadas en el recorrido de abajo).
- `embudo-idempotencia.test.mjs`: dos `acceso_creado` y dos `primera_respuesta` iguales dejan una fila; `enlace_abierto` repetido en < 30 min del mismo visitante deja una; sin `v` no registra; un fallo forzado del insert **no** rompe `identificar`/`respuesta`/`enlaces` (la respuesta sigue 200).
- `embudo-recorrido.test.mjs`: pasos 3 a 6 con una persona precargada y una auto-registrada; unión visitante-persona; visitante compartido entre dos personas = `ambiguo`.
- `embudo-backfill.test.mjs`: siembra datos antiguos (supervisor, delegaciones, encuestados, respuestas), corre el backfill dos veces: mismas filas; todo `reconstruido=1`; `f_abrio_origen='inferido'`.
- `embudo-personas.test.mjs`: `pct_*` coinciden con `crearCobertura` para casos de `cobertura.test.mjs`; `ultimo_paso`; `dias_sin_actividad`.
- `embudo-csv.test.mjs`: BOM, `;`, comillas, coma decimal, neutralización de `=`, paginación por cursor sin repetir filas.
- `esquema.test.mjs` (existente) cubre la 026 automáticamente.

Estimación: migración + catálogo + registro 3 h · instrumentación P1 + front 4 h · backfill 3 h · extracción personas/eventos/CSV 4 h · pruebas y recorrido local 2 h = **16 h**. Más ~1 h de PR/revisión. Documentos en paralelo.

### Paquete 2 — pasos 1-2, foto diaria y errores (≈ 12 h)

Eventos `acceso_gerente_generado`, `acceso_gerente_enviado`, `gerente_abrio`, `gerente_entro`, `pin_fallido`, `enlace_seccion_copiado`; rutas `POST /a/persona/acceso-enviado`, `POST /c/evento`; botón «Marcar como enviado» (canal) en `dialogoAccesoPerfil` y `mostrarAccesoSupCl`; cuarta tarea del cron con la foto diaria y la foto inicial; conjunto `avance_diario` en la extracción; aviso de privacidad actualizado.
Archivos: `worker/src/embudo.js`, `index.js` (`:2758`, `:794`, router, `scheduled` `:2887`), `usuarios.js` (`:158`, `:62`, `:81`, `:249`), `flujo.js` (solo si se reutiliza `cargarCampana`: agregar `export`), `admin.html`.
Pruebas: foto diaria (una por día, aditiva, igual a `crearCobertura`), `gerente_abrio` una sola vez, `pin_fallido` sin guardar el PIN, el cron no falla si `eventos` falla.
Estimación: gerente y clave 3 h · botón + rutas 3 h · foto diaria 3 h · `pin_fallido` y `/c/evento` 2 h · pruebas 1 h = **12 h**.

### Paquete 3 — avance, validación, vistas y entregables (≈ 10 h)

`bloque_completado`, `proceso_completo`, `proceso_validado`, `flujo_paso_confirmado`, `aprobacion_final`; backfill B12-B13; migración 027 con vistas SQL; prueba de paridad entre `cobertura.js` y la copia de `admin.html` (C7); `docs/EMBUDO-definiciones.md` y `docs/EMBUDO-diccionario.md` definitivos con fórmulas (conversión entre pasos, mediana de tiempo entre pasos, detenidos > N días); archivo de muestra de la campaña PRUEBA (JSON y CSV); resumen para negocio.
Estimación: 10 h. **Total ≈ 38 h** (16 + 12 + 10), más revisiones.

Calendario sugerido: P1 publicado el 13-nov (backfill ese mismo día, datos medidos completos desde ahí); P2 el 17-18-nov; P3 el 20-nov. El cierre del 30-nov queda con 10 días de datos medidos de los pasos 1-2 y 17 de los pasos 3-6.

---

## 8. Riesgos

| Riesgo | Efecto | Mitigación |
|---|---|---|
| **Costo de escrituras en D1** (Workers Paid sin tope nativo) | Un evento = 1 fila + 3-4 entradas de índice. Volumen estimado: ≈ 30 eventos por persona activa × 300 personas ≈ 10 000 filas en todo el proyecto, frente a los millones incluidos. Lo caro serían las lecturas de la idempotencia por autoguardado y las aperturas. | `ctx.waitUntil` + `batch`; `enlace_abierto` con ventana de 30 min; sin eventos en sondeos ni recargas (`recarga=1`, `/r/sesion`); medir con `wrangler d1 insights` a las 24 h de publicar P1; si el índice de `primera_respuesta` pesara, guardar la marca en memoria de la persona (columna) en lugar de consultar. Alerta US$ 1 ya existe (memoria de topes). |
| **Privacidad (Ley 29733)** | Registro de actividad de empleados del cliente; el visitante es un identificador seudónimo. | Todo en D1 propio; sin analítica de terceros ni píxeles (el correo sigue siendo .eml sin rastreo); no se guarda IP ni huella de IP en `eventos`; `visitante` es un UUID aleatorio por navegador, sin relación con datos personales y solo se une con la persona al identificarse; `detalle` con lista blanca; el aviso de la encuesta (`index.html:724`, `:838`) menciona el registro de actividad y su finalidad (seguimiento del proyecto); purga de `eventos` y `avance_diario` al borrar la campaña y a los 30 días del cierre. A confirmar con el CISO del cliente antes de P1 si el aviso necesita aprobación. |
| **No romper la acción principal** | Un fallo de D1 al registrar no debe devolver error en `identificar`, `respuesta` ni `enlaces`. | `registrarEvento` nunca lanza; prueba que fuerza el fallo del insert y comprueba 200. |
| **Conflicto con el trabajo de Matías Tejada** | Sus PR recientes (#7, #11: documentos, precarga, matriz, cron `extraerPendientes`) tocaron `index.js` y `admin.html` y hay actividad hasta el 04-nov (commits «Tejada Mora»). Hoy `main` tiene HEAD en `4e90f1e` (PR #12, 09-nov) y **no hay ramas remotas sin fusionar** (`git branch -r --no-merged main` vacío); el árbol local solo tiene sin seguimiento este prompt. Las zonas que tocamos (`exigirPin`, `rutaIdentificar`, router, `scheduled`, `rutaClienteCampana`) no coinciden con sus cambios, salvo el router y `scheduled`, que ambos editan. | Todo lo nuevo en `embudo.js`; en `index.js` solo líneas de enlace y 2 rutas al final de su bloque; PR pequeños; rebasar sobre `main` justo antes de cada PR; avisarle por el PR de P1 que `scheduled` y el router cambian. Re-verificar `git log --oneline -15` el día de empezar. |
| **Atribución imperfecta de aperturas** | Subconteo por equipos compartidos, dispositivos distintos o almacenamiento bloqueado. | Rótulos `inferido`/`ambiguo`; definiciones escritas; no se afirma «abrió» sin rótulo. |
| **Reconstruido vs. medido** | Mezclarlos distorsiona las fechas y los tiempos entre pasos. | `reconstruido=1` en cada fila, columnas `*_origen` en `personas`; recomendar a la vista externa tiempos entre pasos solo con eventos medidos. |
| **Regeneración de claves de gerente** (`rutaClavesPerfiles`) | Al descargar enlaces personales la clave anterior deja de servir sin aviso y se cuenta como «gerente nunca entró». | `acceso_gerente_generado` con `motivo='descarga_enlaces'` (P2) para distinguir ese caso; decisión de producto aparte. |
| **Migración en producción** | Una migración errónea afecta la encuesta en vivo. | `CREATE TABLE IF NOT EXISTS` solo agrega tablas nuevas (no altera las existentes); punto de restauración con `time-travel` antes; aplicar fuera del horario de uso; probar en local con `--local`. |
| **Duplicado de la regla de avance** | `cobertura.js` y `admin.html` pueden divergir. | Prueba de paridad en P3; el embudo usa `cobertura.js` y lo dice en el diccionario. |
