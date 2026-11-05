# HU04 — La encuesta muestra la precarga y el check solo lo activa la IA

> Documento autosuficiente: describe el problema, su causa en el código, el comportamiento esperado y cómo verificarlo.
> Las referencias son a la versión del repositorio **anterior** a este cambio (`HEAD` = «Precarga: re-lectura, contradicciones por tipo de punto, costo de IA y conflictos al guardar»). Los números de línea son aproximados: guíate por los nombres de función.

## Historia de usuario
**Como** persona que responde la encuesta,
**quiero** ver la información que el equipo precargó para mi proceso y que los checks del checklist estén vacíos hasta que yo responda,
**para** confirmar o complementar lo previo sin que el sistema dé por cumplido algo que todavía no conté.

## Vocabulario
- **Precarga**: texto por punto del checklist que el equipo consultor guarda desde la consola («Precarga desde documentos con IA» → *Guardar precarga*). Se guarda en la tabla `precarga` (`proceso_id, bloque, punto, texto, archivos`).
- **Matriz**: `procesos.matriz` (JSON por campo). La precarga *también* se copia ahí cuando el campo lo permite (`aplicarPrecarga`).
- **Punto del checklist**: los 16 puntos de `BLOQUES` (`worker/src/index.js`): objetivo, actividades, riesgos, aprobaciones, inicio_fin, carga, sistemas, manual_sistema, terceros, datos_personales, finalidad_dp, documentacion, estandar_tdp, estandar_global, normativa, kpis.
- **Check**: el ✓ de cada punto en la encuesta. Su estado vive en `respuestas.checklist[punto].estado` (`cubierto` | `no_aplica` | `falta`).
- **PUNTO_CAMPO** (`worker/src/matriz-sync.js`): mapa punto → campo de la matriz. **No incluye** `riesgos`, `inicio_fin` ni `manual_sistema`.

## Problemas observados
1. **La precarga no se ve en la encuesta.** La persona ve lo que hay en la matriz, no lo precargado. Si la matriz ya tenía texto del inventario anterior, la precarga se guarda pero no pasa a la matriz, y la encuesta muestra el inventario. Los 3 puntos sin campo en la matriz nunca muestran su precarga.
2. **El check aparece marcado sin que la persona haya respondido.** Un punto con precarga, con texto en la matriz, con la fila validada por MBC o con «Sigue vigente» se pinta como ✓. El check solo debe activarse después de que la persona llene información (texto, documentos y/o audio) y la IA valide qué puntos cubrió.

## Causa raíz en el código
**Problema 1**
- `rutaSesion` (`GET /r/sesion`, `worker/src/index.js`, ~líneas 370-460): la consulta de `precarga` trae solo `proceso_id, punto`, y la respuesta envía `precarga: {proceso: [ids]}`. El texto nunca viaja.
- El texto visible sale de `valoresDeProceso` (`matriz-sync.js`), que lee únicamente `m[campo]` de la matriz.
- `aplicarPrecarga` (`index.js`, ~2277) llama a `puedeAutomatico` (`matriz-sync.js`): si el campo tiene texto que no es de la IA, o la fila está validada, el punto queda **bloqueado** (`bloqueados`) y no llega a la matriz. Esa regla es correcta (no se debe pisar el inventario) y **no se cambia**.
- Resultado: precarga guardada en la tabla, bloqueada para la matriz → la encuesta muestra el inventario.

**Problema 2**
- `index.html`, función `puntoListo`: devuelve verdadero si `adminCubre(pid, id)` (hay precarga), o `valorDe(...).validado` (fila validada por MBC o confirmación), o el checklist está cubierto.
- `index.html`, función `pintarChecklist`: fuerza `est = 'cubierto'` cuando `admRaw` (hay precarga) o `vl.validado`; muestra las etiquetas «Completado por Administrador / IA» y la línea `#cka-…` («Parcialmente completado: N de M puntos ya vienen de Administrador / IA»).
- `index.html`, `confirmarValor` y `rutaCampo` (`POST /r/campo`, `index.js` ~2432): «Sigue vigente» marca el punto `cubierto` (`evidencia: 'vigente'`) en el checklist.
- `rutaVerificar` (`POST /r/verificar`, `index.js` ~1927): construye `yaCubiertos` con los puntos de la tabla `precarga` (`cubiertosEquipo`) y le indica a la IA «no los pidas». Por eso un punto precargado nunca podría marcarse con lo que la persona responde.

