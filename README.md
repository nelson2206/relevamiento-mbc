# Voz MBC · Relevamiento de procesos

Encuesta por voz para levantar el inventario de procesos de un cliente: la persona cuenta cómo funciona cada proceso, la IA revisa un
checklist por bloque, y el equipo consultor valida la matriz en una consola. Repositorio propio, **separado de Voz MBC**.

| Carpeta | Qué es |
|---|---|
| `index.html` | La encuesta que responden las personas (enlace personal `?k=`, de sección `?c=` y abierto) |
| `admin.html` | La consola del equipo consultor y, con `?cliente=`, el panel de solo lectura del cliente |
| `flujo-gerente.js` | Vista de 4 pasos del Gerente (Supervisor): procesos, delegación, avance, validación final. La carga `admin.html` |
| `usuarios-consola.js` | En la consola: crear y editar usuarios con su perfil, descargar enlaces con claves y mostrar las claves de una carga |
| `flujo-admin.js` | En la consola: insignia «Validada por el gerente», indicador en el resumen y reapertura de aprobaciones |
| `worker/` | El servidor: Cloudflare Worker + D1 + Workers AI (voz) + Claude. Migraciones `migracion-NNN.sql` y `schema.sql` |

Desplegar el servidor (desde `worker/`): `npm install && npx wrangler deploy`. Secretos (nunca en el repo): `ADMIN_CODE`, `INTERNAL_CODE`
(IA vía ProcessIQ) o `ANTHROPIC_API_KEY`. La base: `npx wrangler d1 execute voz-relevamiento --remote --file=schema.sql`.

## Estado y relación con producción (TDP)

