# Documentación de funciones · Voz MBC · Relevamiento de procesos

Referencia técnica de lo que hace cada módulo, función y ruta del sistema. Pensada para quien mantiene el código o agrega una función nueva.

Para el uso general del sistema, la puesta en marcha y el despliegue, ver [README.md](../README.md).

> **Alcance.** Se documentan todas las rutas del Worker, los módulos de `worker/src/` y las funciones públicas de los archivos de la consola y del panel del cliente. Las funciones auxiliares internas de `index.js`, `admin.html` e `index.html` se listan por grupo, no una por una.

---

## 1. Vista general

```
 navegador                                   Cloudflare
 ─────────                                   ──────────
 index.html ───── /r/* (token ?k=) ───┐
   encuesta                          │      worker/src/index.js   (router + rutas)
                                     ├───▶  ├─ flujo.js        paso a paso del Gerente
 admin.html ───── /a/* (x-admin-code)─┤      ├─ usuarios.js     personas, perfiles, claves
   consola MBC                       │      ├─ ambito.js       alcance de un Supervisor
   + panel cliente ─ /c/* (x-client-code)   ├─ cobertura.js    cuándo un proceso está respondido
                                     │      ├─ estructura.js   esqueleto Área > Gerencia > Sección
 flujo-gerente.js  (vista del Gerente)│      ├─ docx.js         texto de .docx
 usuarios-consola.js (consola)       │      └─ comun.js        utilidades compartidas
 flujo-admin.js      (consola)       │
                                     └───▶  D1 (base) · Workers AI (Whisper) · Claude (Anthropic)
```

Tres formas de autenticarse en la API:

| Prefijo | Quién llama | Cómo se identifica | Dónde se valida |
|---|---|---|---|
| `/r/*` | Persona que responde la encuesta | Token personal `k` (en la URL o en el cuerpo) | `encuestadoPorToken` (index.js) |
| `/c/*` | Administrador del cliente o Supervisor (Gerente) | Cabecera `x-client-code` | `actorCliente` (index.js) |
| `/a/*` | Equipo consultor MBC | Cabecera `x-admin-code` | `exigirAdmin` (index.js) |

Ninguna clave de Supervisor se guarda en claro: en la base solo queda su huella SHA-256 (`hashClaveSup`, usuarios.js).

---

## 2. Worker: punto de entrada (`worker/src/index.js`)

### 2.1 Exportación por defecto

| Función | Qué hace |
|---|---|
| `scheduled(event, env, ctx)` | Tarea programada (cada 15 minutos, `wrangler.toml`). Llama a `completarPendientes`. |
| `fetch(req, env, ctx)` | Router HTTP. Responde `OPTIONS` (CORS), `GET /health` público, valida el origen y despacha por `método + ruta`. Cualquier error se convierte en JSON `{ok: false, error}`; los `HttpError` llevan su código, el resto responde 500 y se registra en el log. |

### 2.2 Rutas

**Públicas y de la encuesta (`/r/*`)**

| Ruta | Función | Descripción |
|---|---|---|
| `GET /health` | (inline) | Estado mínimo del servicio. |
| `GET /r/abierta` | `rutaAbierta` | Nombre de la campaña y áreas para el registro del enlace abierto. |
| `GET /r/buscar` | `rutaBuscar` | Buscador de procesos y de personas del inventario. |
| `POST /r/registro` | `rutaRegistro` | Alta de una persona desde el enlace abierto; pide nombre, sección y PIN de 4 dígitos (`pin`), sin correo; rechaza un nombre repetido en la sección. Devuelve su `k`. |
| `POST /r/identificar` | `rutaIdentificar` | Entrar desde un enlace de sección eligiendo su nombre (`id`) de la lista, con su PIN (`pin`; quien no tiene lo crea en el primer ingreso). 5 fallos bloquean 10 min (`exigirPin`). |
| `POST /a/encuestado/pin` | `rutaEncuestadoPin` | Restablece el PIN de una persona y, con `revocar_enlace`, cambia su enlace personal (devuelve el nuevo `k`). Migración 017. |
| `POST /a/campana/renovar-accesos` | `rutaRenovarAccesos` | Cierra las sesiones y enlaces personales de la campaña (renueva el token de cada persona): quien tenía un enlace `?k=` vuelve a entrar por su sección con su PIN. Nadie pierde su avance. Migración 018 hace lo mismo una vez, para todas las campañas. |
| `GET /r/sesion` | `rutaSesion` | Datos para pintar la encuesta de la persona. |
| `POST /r/elegir` | `rutaElegir` | Agregar uno o varios procesos a su lista (`asignarProcesos`). |
| `POST /r/soltar` | `rutaSoltar` | Quitar un proceso de su lista y sus respuestas. |
| `POST /r/revision` | `rutaRevision` | Marcar un proceso como vigente, con cambio o no existente. |
| `POST /r/proceso` | `rutaProcesoNuevo` | Crear un proceso nuevo desde la encuesta. |
| `POST /r/respuesta` | `rutaRespuesta` | Guardar el texto y los sistemas de un bloque. Para la pregunta estructurada `bconf` (información altamente confidencial) recibe `datos` en vez de texto: `respuestaEstructurada` (`confidencial.js`) lo limpia, lo guarda en `respuestas.datos` y deja el punto `cubierto` solo si la respuesta está completa («No», o «Sí» con cuál, ubicaciones y detalle de «Otro»). Devuelve `completo`, `faltan` y el checklist. Las marcas a mano y la revisión por bloque (`/r/punto`, `/r/verificar`) rechazan esa pregunta. |
| `POST /r/confidencial` | `rutaConfidencial` → `interpretarConfidencial` | Responder la pregunta 3 **hablando**: recibe el texto ya transcrito (`/r/transcribir`) y la IA **propone** las opciones (Sí/No, cuál, ubicaciones, otro) con política de cero alucinación. No guarda nada: la persona revisa y confirma con `/r/respuesta`. |
| `POST /r/imagen` (`pregunta=bconf&finalidad=confidencial`) | `rutaImagenConfidencial` | Lo mismo con un **archivo** (imagen, PDF o Word): valida el archivo, la IA propone las opciones y no se conserva el archivo. Esa finalidad es solo de la pregunta de opciones; las preguntas de texto la rechazan. |
| `POST /r/verificar` | `rutaVerificar` | La IA marca el checklist del bloque (`unirSistemas`, `guardarChecklist`). |
| `POST /r/punto` | `rutaPunto` | La persona marca un punto como «lo mencioné» o «no aplica». Deshacer una marca también revoca su confirmación de vigencia (queda en el historial). |
| `POST /r/campo` | `rutaCampo` (`matriz-sync.js`) | HU03. La persona confirma que la descripción precargada de un punto sigue vigente. La descripción **no se edita** desde la encuesta (rechaza `texto` con 400): se actualiza sola cuando alguien cuenta algo nuevo y la IA estructura el proceso. Deja el punto cubierto y registra la validación en `matriz_historial`. |
| `POST /r/transcribir` | `rutaTranscribir` | Audio WAV → texto con Whisper (`pistaWhisper` le pasa el glosario). |
| `POST /r/imagen` | `rutaImagen` | Lee una imagen con la IA. No se guarda. |
| `POST /r/enviar` | `rutaEnviar` | Cierra la encuesta de la persona. |

