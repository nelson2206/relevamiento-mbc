# Embudo de puntos de contacto: definiciones

> Versión inicial (Paquete 1, 11-nov-2026). Cubre los pasos 3 a 6. Los pasos 1, 2 y 7 se definen y miden en los Paquetes 2 y 3.
> Los nombres exactos de columnas están en `EMBUDO-diccionario.md`. El catálogo vive en `worker/src/embudo.js` (`EVENTOS`).

## 1. Para qué sirve

Responder, con fechas y nombres, dónde se detiene cada persona: el gerente no compartió el enlace, la persona no lo abrió, lo abrió y no creó su acceso, creó su acceso y no empezó, o empezó y no avanzó. La vista del embudo **no** está en la herramienta: se arma fuera (Excel, Power BI o un HTML aparte) con `GET /a/embudo/export`.

## 2. Criterio de no invasión (obligatorio)

El seguimiento no debe notarse ni molestar a quien usa la herramienta. Reglas que no se negocian:

1. **Cero cambios visibles en el flujo**: sin ventanas emergentes, banners, avisos de consentimiento nuevos, pasos extra ni demoras. La única modificación visible es una frase breve dentro del aviso de privacidad que ya existe («Cómo tratamos lo que nos cuentas»).
2. **Sin llamadas de red nuevas desde el navegador**: el identificador de visitante viaja como parámetro en llamadas que ya existen (`/r/abierta`, `/r/identificar`, `/r/registro`). No hay balizas, píxeles, sondeos ni eventos de clic, desplazamiento o tiempo en página. El correo del gerente sigue saliendo por Outlook sin píxel de rastreo.
3. **Sin cookies, sin huella del navegador, sin IP, sin user-agent**. El único dato del navegador es un UUID aleatorio guardado en `localStorage` (clave `relev-v`), dentro de `try/catch`: si el almacenamiento está bloqueado o falla, todo funciona igual y el evento queda sin visitante.
4. **Datos mínimos**: solo los hitos del embudo (compartió, abrió, creó acceso, primera respuesta). Nunca el contenido de las respuestas, PIN, claves, tokens ni correos; tampoco comportamiento fino.
5. **Registro asíncrono**: el evento se guarda en segundo plano (`ctx.waitUntil`) después de responder a la persona; no agrega latencia perceptible. Si el registro falla, la acción principal responde igual y el fallo queda solo en el log del Worker (`evento_error`).
6. Todo queda en la base D1 propia de la campaña, sin analítica de terceros, y se borra junto con la campaña.

## 3. Los 7 pasos y qué cuenta en cada uno

| # | Paso | Qué cuenta | Evento que lo mide | Estado |
|---|---|---|---|---|
| 1 | El gerente recibe su enlace o clave | Se generó la clave; se marcó como enviada | `acceso_gerente_generado`, `acceso_gerente_enviado` | Paquete 2 (solo reconstruido de la primera clave) |
| 2 | El gerente abre su enlace | Primera entrada al panel; cada entrada posterior | `gerente_abrio`, `gerente_entro` | Paquete 2 (solo reconstruido) |
| 3 | El gerente comparte con su equipo | Genera el correo o el enlace de una persona; delega procesos a una persona; agrega a una persona | `enlace_compartido`, `procesos_delegados`, `persona_agregada` | Medido desde el despliegue |
| 4 | La persona abre el enlace | Carga la página del enlace de sección; se identifica con nombre y PIN | `enlace_abierto`, `persona_identificada` | Medido desde el despliegue |
| 5 | La persona crea su acceso | Fija su PIN por primera vez (precargada por Excel) o se registra sola | `acceso_creado` | Medido desde el despliegue |
| 6 | La persona empieza | Primer guardado **con contenido** en un proceso | `primera_respuesta` | Medido desde el despliegue |
| 7 | Avance | Proceso completo y validado | `proceso_completo`, `proceso_validado` | Paquete 3 |

