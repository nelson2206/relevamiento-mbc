# HU03-b — Lectura independiente por proceso de un documento multiclasificado

> Diseño técnico decidido para la historia «Reprocesamiento y desacoplamiento de documentos multiclasificados» (el archivo que llegó se llamaba HU03.md pero se titulaba HU04; en el repo es **HU03-b** para no confundirla con la HU03 «matriz como única fuente» ya implementada).
> Base: rama `hu03-hu04` (ya incluye HU04). Archivos: `worker/src/documentos.js`, `worker/src/index.js` (cron y rutas), `documentos-consola.js`, `worker/schema.sql`, nueva `worker/migracion-024.sql`, pruebas en `worker/test/unit/documentos-extraccion.test.mjs`.

## Historia
**Como** administrador, **quiero** que la generación de borradores de cada proceso asociado a un documento se ejecute de forma independiente, **para** que un error o bloqueo en un proceso no impida generar los de los demás, y poder reprocesar solo los afectados sin borrar ni volver a cargar el documento.

## Causa raíz (código actual)
- `rutaDocumentoProcesos` marca hasta 8 pares como `pendiente` y llama `ejecutarExtracciones`, que los procesa **uno tras otro dentro de un solo `ctx.waitUntil`** de la solicitud. Cloudflare corta el `waitUntil` ~30 s después de responder: con varias lecturas de IA (20-60 s cada una) los últimos pares nunca corren y quedan `pendiente` («Leyendo…») para siempre. Un par que se cuelga bloquea a los que vienen detrás.
- Los pares por encima de 8 quedan en `error` con «Son muchos procesos a la vez».
- Solo existen los estados `pendiente | ok | error`, sin historial de ejecuciones (solo la última fila de `documento_extracciones` y eventos sueltos en `acciones`).
- Un par «pendiente» se considera perdido a los 10 min solo cuando alguien pulsa reintentar; nadie lo marca como error.

## Diseño
### Estados (columna `documento_extracciones.estado`)
`pendiente` (en cola) → `leyendo` (bajando el archivo de R2 y esperando a la IA) → `procesando` (la IA respondió; se escriben los borradores) → `generado` | `error`.
- La migración 024 convierte `ok` → `generado`. Todo el código y la consola dejan de usar `ok` para este estado (en `documentos-consola.js`: `pendiente` = «En cola», `leyendo` = «Leyendo…», `procesando` = «Procesando…»).
- Cada transición actualiza `actualizado`. El estado de un par nunca cambia el de otro.

### Ejecución independiente
- Un par = una ejecución propia. Se elimina `ejecutarExtracciones` (bucle secuencial en un solo `waitUntil`).
- Nueva función exportada `ejecutarPar(env, ctx, d, procesoId, deps, origen, solicitante)`: abre historial (`inicio`), marca `leyendo`, baja R2, llama a la IA con **tiempo máximo** (`Promise.race` contra `EXTRACCION_MAX_MIN`), marca `procesando`, escribe borradores (lógica actual de `extraerPar`, sin cambiar sus reglas), marca `generado`; cualquier fallo → `error` con el motivo técnico. Cierra el historial (`fin`, `resultado`, `mensaje`, `puntos`). Nunca lanza.
- **Quién la dispara**:
  1. `POST /a/documentos/extraer {id, proceso_id, origen?}`: ahora **espera** la ejecución dentro de la propia solicitud (no `waitUntil`) y responde con la ficha ya actualizada. Cada par viaja en su propia solicitud, así que uno colgado no afecta a otro. `origen` admitido: `confirmacion` | `reproceso` (por defecto `reproceso`).
  2. `rutaDocumentoProcesos` ya **no** lanza nada en segundo plano: deja los pares nuevos (confirmados + agregados) en `pendiente`, **sin tope de 8** (desaparece el error «Son muchos procesos a la vez»), y responde además `por_extraer: [proceso_id]`. La consola dispara `POST /a/documentos/extraer` con `origen:'confirmacion'` por cada par, **2 en paralelo como máximo**, y refresca al terminar cada uno.
  3. **Cron** (`scheduled`, cada 15 min, después de `completarPendientes`; si uno falla el otro igual corre): `extraerPendientes(env, ctx)` toma hasta 4 pares en `pendiente` con `actualizado` de hace más de 2 min (la consola no los alcanzó, p. ej. se cerró la pestaña) y los ejecuta uno a uno con `origen='automatico'`.