**Panel del cliente (`/c/*`)**

| Ruta | Función | Descripción |
|---|---|---|
| `GET /c/campana` | `rutaClienteCampana` | Volcado de la campaña **sin** respuestas, correos ni enlaces personales. |
| `POST /c/personas` | `rutaClientePersonas` | Agregar responsables a una sección. |
| `POST /c/asignar` | `rutaClienteAsignar` | Asignar procesos a una persona. |
| `POST /c/enlaces` | `rutaClienteEnlaces` | Copiar enlaces personales. |
| `POST /c/enlace-abierto` | `rutaClienteEnlaceAbierto` | Devolver el enlace abierto de la campaña. |
| `POST /c/supervisores` | `gestionarSupervisores` | Crear, editar, activar, desactivar o renovar la clave de un Supervisor. Solo administrador del cliente. |
| `GET /c/trazabilidad` | `trazabilidad` | Delegaciones, acciones de los Supervisores y lista de Supervisores. Solo administrador del cliente. |
| `GET /c/flujo` | `rutaFlujo` | Estado de los 4 pasos del Gerente. |
| `GET /c/flujo/catalogo` | `rutaFlujoCatalogo` | Procesos de MBC que el Gerente todavía no tiene en su alcance. |
| `POST /c/flujo/confirmar` | `rutaFlujoConfirmar` | Confirma un paso. |
| `POST /c/flujo/retroceder` | `rutaFlujoRetroceder` | Retira la confirmación del último paso. |
| `POST /c/flujo/proceso` | `rutaFlujoProceso` | Agregar, incorporar, soltar, quitar o restaurar un proceso. |

**Consola del equipo MBC (`/a/*`, con `x-admin-code`)**

