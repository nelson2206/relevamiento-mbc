# Prompt: embudo de puntos de contacto del relevamiento (gerente → equipo → avance)

> Para pegar en una sesión de Claude Code (Sonnet) abierta en `C:\Users\nebernal\relevamiento-mbc`.
> Diagnóstico del estado actual hecho el 11-nov-2026 sobre `main`; verifícalo antes de construir.

---

## Rol y objetivo

Eres un desarrollador senior que trabaja en «Voz MBC · Relevamiento de procesos» (Cloudflare Worker `voz-relevamiento-api` + D1 `voz-relevamiento` + front estático en `relevamiento.mbc-latam.com`). Vas a dejar los **datos de un embudo de seguimiento de punta a punta**, listos para extraer. Con ellos se podrá ver, por gerencia, por sección y por persona, en qué paso está cada participante, cuánto tarda entre pasos y dónde se pierde la gente. La vista del embudo **no** se construye en la herramienta: se armará fuera con lo que extraigas.

Para qué sirve (negocio): el proyecto de Toyota del Perú (TDP) cierra el **30-nov-2026**. Al 11-nov, 0 de 304 procesos tienen la encuesta completa: hay 13 gerencias sin iniciar y solo 16 personas registradas. Hoy no podemos decir si el cuello de botella es que el gerente no abrió su enlace, que no lo reenvió a su equipo o que su equipo entró y no avanzó. El embudo tiene que responder eso con fechas y nombres, para que el equipo MBC llame a la persona correcta.

## Los 7 pasos del embudo

| # | Paso | Quién |
|---|---|---|
| 1 | El gerente recibe su enlace o clave de acceso | Gerente / Supervisor |
| 2 | El gerente abre su enlace por primera vez (y luego, cuántas veces vuelve) | Gerente |
| 3 | El gerente comparte el enlace con una persona de su equipo (copiar enlace, correo .eml, agregar persona, delegar procesos) | Gerente → persona |
| 4 | La persona abre el enlace (de sección `?c=` o personal `?k=`) | Persona |
| 5 | La persona termina de crear su acceso (nombre + PIN) | Persona |
| 6 | La persona empieza a completar sus procesos (primera respuesta guardada) | Persona |
| 7 | % de avance: procesos completos / asignados; y proceso completo → validado por el gerente | Persona y gerente |

## Lo que la herramienta YA registra (verifícalo en el código)

| Paso | Estado | Evidencia | Qué falta |
|---|---|---|---|
| 1 Recibe enlace | **No** | La clave del gerente se genera al darle perfil (`supervisores.creado`, ruta `POST /a/persona/perfil`), pero el envío sale por Outlook (.eml) fuera de la herramienta. | Saber cuándo se generó, cuándo se marcó como enviado y por qué canal. |
| 2 Gerente abre | **Parcial** | `supervisores.ultimo` se pisa en cada entrada (`worker/src/index.js` ~2759). | Primera apertura, número de visitas e historial. Una apertura sin login no deja rastro. |
| 3 Comparte con su equipo | **Parcial** | Tabla `acciones`: `enlace_copiado` / `correo_generado` (index.js ~2840) guardan **solo la cantidad** de personas; `personas_agregadas` y `delegar` (~2798, ~2824). | A **qué persona** se compartió y cuándo, para unir el paso 3 con el 4. |
| 4 Persona abre el enlace | **No** | `GET /r/abierta` (index.js ~754) solo escribe un `log()` efímero de Workers. Con `?k=` solo se toca `encuestados.ultimo_acceso` (se pisa). | Evento de apertura, también anónimo (enlace de sección antes de identificarse). |
| 5 Termina su acceso | **Parcial** | `encuestados.creado` + `origen='abierto'` + `pin_hash<>''` (`POST /r/registro`, `/r/identificar`). | Fecha en que se fijó el PIN en personas precargadas por Excel. Intentos fallidos. |
| 6 Empieza a completar | **Parcial** | `encuestados.estado` pasa a `en_curso`; `respuestas.actualizado` se **sobrescribe**. | Fecha de la **primera** respuesta por persona y proceso. |
| 7 % de avance | **Sí** | `worker/src/cobertura.js` (regla única de «respondido», igual que la consola y el panel del cliente); `procesos.validacion`. | Serie histórica: hoy solo hay foto del momento, no evolución diaria. |

Conclusión: los datos de estado existen, pero **no hay un registro de eventos con fecha**. Sin ese registro no se puede medir el tiempo entre pasos, la tasa de conversión ni la evolución en el tiempo.