- `rutaDocumentoExtraer` rechaza con 409 si el par está `leyendo`/`procesando` y no ha vencido (evita dos lecturas del mismo par a la vez). La unicidad `(documento_id, proceso_id, punto)` de `precarga_borrador` sigue impidiendo borradores duplicados.

### Tiempo máximo y barrido
- `EXTRACCION_MAX_MIN` (variable de entorno opcional, por defecto **8** minutos).
- `vencerExtracciones(env, campId?)`: pares en `leyendo` o `procesando` con `actualizado` más antiguo que el máximo → `error` con mensaje «Se superó el tiempo máximo de lectura (N min)», y su historial abierto se cierra con `resultado='error'`. Se llama al inicio del cron y al armar la bandeja de documentos y `borradoresDeCampana` (así la consola lo ve sin esperar al cron).

### Consistencia (criterios de la historia)
- Confirmar o quitar un proceso del documento **no** reprocesa los demás pares (solo los nuevos confirmados/agregados, como hoy).
- Reprocesar un par conserva lo aprobado y no toca borradores de otros procesos (la lógica actual de `extraerPar` ya lo cumple; no cambiarla).
- Quitar un proceso del documento borra su fila de `documento_extracciones` como hoy, pero **conserva su historial**.

### Historial (migración 024)
```sql
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
```
- Encabezado del archivo igual al de `migracion-023.sql` (fecha 2026-11-05, «Aplicar UNA vez», comando).
- `solicitado_por`: `ACTOR.nombre` de la consola (hoy un único usuario, el equipo consultor) o `'automático'` en el cron.
- Agregar la tabla también a `worker/schema.sql`.
- Nueva ruta `GET /a/documentos/historial?id=<documento_id>[&proceso_id=]`: últimas 50 ejecuciones del documento, más recientes primero, con el nombre del proceso. Solo administrador, como el resto de `/a/documentos*`. Documentarla en el comentario de rutas de `index.js` y en `docs/FUNCIONES.md`.

### Consola (`documentos-consola.js`)
- Cada proceso confirmado del documento muestra: chip de estado (En cola / Leyendo… / Procesando… / Borradores generados / Sin datos nuevos / Con error), fecha y hora del último procesamiento (`actualizado`, formato corto local), y el mensaje de error en texto visible (no solo en `title`).
- Botón por proceso: «Reintentar» (error) o «Volver a leer» (generado), deshabilitado mientras esté en cola/leyendo/procesando.
- Enlace «Historial» por documento que muestra la lista de ejecuciones (proceso, origen, quién, inicio, fin, resultado, mensaje), con el mismo estilo de diálogos/tablas que ya usa la consola.
- Mantener el sondeo actual mientras haya pares en `pendiente`/`leyendo`/`procesando`.
- En el resumen de la bandeja: cuántos procesos tienen la lectura con error.

## Fuera de alcance
- No cambian las reglas de borradores, la aprobación (`rutaPrecargaBorrador`), `aplicarPrecarga`/`puedeAutomatico`, ni la clasificación de documentos.
- Multiusuario real en la consola.

## Pruebas (`npm run test:unit`)
- Dos procesos confirmados; la IA falla para el primero: el segundo queda `generado` con sus borradores y el primero `error` con motivo; historial con dos filas cerradas.
- Reprocesar solo el par con error: pasa a `generado`; los borradores aprobados del otro par siguen intactos; historial con `origen='reproceso'`.
- Par en `leyendo` vencido → `vencerExtracciones` lo deja en `error` con el mensaje de tiempo máximo y cierra su historial.
- `POST /a/documentos/extraer` sobre un par `leyendo` vigente → 409.
- Confirmar 12 procesos: todos `pendiente`, ninguno `error`, `por_extraer` trae los 12.
- Cron: con 5 pares `pendiente` antiguos procesa 4.
- IA que excede el tiempo máximo (un `extraerPrecarga` que no resuelve y un máximo pequeño en la prueba) → `error`.
- Ajustar las pruebas existentes que esperaban `ok` o «Son muchos procesos a la vez».