| Ruta | Función | Descripción |
|---|---|---|
| `GET /a/health` | `estadoServicio` | Estado de la IA y de los modelos configurados. |
| `GET /a/campanas` | `rutaCampanas` | Lista de campañas. |
| `GET /a/campana` | `rutaCampana` | Volcado completo de una campaña. |
| `POST /a/campana` | `rutaCampanaNueva` | Crear campaña. |
| `POST /a/campana/glosario` | `rutaGlosario` | Guardar el glosario (también orienta a Whisper). |
| `POST /a/campana/sistemas` | `rutaSistemas` | Reemplazar el catálogo de aplicaciones. |
| `POST /a/campana/logo` | `rutaLogo` | Guardar o quitar el logo (data URI). |
| `POST /a/campana/ia` | `rutaCampanaIA` | Activar o desactivar la completación automática de la matriz. |
| `POST /a/campana/estandares` · `POST /a/estandares/probar` | `rutaEstandares` · `rutaEstandaresProbar` | Estándares de la IA y prueba de su salida. |
| `POST /a/campana/invitacion` | `rutaInvitacion` | Texto de invitación. |
| `POST /a/campana/cliente` | `rutaClienteAcceso` | Generar, renovar, desactivar o definir el acceso del cliente. |
| `POST /a/enlace` | `rutaEnlace` | Crear o regenerar el código público (enlace abierto). |
| `POST /a/importar` | `rutaImportar` | Carga de Excel: estructura, personas, procesos con matriz y sistemas. |
| `POST /a/encuestado` | `rutaEncuestadoAlta` | Alta rápida de responsables sin enlace personal. |
| `POST /a/encuestado/borrar` | `rutaEncuestadoBorrar` | Borra personas (con respuestas, solo con `forzar`). |
| `POST /a/respuesta/borrar` | `rutaRespuestaBorrar` | Borra respuestas de una persona en uno o varios procesos. |
| `POST /a/usuario` | `rutaUsuario` | Crear o editar una persona con su perfil, secciones y procesos. |
| `POST /a/persona/perfil` | `rutaPersonaPerfil` | Dar, cambiar o quitar el perfil (Responsable, Supervisor, Gerente). |
| `POST /a/personas/claves` | `rutaClavesPerfiles` | Regenerar claves de Supervisores y Gerentes para descargar enlaces. |
| `POST /a/asignar` | `rutaAsignar` | Agregar o quitar procesos de la lista de una persona. |
| `POST /a/asignar-por-inventario` | `rutaAsignarInventario` | Asignar por el nombre que venía en el inventario anterior. |
| `POST /a/ventana` | `rutaVentana` | Abrir o cerrar la disponibilidad de una sección. |
| `POST /a/proceso` | `rutaProcesoAdmin` | Crear o editar un proceso. |
| `POST /a/proceso/borrar` | `rutaProcesoBorrar` | Borrar un proceso (solo si nadie lo respondió). |
| `POST /a/proceso/mover` | `rutaProcesoMover` | Mover procesos de sección (constructor del mapa). Acepta deshacer. |
| `POST /a/proceso/renombrar` | `rutaProcesoRenombrar` | Renombrar una macroproceso o un proceso dentro de una sección. |
| `POST /a/fuera-alcance` | `rutaFueraAlcance` | Marcar procesos fuera de alcance (no se ven en la encuesta ni se estructuran). |
| `POST /a/entrevista` | `rutaEntrevista` | Estado de entrevista: agendada o realizada. |
| `POST /a/matriz` | `rutaMatriz` | Guardar una fila de la matriz y su check de validación. |
| `POST /a/validacion` | `rutaValidacion` | Validar en bloque. |
| `POST /a/estructurar` | `rutaEstructurar` → `estructurarProceso` | Pide a la IA que complete la matriz de un proceso. |
| `POST /a/precarga/extraer` | `rutaPrecargaExtraer` | Extrae de un archivo (JPG, PNG, PDF o DOCX) lo que explícitamente cubre cada punto. No guarda. |
| `POST /a/precarga` | `rutaPrecarga` → `aplicarPrecarga` | Guarda la precarga de los puntos de un proceso y la refleja en la matriz (única fuente) si el campo está vacío o es una descripción automática y la fila no está validada. Devuelve `escritos` y `bloqueados`. Un punto vaciado retira también la descripción que había puesto la precarga. |
| `POST /a/precarga/borrador` | `rutaPrecargaBorrador` (`documentos.js`) | Aprueba (con el texto corregido, si se quiere) o descarta los borradores que salieron de un documento. Aprobar usa `aplicarPrecarga` con el nombre del documento como origen. |
| `POST /a/documentos/extraer` | `rutaDocumentoExtraer` | Extrae o vuelve a extraer la precarga de un proceso ya confirmado para el documento (reintento tras un error). |
| `GET /a/campana/historial` | `rutaHistorialMatriz` | Historial de cambios de la matriz (campo, valor anterior y nuevo, quién, origen y fecha) con filtros por proceso, campo, origen, persona y fechas. Solo administrador. |
| `POST /a/documentos` | `rutaDocumentoSubir` (`documentos.js`) | HU01. Guarda UN archivo en R2 con su gerencia (obligatoria); queda «pendiente» de clasificar. |
| `GET /a/documentos` | `rutaDocumentos` | Bandeja con filtros por gerencia, estado, análisis IA, confianza, fechas y nombre. Puede ordenar por menor confianza. |
| `GET /a/documentos/archivo` | `rutaDocumentoArchivo` | Devuelve el archivo para abrirlo antes de clasificar. |
| `POST /a/documentos/gerencia` | `rutaDocumentoGerencia` | Cambia la gerencia de un documento. |
| `POST /a/documentos/analizar` | `rutaDocumentoAnalizar` → `analizarDocumentoIA` | HU02. La IA propone hasta 5 procesos con confianza; las sugerencias previas sin confirmar quedan como historial. |
| `POST /a/documentos/procesos` | `rutaDocumentoProcesos` | Lista final de procesos del documento: confirma, quita y agrega. Con procesos pasa a «clasificado»; sin procesos vuelve a «pendiente». Audita sugerido, confirmado y cambios. **Lo recién confirmado lanza la extracción de la precarga en segundo plano** (`ctx.waitUntil`, máximo 8 procesos por confirmación; el resto con «Extraer»): el estado de cada par (documento, proceso) queda en `documento_extracciones` y el resultado en `precarga_borrador`, que no llega a la encuesta hasta que el administrador lo aprueba. Quitar un proceso descarta sus borradores. |
| `POST /a/campana/umbral` | `rutaUmbral` | Umbral de baja confianza (0 a 1, por defecto 0,7). |
| `GET /a/campana/flujo` | `rutaFlujoAdminCampana` → `rutaFlujoAdmin` | Validación final por Gerente y por gerencia. |
| `GET /a/campana/trazabilidad` | `rutaTrazabilidadAdmin` → `trazabilidad` | Igual que `/c/trazabilidad`, desde la consola. |
| `POST /a/flujo/reabrir` | `rutaFlujoReabrir` | Reabre la aprobación final de un Gerente (queda motivo y fecha). |
| `POST /a/borrar-campana` | `rutaBorrarCampana` | Borra una campaña completa; exige escribir su nombre exacto. |