## Qué construir

### 1. Registro de eventos (D1, migración nueva `migracion-026.sql`)
- Tabla de solo inserción, por ejemplo `eventos`: `id, campana_id, tipo, actor_tipo (gerente|supervisor|persona|admin|anonimo), actor_id, persona_id (destinatario, si aplica), gerencia, seccion, proceso_id, canal (outlook|copiar|whatsapp|...), visitante (id anónimo), detalle JSON, creado`.
- Índices por `(campana_id, tipo, creado)` y `(campana_id, persona_id)`.
- Catálogo cerrado de tipos, como constante única en el Worker y documentado: `acceso_gerente_generado`, `acceso_gerente_enviado`, `gerente_abrio`, `gerente_entro`, `enlace_compartido` (uno por persona), `persona_agregada`, `procesos_delegados`, `enlace_abierto`, `persona_identificada`, `acceso_creado`, `pin_fallido`, `primera_respuesta`, `bloque_completado`, `proceso_completo`, `proceso_validado`.
- Eventos de «primera vez» idempotentes: no duplicar `primera_respuesta` ni `acceso_creado`. Las visitas sí se repiten.
- **Nunca** guardar textos de respuesta, PIN, claves, tokens completos ni correos en `detalle`.

### 2. Instrumentar las rutas existentes (cambios mínimos, sin reescribir flujos)
- `POST /a/persona/perfil` y la regeneración de clave → `acceso_gerente_generado`.
- Botón nuevo en el diálogo de acceso del gerente, «Marcar como enviado» (con canal), porque el envío por Outlook es externo → `acceso_gerente_enviado`. **No** usar píxeles de rastreo en el correo (CISO del cliente, Netskope).
- Login del panel `/c` → `gerente_entro` (y `gerente_abrio` la primera vez).
- `enlace_copiado` / `correo_generado` / delegar / agregar personas: un evento **por persona destinataria** (además de la acción agregada que ya existe).
- `GET /r/abierta` y la sesión `?k=` → `enlace_abierto`, con un `visitante` anónimo generado en el navegador (`localStorage`, con try/catch). Al identificarse, el evento `persona_identificada` une ese visitante con `persona_id`.
- `/r/registro`, `/r/identificar` y la fijación de PIN → `acceso_creado` / `pin_fallido`.
- Guardado de respuestas → `primera_respuesta` (solo la primera por persona y proceso) y `bloque_completado`.
- Cambio a «respondido» según `cobertura.js` y la validación del gerente → `proceso_completo` y `proceso_validado`.
- El registro de un evento **nunca** debe romper la acción principal: usa `ctx.waitUntil` o try/catch y deja un log si falla.

### 3. Reconstruir lo que ya pasó (backfill, una sola vez, idempotente)
Script o ruta de administrador que cree eventos aproximados desde los datos actuales. Cada evento queda marcado en `detalle.reconstruido=true` para no confundirlo con los medidos:
- `supervisores.creado` → generado; `supervisores.ultimo` → entró (fecha mínima conocida).
- `acciones` (`enlace_copiado`, `correo_generado`, `delegar`, `personas_agregadas`) → compartido (sin persona, si no se puede saber).
- `encuestados.creado`, `pin_hash`, `ultimo_acceso`, `estado` → acceso creado / abrió.
- `respuestas.actualizado` mínimo por persona y proceso → primera respuesta (aproximada).
- Avance actual con `cobertura.js` → foto inicial.

### 4. Foto diaria del avance
El cron existente (`*/15`) guarda una vez al día, en una tabla `avance_diario`, el avance por gerencia y sección (vigentes, en curso, respondidos, validados y puntos cubiertos), calculado con **la misma** `crearCobertura`. Así habrá curva de avance contra la fecha de cierre.

### 5. Extracción de datos (SIN vista en la herramienta)
**No construyas ninguna pantalla de embudo** en la consola ni en el panel del cliente. La vista se armará fuera (Excel, Power BI o un HTML aparte). Tu trabajo es dejar los datos completos, limpios y fáciles de extraer:
- Ruta de administrador de solo lectura `GET /a/embudo/export?campana_id=&desde=&hasta=&formato=json|csv`, protegida con el código de administrador, como las demás rutas `/a/`. Devuelve tres conjuntos:
  1. `eventos`: una fila por evento, con `tipo`, fecha ISO, gerencia, sección, perfil, `persona_id`, nombre de la persona y de su gerente, `proceso_id`, canal y si es reconstruido.
  2. `personas`: una fila por persona, con la fecha de su **primera vez** en cada paso (`f_acceso_generado`, `f_acceso_enviado`, `f_abrio`, `f_compartido`, `f_acceso_creado`, `f_primera_respuesta`, `f_primer_proceso_completo`), el último paso alcanzado, días desde su última actividad, procesos asignados, completos y validados, y % de avance según `cobertura.js`.
  3. `avance_diario`: la serie por día, gerencia y sección.