## Reproducción (escenario de la prueba)
1. Proceso del inventario con `matriz.objetivo = 'Contar con el personal altamente capacitado'`, sin validar.
2. Desde la consola, precargar los 16 puntos y guardar.
3. Consola: «0 llegaron a la matriz… no la reemplazaron porque ya los escribió una persona» (el objetivo queda bloqueado).
4. Encuesta: el objetivo muestra «Del inventario anterior: Contar con el personal…»; riesgos, inicio_fin y manual_sistema no muestran nada; los puntos con precarga aparecen con ✓.

## Criterios de aceptación
1. Cada punto con precarga muestra en la encuesta el texto precargado (solo lectura), con la etiqueta **«Cargado por el equipo»** y los archivos de origen, sin importar lo que tenga la matriz.
2. Si un punto tiene precarga y la matriz tiene otro texto (p. ej. inventario), se muestra **solo la precarga**. Sin precarga se muestra el texto de la matriz como hasta ahora.
3. Los puntos sin campo en la matriz (riesgos, inicio y fin, manual del sistema) también muestran su precarga.
4. Guardar la precarga no cambia la matriz ni la regla de no pisar el inventario (`aplicarPrecarga` y `puedeAutomatico` no se modifican).
5. Ningún punto aparece marcado (✓) por tener precarga, texto de la matriz, fila validada por MBC o confirmación «Sigue vigente». Todos arrancan vacíos.
6. El ✓ de un punto solo se activa cuando la IA, al revisar lo que la persona respondió, valida que lo cubrió, o cuando la persona usa «Lo mencioné» / «No aplica». La revisión de la IA **no descuenta** los puntos precargados (sí los que cubrieron otras personas, como hoy).
7. «Sigue vigente» confirma que la información previa es correcta y **no marca el check**. Sobre una precarga, la confirmación se guarda en el checklist de la persona; sobre un texto de la matriz, valida el campo como hoy (historial).
8. El avance de la persona («✓ Completo», «N de 17 puntos», barra, aviso al enviar) cuenta solo los checks del punto 6. Desaparecen los mensajes «Completado por Administrador / IA» y «N de 7 puntos ya vienen de Administrador / IA».
9. Fuera de alcance: la cobertura de la consola, del panel del cliente y del flujo del Gerente (`crearCobertura`, `puntosValidados`, `flujo.js`) siguen contando precarga y validaciones como hoy.

## Diseño técnico decidido
**Backend (`worker/src/index.js`)**
- `rutaSesion`: leer también `texto, archivos, actualizado` de `precarga` y enviar `precarga_txt: { [proceso_id]: { [punto]: { texto, archivos, actualizado } } }`, solo para procesos visibles y con texto no vacío. Mantener `precarga` (ids) y `valores` sin cambios de forma.
- `rutaVerificar`: quitar la consulta `cubiertosEquipo` y construir `yaCubiertos` solo con `otrosCubren`. Conservar `previo._vigentes` en el objeto `nuevo` (igual que `_sistemas_ia`); sin esto la revisión borraría las confirmaciones. Las claves que empiezan con `_` ya se ignoran como puntos en otros recorridos.
- `rutaCampo` (`POST /r/campo`): validar contra `TODOS_PUNTOS` (no solo `PUNTO_CAMPO`). Si existe fila en `precarga` con texto para ese punto: guardar `checklist._vigentes[punto] = ahora()` en la respuesta de su bloque (`BLOQUE_DE_PUNTO`), **sin** marcar el punto cubierto y **sin** tocar la matriz; responder `{ ok, vigente: true, checklist }`. Si no hay precarga: seguir con `validarCampoDeEncuesta` (valida la matriz, historial) **sin** marcar el checklist; responder `{ ok, valor }`. Si no hay precarga ni campo en la matriz: 400.