### 2.3 Funciones de apoyo de `index.js`

**Configuración y IA**

| Función | Descripción |
|---|---|
| `iaDe(env, tarea)` | Modelo y nivel de esfuerzo de una tarea (`estructurar`, `revision`, `imagen`). Se toman de `wrangler.toml` y, si faltan, de `IA_POR_DEFECTO` (Claude Sonnet 5.5). |
| `clienteClaude(env)` | Cliente de Anthropic: usa `ANTHROPIC_API_KEY` si existe; si no, el servicio interno de ProcessIQ con `INTERNAL_CODE`. |
| `registrarIA` · `registrarGasto` | Registran cada llamada a la IA (tarea, modelo, tokens) y su costo. |
| `textoParaClaude(camp, p, …)` | Arma el texto que se envía a Claude: ficha del proceso, personas, respuestas, sistemas y precarga. |
| `normalizarSalida(s)` | Limpia la respuesta de la IA antes de leer el JSON. |
| `estructurarProceso(env, procesoId, ctx, origen)` | Núcleo de la completación de la matriz: arma el contexto, llama a Claude y guarda el resultado con su marca de origen. |
| `completarMatriz(env, p, datos)` | Escribe en la matriz solo los campos que la IA puede sostener, marcando cada uno como `dicho`, `inferido` o `vacío`. |
| `completarPendientes(env, ctx)` | Tarea programada: procesos con respuestas nuevas en campañas con `ia_auto`, hasta `AUTO_MAX` por corrida, esperando `AUTO_ESPERA_MIN` minutos después de la última respuesta. |
| `rutaVerificar` · `schemaVerificar` · `unirSistemas` · `guardarChecklist` | Revisión de un bloque: la IA responde con un esquema fijo (`schemaVerificar`), se une con lo que ya cubre el equipo y se guarda. La huella incluye los puntos del bloque: si cambia el checklist, se vuelve a revisar. |
| `pistaWhisper(glosario, sistemas)` | Pista de vocabulario para Whisper, con el glosario y los sistemas de la campaña. |
| `rutaTranscribir` | Transcribe con `@cf/openai/whisper-large-v3-turbo`. El audio se procesa en memoria y se descarta. |
| `leerArchivoSubido` · `bloqueDeArchivo` | Valida el tipo y el tamaño de un archivo subido (imagen, PDF, DOCX). Un PDF se rechaza si pasa de 10 páginas. |

**Encuesta y enlaces**

| Función | Descripción |
|---|---|
| `encuestadoPorToken(env, k)` | Busca a la persona por su token personal. |
| `procesoPermitido(env, e, procesoId)` | Verifica que el proceso esté en la lista de la persona. |
| `exigirAdmin(req, env)` | Valida `x-admin-code` con comparación en tiempo constante y limita a 15 intentos fallidos por 10 minutos por IP. |
| `actorCliente(env, req)` | Identifica a quien usa `x-client-code`: administrador del cliente o Supervisor. Mismo límite de intentos. |
| `soloAdminCliente(actor)` | Rechaza con 403 si quien llama es un Supervisor. |
| `campanaAbierta(env, c)` · `ventanaDe` · `estadoVentana` · `exigirVentanaAbierta` | Disponibilidad de la campaña y de cada sección (horario de apertura y cierre en hora de Lima). |
| `areasDeCampana(env, campId)` | Gerencias y secciones de la campaña (del esqueleto y de los procesos). |
| `buscarProcesos` · `personaQueCoincide` · `mismoNombre` · `nombreParecido` | Búsqueda de procesos y personas en el inventario, con tolerancia a tildes y mayúsculas. |
| `cuerpo(req)` · `json(obj, status, h)` · `cors(req, env)` | Lectura del cuerpo JSON, respuesta JSON y CORS (solo orígenes de `ALLOWED_ORIGINS`). |

**Carga y matriz**

| Función | Descripción |
|---|---|
| `rutaImportar` | Carga del Excel: primero resuelve la estructura (`prepararEstructura`), luego personas y procesos. Con `upsert` actualiza por id o código. |
| `limpiarMatriz` · `leerMatriz` | Normalizan el JSON de la matriz. |
| `trazabilidad(env, campId)` | Arma delegaciones, acciones y supervisores para la vista de trazabilidad. |
| `personasVisibles(env, camp, amb)` | Personas que un Supervisor puede ver: las de sus secciones, las que tienen un proceso suyo y las que ya trabajan en uno. |
| `registrarDelegaciones(env, camp, actor, encId, pids)` | Registra en `acciones` cada delegación hecha por un Supervisor. |

---

## 3. Módulos del Worker (`worker/src/`)

### 3.1 `comun.js` — utilidades compartidas

| Función | Descripción |
|---|---|
| `class HttpError(status, msg, extra)` | Error con código HTTP. `extra` son campos que el cliente recibe junto al mensaje (por ejemplo `requiere_confirmacion`). |
| `ahora()` | Fecha y hora actual en ISO. |
| `uid()` | Identificador aleatorio (UUID). |
| `txt(v, max)` | Convierte a texto, quita espacios y recorta a `max` (500 por defecto). |
| `normal(s)` | Minúsculas, sin tildes y con espacios simples. «Importación» y «importacion» son lo mismo. |
| `mismaArea(a, b)` | Compara gerencias o secciones con `normal`. |
| `log(evento, datos)` | Registro estructurado para Workers Logs. Nunca guarda tokens completos, nombres, correos ni respuestas. |
| `mascara(k)` | Muestra los primeros 4 caracteres de un token, para el log. |
| `tokenNuevo()` | Token de 20 caracteres sin ambiguos (sin 0/O ni 1/l/I), apto para dictar por teléfono. |
| `igualSeguro(a, b)` | Comparación en tiempo constante. |