### «Abrió»
- **Medido**: la persona cargó el enlace de sección con un visitante anónimo (`enlace_abierto`) y luego se identificó con ese mismo navegador. La apertura se atribuye a la persona cuyo identificador de visitante aparece **solo con ella**.
- **Ventana anti-ruido**: varias cargas del mismo visitante y la misma sección en menos de 30 minutos cuentan una vez.
- **Inferido**: si no hay apertura medida pero la persona ya se identificó o creó su acceso, se toma el más antiguo de esos hitos (para identificarse hubo que abrir el enlace). Se rotula `f_abrio_origen = inferido`.
- **No atribuible**: quien abre y nunca se identifica no se puede asociar a una persona; solo cuenta como visitante anónimo de la sección (eventos `enlace_abierto` sin `persona_id`). Un visitante que aparece con más de una persona (equipo compartido) no se atribuye a ninguna: sus aperturas no se suman a nadie y se usa la regla de «inferido».
- Limitaciones: la misma persona en dos dispositivos cuenta como dos visitantes; un navegador con almacenamiento bloqueado no deja apertura (se prefiere subcontar a inflar); no hay medición anterior al despliegue.

### «Creó acceso»
La persona fijó su PIN de 4 dígitos. En el registro abierto es el momento del registro (exacto). En personas precargadas por Excel el PIN se fija en su primer ingreso: desde el despliegue queda medido; antes, la fecha no se guardó y el backfill la aproxima con el primer rastro de la persona (`aprox = cota`).

### «Empezó» (primera respuesta)
Primer guardado de una persona en un proceso con **contenido**: texto no vacío, sistemas marcados, respuesta estructurada con datos o un punto marcado «lo mencioné» o confirmado como vigente. No cuenta la verificación de la IA, ni elegir procesos, ni confirmar la relación con un proceso. Es una vez por persona y proceso.

### «Completo»
Es la regla de `worker/src/cobertura.js` (`crearCobertura().persona(proceso, persona).completo`): los puntos de los bloques cubiertos o marcados «no aplica», contando lo que el equipo precargó. No se inventa otra regla. La extracción usa exactamente esa función para `procesos_completos` y los porcentajes. Nota: la consola y el panel del cliente usan una copia de esa regla en el navegador (`admin.html`); una prueba de paridad queda para el Paquete 3.

## 4. Medido y reconstruido

| | Medido | Reconstruido |
|---|---|---|
| Cómo nace | El código registra el hito en el momento | `POST /a/embudo/backfill` lo deduce de datos anteriores |
| Marca | `reconstruido = 0` | `reconstruido = 1` y `detalle.reconstruido = true` |
| Precisión | Fecha exacta | Aproximada; a veces una cota (`detalle.aprox`) |
| Desde cuándo | Desde el despliegue del Paquete 1 (pasos 3 a 6) | Datos anteriores al despliegue |

Qué NO se puede reconstruir: aperturas del enlace (paso 4); cuántas veces entró cada persona o gerente; cuándo se entregó la clave vigente; a qué persona se mandó cada correo o enlace copiado (solo la cantidad); PIN fallidos históricos.

Reglas del backfill:
- Una sola vez; repetirlo no duplica (cada evento lleva una clave única) y nunca toca lo medido.
- Los eventos que se repiten (`enlace_compartido`, `procesos_delegados`, `persona_identificada`, `gerente_entro`) solo se reconstruyen hasta 10 segundos antes del primer evento medido de ese tipo: lo posterior ya lo midió el código y no se cuenta dos veces.
- Los eventos de «primera vez» (`acceso_creado`, `primera_respuesta`, `persona_agregada`) comparten la clave con el evento medido: si ya existe uno, no se crea otro.
- Para análisis de tiempos entre pasos conviene usar solo eventos medidos (`reconstruido = 0`) y dejar lo reconstruido para ver «cuántos llegaron».

## 5. Qué se puede decir desde hoy
- Desde el despliegue: quién recibió el enlace o la delegación de su gerente (y por qué canal de la herramienta), quién abrió el enlace y se identificó, quién creó su acceso, quién empezó y cuándo.
- Antes del despliegue: aproximaciones marcadas como reconstruidas.
- Pasos 1, 2 y 7 completos: a partir de los Paquetes 2 y 3.
