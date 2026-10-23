# Voz MBC · Relevamiento de procesos

Encuesta por voz para levantar el inventario de procesos de un cliente: la persona cuenta cómo funciona cada proceso, la IA revisa un
checklist por bloque, y el equipo consultor valida la matriz en una consola. Repositorio propio, **separado de Voz MBC**.

| Carpeta | Qué es |
|---|---|
| `index.html` | La encuesta que responden las personas (enlace personal `?k=`, de sección `?c=` y abierto) |
| `admin.html` | La consola del equipo consultor y, con `?cliente=`, el panel de solo lectura del cliente |
| `flujo-gerente.js` | Vista de 4 pasos del Gerente (Supervisor): procesos, delegación, avance, validación final. La carga `admin.html` |
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