### 3.2 `ambito.js` — alcance de quien entra al panel

| Función | Descripción |
|---|---|
| `claveArea(g, sec)` | Clave normalizada «gerencia\|sección». |
| `ambitoSobre(actor, filas)` | Procesos y secciones que cubre quien entra. El administrador del cliente ve todo (`secs = null`); un Supervisor ve lo que dice su alcance. |
| `ambitoDe(env, actor)` | Lee las filas de la campaña y llama a `ambitoSobre`. |
| `enSecs(amb, g, sec)` | ¿Está la sección dentro del ámbito? |
| `registrarAccion(env, campId, actor, accion, detalle)` | Guarda una fila en `acciones` (quién, qué y cuándo). |
| `alcanceDe(sup)` | Lee el alcance de un Supervisor desde su JSON: `{todo, gerencias, secciones, procesos}`. |
| `cubreSeccion(sup, g, s)` | ¿Su alcance cubre la sección por acceso total, por gerencia o por sección? No cuenta los procesos sueltos. |
| `esIncorporado(sup, p)` | ¿El proceso entró a su lista a mano (y no por su gerencia o sección)? |

### 3.3 `cobertura.js` — cuándo un proceso cuenta como respondido

Esta es la misma regla que usa la consola (`cobertura()` en `admin.html`), llevada al servidor para que el flujo del Gerente se decida aquí.

| Función | Descripción |
|---|---|
| `crearCobertura({bloques, revisiones, respuestas, precarga})` | Recibe filas ya leídas de D1 y devuelve la función `cobertura(pid)`. No toca la base. |
| `cobertura(pid)` | Estado del proceso entre todas las personas: `respondido`, `en_curso`, `no_vigente` o `sin_cobertura`. Devuelve también puntos cubiertos y total. |
| `cobertura.persona(pid, eid)` | Avance de una persona en un proceso: puntos listos, total y si está completo. |
| `leerJson` · `puntoListo` · `tieneContenido` | Auxiliares. |

Reglas: un proceso está **respondido** si alguien completó los puntos de todas sus preguntas (17 puntos), o si entre todas las personas y la precarga del equipo cubren todos los puntos. Está **en curso** si alguien lo tomó o empezó a responder. Está **no vigente** si solo hay marcas de «ya no se hace».

### 3.4 `estructura.js` — esqueleto Área > Gerencia > Sección

| Función | Descripción |
|---|---|
| `leerEstructura(env, campId)` | Filas del esqueleto de la campaña. |
| `prepararEstructura(existentes, hoja)` | Prepara una carga: normaliza nombres, toma la hoja «Gerencias» y devuelve `{activo, vincular, resultado, sentencias}`. `vincular(g, s, tipo, relleno)` devuelve la gerencia y la sección canónicas. |
| `asegurarEstructura(env, campId, g, s)` | Agrega una gerencia y sección nuevas al esqueleto, si la campaña ya lo usa. |
| `areasDeEstructura(filas)` | Formato `[{gerencia, secciones[]}]` para la consola. |

Una campaña sin esqueleto funciona como antes: sus gerencias y secciones salen de sus procesos.

### 3.5 `docx.js` — texto de un Word

| Función | Descripción |
|---|---|
| `textoDeDocx(buf)` | Devuelve el texto de `word/document.xml`, recortado a `MAX_TEXTO_DOCX` (40 000 caracteres), y si se recortó. Lanza error si el archivo no es un Word válido. |
| `textoDeXmlWord(xml)` | Convierte el XML de Word a texto plano: párrafos, tabuladores, saltos y celdas de tabla. |
| `leerEntrada(buf, nombre)` | Busca una entrada dentro del ZIP sin dependencias externas. |
| `inflar(datos)` | Descomprime con `DecompressionStream`. Corta si pasa de 20 MB. |

Solo se lee el texto: imágenes y diagramas del Word no se leen.

### 3.6 `flujo.js` — pasos del Gerente

Cuatro pasos: **1 Procesos**, **2 Delegación**, **3 Avance**, **4 Validación final**. Las reglas se deciden aquí, no en el navegador.

