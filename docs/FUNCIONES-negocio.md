# Funciones del sistema de relevamiento de procesos

**Voz MBC · Relevamiento de procesos**
Documento para la gerencia y el equipo de negocio. Describe qué hace el sistema, quién lo usa para qué y qué controles protegen la información.

---

## 1. Resumen

El sistema levanta el inventario de procesos de un cliente. Cada persona cuenta, por voz o por texto, cómo funciona su proceso. Una inteligencia artificial revisa que la respuesta cubra los puntos necesarios y completa una matriz ordenada de cada proceso. El equipo consultor valida esa matriz, y los gerentes del cliente dan la aprobación final de su área.

Resultado final: un inventario de procesos validado, por gerencia, con su responsable, sus sistemas y su nivel de avance.

---

## 2. Quién usa el sistema

| Perfil | Quién es | Qué hace |
|---|---|---|
| **Responsable** | Persona que conoce el proceso | Responde sus procesos: cuenta cómo funcionan, qué sistemas usa y qué riesgos tiene. |
| **Supervisor** | Jefe de sección del cliente | Asigna responsables dentro de su sección, revisa el avance y lleva los procesos de su área hasta el avance completo. No da la validación final. |
| **Gerente** | Gerente de área del cliente | Lleva el flujo de cuatro pasos de su gerencia y da la aprobación final. |
| **Equipo consultor MBC** | Consultores de MBC | Crea la campaña, carga la estructura y los procesos, valida la matriz, administra accesos y resuelve excepciones. |
| **Administración del cliente** | Responsable del proyecto en el cliente | Ve el avance completo (sin respuestas ni datos de contacto), asigna responsables, administra a los Supervisores y consulta la trazabilidad. |

---

## 3. Funciones por área

### 3.1 Respuesta de las personas (encuesta)

- **Entrada por el enlace de la sección.** Cada sección tiene un solo enlace. Quien lo abre se registra con su nombre y apellido y un PIN de 4 dígitos, o elige su nombre en la lista y escribe su PIN para retomar su avance. Tras 5 intentos fallidos el acceso queda bloqueado hasta que MBC lo desbloquee en la consola; si alguien olvida su PIN, MBC lo restablece. Ya no se entregan enlaces personales. Los enlaces personales enviados antes quedan sin efecto (migración 018); si hace falta cerrar sesiones más adelante, el botón «Cerrar sesiones activas» de Personas y enlaces lo hace por campaña. También existe un enlace abierto para quien no encuentra su sección.
- **Perfiles Supervisor y Gerente en pausa.** Todo el seguimiento se hace desde la consola de administrador. Las pantallas para crear o cambiar esos perfiles están ocultas; quien ya tiene uno lo conserva.
- **Respuesta por voz o por texto.** La persona graba su explicación en tramos de dos minutos o la escribe. El audio se transcribe y se descarta; solo queda el texto, que la persona puede revisar y corregir.
- **Revisión automática del contenido.** Por cada pregunta escrita (el proceso, sistemas y terceros, datos personales y estándares), la IA marca qué puntos quedaron cubiertos y cuáles faltan. La pregunta de información altamente confidencial se responde marcando Sí o No, diciendo cuál y dónde se almacena, o bien hablando o subiendo un archivo: en ese caso la IA propone las opciones y la persona las revisa y confirma antes de que se guarden. Su respuesta alimenta el análisis del proceso.
- **Material de apoyo.** La persona puede subir una imagen, un PDF o un Word. La IA lee lo que dice explícitamente y lo usa como respaldo, sin guardar la imagen.
- **Procesos propios.** La persona puede agregar un proceso que no aparecía en el inventario, o quitar uno que no le corresponde.
- **Cierre.** Al terminar, la persona envía su respuesta.

### 3.2 Completar la matriz con IA

- Cada proceso tiene una **matriz** con las columnas del inventario del cliente y las del contrato.
- La IA completa cada campo marcándolo como **dicho** (lo mencionó la persona), **inferido** (se deduce de lo dicho) o **vacío** (no hay información).
- Cada 15 minutos, el sistema completa automáticamente los procesos que recibieron respuestas nuevas, si la campaña lo tiene activado.
- Los campos inferidos se confirman en la validación final; nada queda como cierto sin revisión.

### 3.3 Consola del equipo MBC

| Función | Para qué sirve |
|---|---|
| **Campañas** | Crear, abrir y borrar campañas. Cada cliente tiene su propia campaña, separada de las demás. |
| **Carga de Excel** | Cargar la estructura (área, gerencia, sección), las personas y los procesos con su matriz. Permite actualizar lo existente sin duplicar. |
| **Mapa de procesos** | Ver el árbol de gerencias, secciones, macroprocesos y procesos. Se pueden mover procesos entre secciones, con confirmación y opción de deshacer. |
| **Matriz y validación** | Revisar y editar la matriz, validar procesos en bloque y exportar el inventario a Excel. |
| **Plan de barrido** | Seguir el avance por sección: prioridad, cuántas personas respondieron y qué acción sigue. |
| **Disponibilidad por sección** | Abrir o cerrar la encuesta de una sección en una fecha, con un mensaje para las personas. |
| **Entrevistas** | Agendar y marcar entrevistas realizadas, por semana. |
| **Personas y enlaces** | Dos apartados: **Usuarios registrados** (alta y edición, procesos, restablecer PIN, desbloquear, último ingreso) y **Gerencias → Secciones** (el enlace de cada sección, con las personas registradas). |
| **Procesos fuera de alcance** | Marcar procesos que no se levantan, para que no aparezcan en la encuesta. |
| **Precarga de documentos** | Adjuntar documentación existente por punto del checklist, para que las personas no tengan que repetirla. |
| **Acceso del cliente** | Generar, renovar o desactivar el acceso del cliente y definir su clave. |