- Paginación o límite de filas, para no pasar el CPU del Worker. En CSV: UTF-8 con BOM y separador `;`, para que Excel en español lo abra bien.
- Alternativa equivalente, si es más simple: vistas SQL en D1 (`v_embudo_personas`, `v_embudo_eventos`) que se puedan consultar con `npx wrangler d1 execute voz-relevamiento --remote --json`. Documenta la consulta exacta.
- **Diccionario de datos** (`docs/EMBUDO-diccionario.md`): cada campo con su significado, origen (medido o reconstruido), formato y ejemplo con valores ficticios. Más las fórmulas sugeridas para la vista externa: conversión entre pasos, tiempo mediano entre pasos y personas detenidas (sin avance en más de N días).
- La extracción **no** incluye textos de respuestas, PIN, claves, tokens ni correos. El nombre de la persona sí, porque hace falta para saber a quién llamar.

### 6. Definiciones que deben quedar escritas (en `docs/` y en las ayudas de la UI)
- Qué cuenta como «abrió», «creó acceso», «empezó» y «completo». «Completo» es la regla de `cobertura.js`; no inventar otra.
- Cómo se atribuye una apertura anónima de un enlace de sección.
- Qué datos son medidos y cuáles reconstruidos.

## Restricciones (obligatorias)
1. **Lee antes de escribir**: `worker/src/index.js`, `cobertura.js`, `flujo.js`, `ambito.js`, `usuarios.js`, `admin.html`, `index.html`, `flujo-gerente.js`, `schema.sql` y las migraciones. Respeta su estilo (funciones puras, `registrarAccion`, `HttpError`, `txt()`, español en código y textos).
2. **Primero entrega el plan**, sin tocar código: el catálogo de eventos, el diseño de tablas, la lista de rutas a instrumentar con archivo y línea, el plan de backfill, el formato de extracción y una estimación por paquete. Espera el OK.
3. Trabaja por **paquetes pequeños**, cada uno con su PR a `nelson2206/relevamiento-mbc` (Matías Tejada revisa y fusiona).
4. **Producción**: no despliegues ni apliques migraciones sin OK explícito. Antes de cualquier migración en producción, guarda un punto de restauración (`npx wrangler d1 time-travel info voz-relevamiento`). Se publica solo desde este repositorio (`cd worker && npm run deploy`), nunca desde `hub-encuestas-mbc`.
5. **Privacidad (Ley 29733, CISO del cliente)**: todo queda en D1 propio, sin analítica de terceros, sin píxeles, sin IP completa (si hace falta, solo su huella con sal). El aviso de privacidad de la encuesta debe mencionar el registro de actividad.
6. **Costo**: es Workers Paid sin tope nativo. Un evento es una escritura D1: agrupa las escrituras con `env.DB.batch` cuando sea posible y no registres eventos en lecturas repetitivas, como sondeos o recargas automáticas.
7. **Pruebas**: pruebas unitarias del catálogo, la idempotencia, el backfill y el cálculo del embudo en `worker/test/unit/`; deben pasar todas (hoy son 256). Prueba de punta a punta en local (`wrangler dev --local`, config «relev-api») recorriendo los 7 pasos con la campaña PRUEBA. El código de administrador nunca se teclea en el login de producción.
8. Antes de declarar algo terminado, muestra la evidencia: salida de las pruebas, una extracción de muestra (JSON y CSV) y la consulta a D1 con los eventos generados.

## Entregables
1. Plan aprobado (`docs/PLAN-embudo.md`).
2. Migración + catálogo + instrumentación + backfill + foto diaria + extracción, en PRs separados. Sin pantallas nuevas.
3. Ficha de definiciones (`docs/EMBUDO-definiciones.md`) y diccionario de datos (`docs/EMBUDO-diccionario.md`).
4. Un archivo de muestra de la extracción con la campaña PRUEBA, para armar la vista externa antes de tener datos reales.
5. Un resumen para negocio: qué se puede medir desde hoy, qué es reconstruido y desde qué fecha los datos son completos.