| Función | Descripción |
|---|---|
| `NOMBRE_PASO` | Nombre de cada paso. |
| `soloSupervisor(actor)` | Rechaza con 403 a quien no es Supervisor. |
| `cargarCampana(env, campId, bloques)` | Lee en paralelo todo lo necesario para calcular cualquier Supervisor de la campaña. |
| `calcular(datos, sup)` | Estado completo de un Supervisor: compuertas de cada paso, pasos vigentes, paso actual, gerencias y procesos de su alcance. Es la función que decide todo lo demás. |
| `leer(env, actor, bloques)` | `cargarCampana` + `calcular` para quien pide. |
| `equipoDe(datos, est, sup)` | Responsables de su alcance y, para el Gerente, los Supervisores de su gerencia con su avance. |
| `seccionesConocidas(env, campId, datos, sup)` | Secciones donde se puede crear un proceso. |
| `rutaFlujo(env, actor, bloques)` | Respuesta de `GET /c/flujo`. Al Supervisor se le oculta el paso 4 y la validación de MBC. |
| `guardarCambio(env, actor, bloques, paso, forzar, severo)` | Guardia de todo cambio: con aprobación dada, no se cambia nada; si un cambio severo afecta pasos ya confirmados, pide confirmación (409 con `requiere_confirmacion`) y, si se fuerza, reinicia esos pasos. También la usan `/c/asignar` y `/c/personas`. |
| `rutaFlujoConfirmar(env, actor, b, bloques)` | Confirma el paso actual si su compuerta se cumple. El paso 4 exige `confirmar_final: true` y lo da solo el Gerente. |
| `rutaFlujoRetroceder(env, actor, bloques)` | Retira la confirmación del último paso. |
| `rutaFlujoProceso(env, actor, b, bloques)` | Acciones del paso 1: `agregar` (proceso nuevo, entra al inventario), `incorporar` (procesos de MBC a su lista), `soltar`, `quitar` y `restaurar`. |
| `candidatosIncorporar` · `incorporar` | Validan y luego agregan procesos a la lista del Supervisor. |
| `guardarAlcance(env, actor, cambiar)` | Cambia el alcance del Supervisor leyendo primero la fila actual. |
| `rutaFlujoCatalogo(env, actor, url, bloques)` | Procesos de MBC fuera de su alcance, con búsqueda y el nombre de quien ya los gestiona. |
| `rutaFlujoAdmin(env, camp, bloques)` | Resumen para la consola: estado de cada Gerente y de cada gerencia (`sin_iniciar`, `en_curso`, `aprobada`). |
| `rutaFlujoReabrir(env, b)` | Reabre la aprobación de un Gerente. Exige un motivo de al menos 5 caracteres y lo registra. |

### 3.7 `usuarios.js` — personas, perfiles y claves

| Función | Descripción |
|---|---|
| `sha256Hex(x)` · `hashClaveSup(k)` | Huella SHA-256. La clave de un Supervisor se guarda como `voz-sup:` + clave. |
| `generarClave()` | Clave de 12 caracteres con letras y números. |
| `listaSupervisores(env, campId)` | Lista de Supervisores con su alcance ya leído como objeto. |
| `validarClaveNueva(env, camp, k, ignorarSupId)` | Reglas de la clave: 8 a 40 caracteres, letras y números, sin patrones fáciles, sin el nombre del cliente ni de la campaña, distinta a la de administración y no repetida. |
| `alcanceValido(env, camp, a)` | Valida y canonicaliza un alcance de Supervisor (gerencias, secciones y procesos). Exige que quede al menos uno, salvo acceso total. |
| `gestionarSupervisores(env, camp, actor, b)` | Crear, editar, activar, desactivar o cambiar la clave de un Supervisor. |
| `conocidas(env, campId)` · `alcancePorNombres(env, camp, a)` | Alcance por nombres para una cuenta que aún no tiene procesos. Agrega la sección al esqueleto si hace falta. |
| `aplicarPerfil(env, camp, enc, perfil, op)` | Núcleo de los perfiles: crea, actualiza o desactiva la cuenta de Supervisor o Gerente de una persona. Devuelve la clave solo cuando se crea o se renueva. |
| `rutaPersonaPerfil(env, b)` | Cambia el perfil de una persona (`POST /a/persona/perfil`). |
| `asignarSeccionesYProcesos(env, campId, encId, secciones, procesos)` | Asigna todos los procesos vigentes de una sección y los procesos sueltos (origen `consultor`). Devuelve cuántos asignó. |
| `rutaUsuario(env, b)` | Crea o edita una persona completa: datos, perfil, secciones y procesos (`POST /a/usuario`). |
| `rutaClavesPerfiles(env, b)` | Genera claves nuevas para descargar enlaces (la anterior deja de servir). |

Perfiles: **Responsable** (responde sus procesos), **Supervisor** (su sección; llega hasta el paso 3) y **Gerente** (su gerencia; da la validación final).

### 3.8 Otros archivos de `worker/`

| Archivo | Qué es |
|---|---|
| `sitio.mjs` | Copia `index.html`, `admin.html`, los `flujo-*.js`, `usuarios-consola.js` e íconos a `worker/publico/` antes de desplegar. |
| `schema.sql` y `migracion-002.sql` a `migracion-022.sql` | Esquema de la base D1. `schema.sql` trae el **estado final** (base nueva: solo ese archivo). Las migraciones sirven para actualizar una base existente: se aplican en orden y **antes** de desplegar. 017–018 (PIN y renovación de accesos), 019 (documentos), 020 (`matriz_historial`), 021 (`precarga_borrador` y `documento_extracciones`), 022 (`respuestas.datos`, para la pregunta estructurada). `test/unit/esquema.test.mjs` falla si una migración crea algo que `schema.sql` no tiene. |
| `wrangler.toml` | Configuración del Worker: base, variables de modelo de IA (`IA_MODELO_*`, `IA_ESFUERZO_*`), orígenes permitidos y la tarea programada. |

---

## 4. Frontend

### 4.1 `index.html` — la encuesta de las personas

Funciones principales (todas dentro de un único `<script>`):