### 3.4 Panel del cliente

El administrador del cliente y los Supervisores entran con su clave a un panel propio, con lo que les corresponde:

- **Avance** por gerencia, sección y proceso, sin ver respuestas ni datos de contacto.
- **Asignación de responsables** dentro de su alcance, con los enlaces para cada persona.
- **Correos de delegación** listos para enviar desde Outlook.
- **Gestión de Supervisores** (solo administración del cliente): crear, editar, activar, desactivar y renovar claves.
- **Trazabilidad**: quién asignó qué, cuándo, y qué acciones hizo cada Supervisor.

### 3.5 Flujo del Gerente: cuatro pasos hasta la aprobación

| Paso | Qué hace el Gerente | Condición para avanzar |
|---|---|---|
| **1. Procesos** | Revisa los procesos de su gerencia. Puede elegir procesos ya cargados por MBC, crear procesos nuevos o quitar los que no le corresponden. | Tener al menos un proceso en su alcance. |
| **2. Delegación** | Asigna a una persona responsable a cada proceso. | Cada proceso tiene al menos un responsable. |
| **3. Avance** | Da seguimiento hasta que las personas completen sus respuestas. | Todos los procesos respondidos. |
| **4. Validación final** | Da su aprobación final de la gerencia. | Todos los procesos validados por MBC. |

Los pasos se confirman en orden. Un paso puede volver a abrirse si cambia algo que lo sostenía.

**Dato importante:** el Supervisor llega hasta el paso 3. La validación final es exclusiva del Gerente.

---

## 4. Controles y reglas de negocio

| Control | Qué protege |
|---|---|
| **Orden obligatorio de los pasos** | Ningún gerente aprueba antes de completar el trabajo previo. |
| **Advertencia antes de reiniciar un paso** | Si un cambio obliga a repetir pasos ya confirmados, el sistema pide confirmación explícita. |
| **Aprobación final irreversible** | Una vez aprobada, la gerencia no puede modificar nada. Solo MBC puede reabrirla, con motivo registrado. |
| **Separación de perfiles** | El Supervisor no ve ni puede dar la validación final. Cada perfil ve solo lo que le corresponde. |
| **Alcance limitado** | Cada Supervisor y Gerente ve solo su sección o gerencia, más los procesos que se le agregaron expresamente. |
| **Registro de acciones** | Cada asignación, cambio de perfil, delegación, reapertura y aprobación queda con quién, qué y cuándo. |
| **Claves protegidas** | Las claves de Supervisores y Gerentes no se guardan en claro. Solo se muestran una vez, al crearlas o renovarlas. |
| **Límite de intentos** | Después de 15 intentos fallidos con una clave, el acceso se bloquea por 10 minutos. |
| **Bloqueo de procesos validados** | Un proceso validado por MBC no puede quitarlo el Supervisor. |

---

## 5. Datos y seguridad

- **Separación por cliente.** Cada campaña tiene sus propios datos. Al cierre del proyecto, la información puede borrarse por completo.
- **Audio no guardado.** La grabación se procesa en memoria y se descarta. Solo se guarda el texto que la persona revisó.
- **Imágenes no guardadas.** Los archivos de apoyo se leen para extraer el contenido y no se almacenan.
- **Registros sin datos personales.** Los registros operativos no contienen nombres, correos, respuestas ni claves completas.
- **Acceso por rol.** Ningún cliente puede entrar a la consola de MBC, y ningún Supervisor puede entrar a la administración del cliente.
- **Respuestas de la IA sobre datos de la persona.** La IA recibe el texto de la respuesta y la ficha del proceso para estructurarlo; no recibe claves ni datos de acceso.

---

## 6. Ciclo completo de un proceso

1. **Carga:** MBC carga la estructura y los procesos de la campaña.
2. **Asignación:** el equipo, el administrador del cliente o el Gerente asignan responsables.
3. **Respuesta:** cada persona responde por voz o texto y adjunta documentación si la tiene.
4. **Revisión:** la IA verifica los puntos de cada bloque y completa la matriz.
5. **Validación MBC:** el equipo consultor revisa y valida la matriz.
6. **Aprobación del Gerente:** cuando todos los procesos de su gerencia están validados, el Gerente da su aprobación final.
7. **Entrega:** se exporta el inventario validado a Excel.

---

## 7. Glosario

| Término | Significado |
|---|---|
| **Campaña** | Proyecto de relevamiento de un cliente. |
| **Matriz** | Ficha de cada proceso con sus campos (objetivo, actividades, sistemas, controles, etc.). |
| **Checklist** | Lista de puntos que cada proceso debe cubrir, agrupados en cuatro preguntas (tres escritas y una de opciones sobre información altamente confidencial). |
| **Precarga** | Documentación existente que cubre puntos del checklist. |
| **Dicho / Inferido / Vacío** | Origen de cada dato de la matriz: lo mencionó la persona, lo dedujo la IA o no hay información. |
| **Validación** | Revisión final de MBC sobre un proceso. |
| **Aprobación final** | Visto bueno del Gerente sobre su gerencia. Es irreversible salvo reapertura por MBC. |
| **Alcance** | Conjunto de gerencias, secciones y procesos que puede ver y gestionar un Supervisor o Gerente. |
| **Ventana** | Período en que una sección puede responder la encuesta. |