Este repositorio nació el 2026-10-21 como copia, con su historial, de la carpeta `relevamiento/` de
[`hub-encuestas-mbc`](https://github.com/nelson2206/hub-encuestas-mbc) (el repo de Voz MBC).

**Producción de TDP vive en https://relevamiento.mbc-latam.com** (desde 2026-10-21). El Worker `voz-relevamiento-api` sirve la encuesta, la consola
y la API en ese mismo dominio: `worker/sitio.mjs` copia `index.html`, `admin.html`, los dos `flujo-*.js` y los íconos a `worker/publico/` antes de cada
despliegue (`npm run deploy` desde `worker/`). La dirección antigua (encuesta.mbc-latam.com/relevamiento/) redirige al dominio nuevo con el mismo enlace.
Hasta el 2026-10-23 se publicaba desde `hub-encuestas-mbc`; esta carpeta quedó **idéntica** a la de ese repo en esa fecha. Mientras ambos existan,
un cambio hecho en uno hay que llevarlo al otro, y **el despliegue de producción debe hacerse con estos archivos** (incluyen el dominio en `wrangler.toml`
y `sitio.mjs`; sin ellos relevamiento.mbc-latam.com se queda sin página). Las migraciones se aplican a la base **antes** de desplegar.

La **demo** (empresa ficticia, sin datos de ningún cliente) se genera desde este código con `voz-relevamiento-demo` y vive solo en su dirección
`workers.dev`: ya no usa relevamiento.mbc-latam.com.

## Perfil de cada persona (Responsable, Supervisor, Gerente)

En «Personas y enlaces» de la consola, cada persona tiene un selector de perfil:

- **Responsable**: responde sus procesos (lo de siempre).
- **Supervisor**: entra al panel del cliente con su clave; su alcance es su sección. Llega hasta el avance, **sin validación final**.
- **Gerente**: su alcance es toda su gerencia; lleva el flujo de 4 pasos y da la validación final.

Al elegir un perfil el Worker (`POST /a/persona/perfil`) crea el acceso y devuelve la clave **una sola vez**; la consola la muestra con la dirección y
prepara un correo `.eml` para Outlook. «Nueva clave» la regenera (la anterior deja de servir); volver a Responsable la desactiva. Solo el Gerente puede
dar la validación final: el servidor responde 403 al Supervisor (`flujo.js`). Los Supervisores que el cliente creó antes quedan como Gerente.
Para que las claves entren, el acceso del cliente de la campaña debe estar activo. Migración `migracion-016.sql` (columnas `perfil` y
`encuestado_id` en `supervisores`); prueba `npm run test:perfiles`.

## Flujo guiado del Gerente (Supervisor)

Quien entra con clave de Supervisor (= Gerente) ve cuatro pasos en lugar del panel completo (que sigue en «Ver detalle completo»):

1. **Procesos**: revisa su inventario; puede **elegir** procesos ya cargados por MBC (se incorporan a su lista sin tocar el inventario; los «suelta» cuando no le corresponden), **crear** procesos nuevos (entran al inventario final) o **quitar** los propios (y restaurarlos).
2. **Delegación**: cada proceso con al menos una persona a cargo (existente o nueva).
3. **Avance**: todos los procesos respondidos (checklist completo).
4. **Validación final**: con todos los procesos validados por MBC, el Gerente da su aprobación; no se puede deshacer.

Las reglas las decide el Worker (`worker/src/flujo.js`), no el navegador: orden de los pasos, compuertas, advertencia antes de un cambio que reinicia
pasos ya confirmados (`409` con `requiere_confirmacion`, se repite con `forzar`) y bloqueo total tras la aprobación. MBC puede **reabrir** una
aprobación desde la consola (queda motivo y fecha). Módulos nuevos del Worker: `comun.js` (utilidades), `ambito.js` (alcance del Supervisor),
`cobertura.js` (cuándo un proceso cuenta como respondido) y `flujo.js`.

Base: `migracion-014.sql` (para una base nueva aplicar, después de `schema.sql`, las migraciones 011, 012 y 014). Prueba: con `npm run dev` corriendo,
`npm run test:flujo` (desde `worker/`) recorre el flujo en una campaña temporal y la borra. `npm run semilla` crea la campaña de demostración «Demo flujo del Gerente» (empresa ficticia, 41 procesos en 5 gerencias, tres Gerentes en etapas distintas); las claves las imprime al terminar.

## Esqueleto de la campaña (hoja «Gerencias»)

La plantilla de carga tiene una hoja `Gerencias` (`area`, `gerencia`, `seccion`) para cargar la estructura Área > Gerencia > Sección **sin procesos**. Al cargar
personas, procesos o la matriz, cada fila se vincula al esqueleto por nombre (sin importar mayúsculas ni tildes) y toma el nombre que tiene allí; lo que no esté se
agrega al esqueleto sin área y se informa en el resumen. «Agregar» amplía y actualiza el esqueleto; «Reemplazar» lo reemplaza. Una campaña sin hoja `Gerencias`
funciona como antes. El mapa agrupa por área y muestra también las gerencias y secciones que aún no tienen procesos. Base: `migracion-015.sql` (tabla `estructura`);
código: `worker/src/estructura.js`; prueba: `npm run test:estructura`.

## Usuarios desde la consola (Supervisor, Gerente y Responsable)

**Personas y enlaces** permite crear (`+ Nuevo usuario`) y editar (`Editar`) a cada persona: datos personales, perfil, sección y gerencia principal y las secciones y
procesos que recibe. Marcar una sección le da **todos sus procesos a la vez**; una persona puede recibir secciones de varias gerencias. Un Supervisor o Gerente se puede crear
**sin procesos**: su alcance sale del nombre de su sección o gerencia, y si no existe se agrega al esqueleto. Rutas: `POST /a/usuario` (crear o editar) y `POST /a/persona/perfil`.

- **Carga por Excel**: la hoja `Encuestados` acepta la columna `perfil` (responsable, supervisor o gerente). Una persona con varias secciones va en **una fila por sección con el
  mismo correo**: la primera es su sección principal; las demás le suman los procesos de esa sección. Las claves de las cuentas nuevas se muestran una sola vez al terminar la carga.
- **Descarga de enlaces personales**: incluye el enlace de la encuesta de cada persona y, para Supervisores y Gerentes, el enlace del panel y su clave. Como la clave solo se guarda
  cifrada, incluirla significa **generar una nueva**. Por seguridad la consola lo hace solo para quien **aún no ha ingresado**; a quien ya usa su clave no se la toca salvo
  que se confirme (quedaría fuera hasta recibir la nueva), y el Excel dice «Ya la tiene» (`POST /a/personas/claves`).
- **Constructor del mapa**: muestra también las secciones del esqueleto y de las personas que aún no tienen procesos, para asignárselos a mano.

**Qué ve cada perfil en el panel** (`GET /c/flujo`): el **Supervisor** trabaja 3 pasos (la validación final no es suya): no recibe el paso 4 ni la validación de MBC, ve solo el avance de
sus responsables y, al confirmar el paso 3, queda «terminado»; empieza con los procesos de su sección, pero puede **tomar** libremente procesos de otras secciones o gerencias («Elegir del inventario») y **crear** procesos en cualquier sección que exista en la campaña; lo que toma o crea se suma a su lista (no a la de otros). El **Gerente** ve los 4 pasos, el avance de los Supervisores
de su gerencia (por pasos y procesos respondidos) y el de todos los responsables. En la consola, una gerencia figura como validada cuando la da el Gerente, aunque tenga Supervisores.
Pruebas: `npm run test:unit`, `test:usuarios`, `test:seguridad`, `test:perfiles`, `test:flujo`, `test:estructura` (con `npm run dev` corriendo).

**Editar un usuario conserva lo que no muestra el formulario**: los procesos que un Supervisor o Gerente tomó o creó por su cuenta y las gerencias adicionales de un Gerente no se
borran al guardar una edición ni al cambiarle el perfil; solo cambia lo que el formulario controla (por ejemplo, una sección desmarcada). **Despliegue**: `npm run deploy` (en
`worker/`) copia a `publico/` las páginas, sus scripts y los íconos de la raíz del repo (`favicon.png`, `apple-touch-icon.png`, `icon-512.png`, `og-image.png`); `npm run test:unit`
funciona con cualquier versión de Node.