| Grupo | Funciones |
|---|---|
| Utilidades | `esc`, `sinTildes`, `fmt`, `terminos`, `resaltar`, `api(path, body)` (llamadas a `/r/*`), `errorGeneral` |
| Buscador accesible | `crearBuscador(o)`: buscador con teclado (flechas, Enter, Esc) usado en el registro y en «agregar proceso» |
| Entrada | `cargarAbierto`, `pintarAbierto`, `entrarComo`, `pintarSeccion`, `identificar`, `mostrarRegistro`, `registrar` |
| Lista de procesos | `pintarProcesos`, `agregarProceso`, `elegirPersonal`, `elegirVariosPersonal`, `soltar`, `avisoDuplicado`, `procesosActivos` |
| Revisión del proceso | `tarjetaRevision`, `marcarRevision`, `guardarRevision` |
| Respuestas por bloque | `tarjetaProceso`, `pintarChecklist`, `ponerChecklist`, `marcarPunto`, `textoAvance`, `pintarAvanceProc` |
| Sistemas | `pastillaSistema`, `asegurarSistema`, `filtrarSis`, `pintarSelSis`, `agregarSis`, `aplicarSistemas` |
| Guardado | `guardar(pid, qid)` con `programarGuardado` (guarda solo al dejar de escribir), `actualizarAvance` |
| Revisión con IA | `verificar(pid, bid, manual)`, `programarRevision`, `revisarPendientes` |
| Voz | `iniciar`, `detener`, `alternarGrabacion`, `transcribir`, `enviarTramo`, `tramosWav`, `wav` (graba en tramos de 2 minutos) |
| Imágenes y PDF | `leerImagen`, `pedirFinalidad`, `revisarPdf`, `contarPaginasPdf`, `reducirImagen` (máx. 1600 px, JPEG), `archivoInvalido` |
| Cierre | `mostrarFin`, `miEnlace` |

### 4.2 `admin.html` — la consola del equipo MBC y el panel del cliente

Es el archivo más grande (unas 300 funciones). Se organiza en pestañas (`data-tab`) y en vistas (`vLogin`, `vCampanas`, `vCampana`, `vCobertura`, `vConstructor`, `vCliente`).

| Área | Funciones clave | Qué hacen |
|---|---|---|
| Sesión y campañas | `api(path, body)`, `entrar`, `entrarCliente`, `pintarCampanas`, `borrarCampana`, `ver`, `copiar` | Entrar con el código de administración o con el del cliente; listar, abrir y borrar campañas. |
| Resumen | `pintarKpis`, `llenarFiltros`, `barraCob`, `cobertura`, `avancePersona`, `puntosUnidos` | Indicadores y filtros. La cobertura replica la regla de `cobertura.js`. |
| Mapa de procesos | `pintarMapa`, `listaMapa`, `fijarVistaMapa` | Árbol Gerencia > Sección > Macroproceso > Proceso. |
| Constructor del mapa | `pintarConstructor`, `elegirNodo`, `marcarFuera`, `borrarNodo`, `dialogoMover`, `confirmarMover`, `avisarDeshacer`, `soltarEn`, `zonaEn`, `terminarToque` | Mover procesos entre secciones con arrastre o con toque, con confirmación e historial para deshacer. |
| Matriz | `pintarMatriz`, `pintarMatrizLista`, `gridMatriz`, `arbolMatriz`, `filaMx`, `celdaMx`, `pedirValidador`, `sugerencias`, `faltantes` | Matriz de procesos con columnas plegables; muestra lo que falta para el contrato. |
| Exportar | `exportarMatriz`, `hojaMatriz`, `libroInventario`, `guardarLibro`, `nombreArchivo` | Excel de la matriz e inventario. |
| Detalle de un proceso | `detalle`, `editorMatriz`, `activarEditor`, `leerEditor`, `activarPrecarga`, `seccionPrecarga`, `editarProceso`, `estructurar` | Edición de la matriz, precarga de puntos y pedido de completación a la IA. |
| Plan de barrido | `pintarBarrido`, `pintarTablaBarrido`, `resumenSecciones`, `prioridadSeccion`, `accion`, `abrirMenu`, `exportarEnlacesSeccion` | Seguimiento por sección: prioridad, avance y acciones. |
| Entrevistas | `pintarEntrevistas`, `guardarEntrevista`, `filtradasEn`, `lunesDe`, `pintarEntrResumen` | Agenda y estado de entrevistas por semana. |
| Personas y enlaces | `pintarEncuestados`, `listaPersona`, `avanceTotal`, `borrarPersonas`, `borrarRespuestas`, `procesosPersona`, `cambiarPerfil`, `dialogoAccesoPerfil`, `celdaPerfil` | Lista de personas, sus enlaces y su perfil. |
| Carga y configuración | `leerMatrizExcel`, `normEnc`, `claveEstructura`, `pintarEstructuraResumen`, `resultadoEstructura`, `pintarLogo`, `guardarLogo`, `hoja` | Lectura del Excel de carga y configuración de la campaña. |
| Acceso del cliente | `pintarAccesoCliente`, `enlaceCliente`, `cargarCliente`, `pintarPanelCliente`, `resumenCliente` | Credencial del cliente, panel de solo lectura y filtros. |
| Panel del cliente (`/c/*`) | `apiCl`, `getCl`, `dialogoPersonaCl`, `dialogoAsignarCl`, `dialogoProcesosPersonaCl`, `dialogoAsignarProcesoCl`, `pintarListaCliente`, `copiarEnlacesCl` | Lo que puede hacer el administrador del cliente o un Supervisor. |
| Correos de delegación | `htmlCorreoDelegacion`, `construirEml`, `bajarEml`, `descargarCorreosCl`, `pasoCorreoCl` | Genera archivos `.eml` para Outlook con los enlaces. |
| Trazabilidad y Supervisores | `pintarTrazaCl`, `renderTrazaCl`, `pintarSupervisoresCl`, `dialogoSupervisorCl`, `mostrarAccesoSupCl` | Historial de delegaciones y gestión de Supervisores. |