**Frontend (`index.html`)**
- Nueva función `precargaDe(pid, punto)` sobre `S.precarga_txt`. Quitar `adminCubre` y `AYUDA_ADM`.
- `puntoListo`: solo `ck[punto].estado` en `cubierto`/`no_aplica`.
- `pintarChecklist`: mostrar `precargaDe` (etiqueta «Cargado por el equipo», archivos «De: …», botón «Sigue vigente» / «Vigente ✓» según `ck._vigentes[punto]`); si no hay precarga, el bloque actual de la matriz (`valorDe`). Eliminar el forzado a `cubierto` por `admRaw` y por `vl.validado`, las etiquetas «Completado por Administrador / IA» / «Complementado por ti», el elemento `#cka-…` y su CSS (`.ck-adm`, `.tag-adm`, `.tag-comp`, `.ayuda-adm`, `li.admin`). Un punto con información sin confirmar y sin check se pinta «pendiente», no «falta».
- `confirmarValor`: ya no marca el check; si la respuesta trae `vigente`, fusionar `checklist._vigentes` en el estado local; si trae `valor`, actualizar `S.valores`.
- `textoAvance`, `actualizarAvance`, `procesoCompleto` y el aviso de envío dependen de `puntoListo`: no requieren cambios propios.

## Reglas que NO se deben cambiar
- `aplicarPrecarga`, `puedeAutomatico`, `partesDe`, `componer` (la matriz sigue protegiendo el inventario).
- `crearCobertura` (`cobertura.js`), `puntosValidados`, `flujo.js`, el panel del cliente y la consola: su cobertura sigue contando precarga y validaciones.
- No hay migración de base de datos (`schema.sql` no cambia).

## Pruebas (`worker/test/unit/matriz-sync.test.mjs`, `npm run test:unit`)
Nuevas:
- **Mockup del error**: proceso `p5` del inventario con `objetivo` escrito; precarga de los 16 puntos con texto `PRECARGA <punto>` y `archivos: ['doc.pdf']`. Esperado: `bloqueados` = solo `objetivo`; la matriz conserva el inventario; `sesion.precarga_txt.p5` trae los 16 textos (incluidos riesgos, inicio_fin, manual_sistema) con sus archivos; `sesion.respuestas.p5` no existe (ningún check); otra sección no ve `precarga_txt`.
- `POST /r/campo` sobre un punto precargado (p. ej. `riesgos`, sin campo en la matriz): 200 con `vigente: true`; `respuestas.checklist._vigentes.riesgos` existe; `checklist.riesgos` no existe; no se escribe en `matriz_historial`.
- `POST /r/verificar` sin texto ni sistemas sobre ese bloque: los puntos quedan `falta` y `_vigentes` se conserva.
- `POST /r/campo` sobre un texto de la matriz (sin precarga): valida el campo (`validado: true`, evento `validacion` en el historial) y **no** crea `checklist[punto]`.

Existentes que hay que actualizar (asumían que confirmar marcaba el check o que `terceros`/`objetivo` precargados se validaban en la matriz):
- «confirmar que sigue vigente no cambia el texto…»: usar un punto con texto en la matriz y sin precarga (p. ej. `normativa` escrito con `/a/matriz`) y comprobar que no queda check.
- «deshacer la marca revoca la confirmación…»: usar un punto de ese tipo (p. ej. `kpis`), confirmar, marcar «Lo mencioné» con `/r/punto` y deshacer; esperado historial `['validacion','revocacion']`.
- «el historial se consulta con filtros…»: ajustar los conteos (con la prueba nueva hay más eventos `origen=documento`; acotar la consulta con `proceso_id=p1`; las validaciones de María pueden ser 1).
- «un cambio de la consola quita la validación…»: ya no hace falta confirmar `terceros` antes.

## Verificación manual
`cd worker && npm run dev`, con `test/semilla-hu03.mjs` o una campaña propia:
1. Proceso con inventario previo + precarga de los 16 puntos → la encuesta muestra la precarga en todos (incluido el objetivo y los 3 sin campo), con «Cargado por el equipo» y archivos; **ningún** ✓; avance «0 de 17».
2. «Sigue vigente» sobre un punto → «Vigente ✓» y «Revisado», sigue sin ✓.
3. Responder un bloque y dejar que la IA revise → solo los puntos que la respuesta cubre se marcan ✓; los precargados que la persona no tocó siguen vacíos.
4. Consola y panel del cliente: los conteos de cobertura no cambian.