Puntos del diseño: los filtros, plegados y preferencias se guardan en `localStorage` (por navegador), nunca en la base.

### 4.3 `flujo-gerente.js` — vista de 4 pasos del Gerente

Módulo `FlujoGerente` (IIFE). Se monta desde `admin.html` y el Worker decide las reglas.

| Función | Descripción |
|---|---|
| `montar(opciones)` | Recibe `api`, diálogos y utilidades de la consola. Punto de entrada. |
| `refrescar()` · `confirmar(titulo, texto, boton, peligro)` | Recarga el estado y pide confirmación en las acciones delicadas. |
| `cargar()` · `pintar()` · `pie(c, paso, textoBoton)` · `enlazarPie` | Carga, dibuja el paso actual y su pie de navegación. |
| `paso1(c)` | Revisión de procesos; abre `dialogoCatalogo` (elegir de MBC) y `dialogoProceso` (crear). |
| `paso2(c)` · `dialogoBloque` · `equipoHtml` | Delegación: asignar personas a cada proceso. |
| `paso3(c)` | Avance de respuestas por proceso. |
| `paso4(c)` | Validación final. Solo lo ve el Gerente. |
| `activos` · `porSeccion` · `pasosVisibles` · `tope` · `esSup` | Auxiliares: qué procesos cuentan y qué pasos se muestran según el perfil. |

### 4.3b `documentos-consola.js` — carga y clasificación de documentos

Pestaña «Documentos» de la consola. Valida el tipo y el tamaño antes de subir, manda cada archivo por separado y muestra el resultado de cada uno. La bandeja resalta la baja confianza, filtra y permite confirmar los procesos de cada documento. Los datos viven en las tablas `documentos` y `documento_procesos` (`migracion-019.sql`); el archivo, en R2 (binding `DOCS`). La auditoría usa la tabla `acciones` (`documento_carga`, `documento_analisis`, `documento_clasificacion`, `documento_gerencia`, `documento_umbral`).

### 4.4 `usuarios-consola.js` — crear y editar personas

Módulo `UsuariosConsola`. Lo inicia `admin.html` con `iniciar(opciones)`.

| Función | Descripción |
|---|---|
| `iniciar(opciones)` | Recibe `api`, datos de la campaña, diálogos y utilidades. |
| `abrir(id)` | Abre el formulario de una persona (nueva o existente) con su perfil y su alcance. |
| `arbolCampana()` | Árbol de gerencias y secciones para elegir el alcance. |
| `descargarEnlaces(boton)` | Descarga los enlaces personales. Para Supervisores y Gerentes pide claves nuevas (`/a/personas/claves`). |
| `mostrarClaves(claves)` | Muestra las claves generadas por una carga, una sola vez. |

### 4.5 `flujo-admin.js` — estado del flujo en la consola

Módulo `FlujoAdmin`. Lo consulta `admin.html` al abrir una campaña.

| Función | Descripción |
|---|---|
| `iniciar(opciones)` | Recibe `api`, `esc`, `fecha` y `alCambiar` (vuelve a pintar la consola). |
| `cargar(campanaId)` | Lee `GET /a/campana/flujo`. |
| `chip(gerencia)` | Insignia «Validada por el gerente» para el mapa y la matriz. |
| `barra(filtro)` · `resumen()` | Indicador por gerencia en el resumen. |
| `tabla(el)` | Tabla de Gerentes con su paso y el botón para reabrir una aprobación (pide motivo). |

---

## 5. Pruebas

| Comando (desde `worker/`) | Archivo | Qué cubre |
|---|---|---|
| `npm run test:unit` | `test/unit/*.test.mjs` | Sin red (SQLite en memoria con `schema.sql`): `cobertura.js`, `comun.js` + `ambito.js`, `estructura.js`, las reglas de `flujo.js`, PIN y acceso, documentos (HU01/HU02), extracción de precarga y borradores, matriz como única fuente (`matriz-sync.test.mjs`) y el desfase entre migraciones y `schema.sql` (`node --test`). |
| `npm run test:flujo` | `test/flujo.mjs` | Integración del flujo del Supervisor: pasos, advertencias, aprobación y reapertura. Requiere `npm run dev`. |
| `npm run test:usuarios` | `test/usuarios.mjs` | Integración desde la consola: alta y edición de personas, claves, equipo visible y catálogo. Requiere `npm run dev`. |
| `npm run test:seguridad` | `test/seguridad.mjs` | Integración: permisos del Gerente y entradas inválidas en la carga con esqueleto. Requiere `npm run dev`. |
| `npm run test:perfiles` | `test/perfiles.mjs` | Integración de los perfiles Responsable, Supervisor y Gerente. Requiere `npm run dev`. |
| `npm run semilla` | `test/semilla-demo.mjs` | Crea la campaña demo (empresa ficticia). Requiere `npm run dev`. |
| `node test/estructura.mjs` | `test/estructura.mjs` | Integración de la hoja «Gerencias» en la carga. Requiere `npm run dev`. |
| `node test/estandares.mjs` | `test/estandares.mjs` + `test/estandares.json` | Clasificación de estándares (TDP, TMC, otros, normativa). Sin IA por defecto; `--real` llama a la IA. |
