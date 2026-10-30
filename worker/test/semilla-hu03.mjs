// Datos de prueba de la HU03 (precarga sincronizada matriz ↔ encuesta): empresa FICTICIA, sin datos de ningún cliente.
//   node test/semilla-hu03.mjs                  → contra http://127.0.0.1:8787 (npm run dev); borra y vuelve a crear la campaña
//   node test/semilla-hu03.mjs --api URL        → otro Worker (solo uno de pruebas)
//
// Deja una sección con tres procesos para recorrer cada criterio de la HU:
//   «Gestión de contratos»      precarga desde documento y del equipo en 5 puntos → se ven editables, con su origen; probar conservar, editar y reemplazar
//   «Control de accesos»        precarga con un punto ya validado por otra persona (Marta) → debe aparecer «Validado» y contar como listo
//   «Registro de incidentes»    sin precarga y un campo editado desde la consola → control: solo ese campo muestra «Editado por el equipo»
// Más una persona de otra sección (Pedro) que NO debe ver nada de lo anterior.
// El origen «Sugerido por IA» necesita la IA real (Estructurar con IA en la consola); las demás fuentes se prueban con esto.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : ''; };
const API = arg('--api') || 'http://127.0.0.1:8787', ORIGEN = arg('--origen') || 'http://localhost:8080';
const ADMIN = process.env.ADMIN_CODE || (() => { try { return /^ADMIN_CODE=(.*)$/m.exec(readFileSync(join(aqui, '..', '.dev.vars'), 'utf8'))[1].trim(); } catch (e) { return ''; } })();
if (!ADMIN) { console.error('Falta ADMIN_CODE (variable de entorno o worker/.dev.vars)'); process.exit(2); }

const NOMBRE = 'Demo HU03 precarga', G = 'Cumplimiento', S = 'Contratos', OTRA = 'Riesgos';
async function http(metodo, ruta, cuerpo, cab) {
  const r = await fetch(API + ruta, { method: metodo, headers: Object.assign({ origin: ORIGEN, 'content-type': 'application/json' }, cab || {}), body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(metodo + ' ' + ruta + ' → ' + r.status + ' ' + (j.error || ''));
  return j;
}
const admin = (m, r, c) => http(m, r, c, { 'x-admin-code': ADMIN });

console.log('Recreando la campaña «' + NOMBRE + '»…');
for (const c of (await admin('GET', '/a/campanas')).campanas.filter(x => x.nombre === NOMBRE)) await admin('POST', '/a/borrar-campana', { campana_id: c.id, confirmar: NOMBRE });
const cid = (await admin('POST', '/a/campana', { nombre: NOMBRE, cliente: 'Empresa Demo (ficticia)' })).id;
await admin('POST', '/a/importar', { campana_id: cid, modo: 'agregar', estructura: [{ area: 'Soporte', gerencia: G, seccion: S }, { area: 'Soporte', gerencia: G, seccion: OTRA }] });

const proc = {};
for (const [clave, sec, nombre, desc] of [
  ['contratos', S, 'Gestión de contratos', 'Alta, revisión legal, firma y seguimiento de contratos con proveedores.'],
  ['accesos', S, 'Control de accesos', 'Alta, cambio y baja de accesos a los sistemas del área.'],
  ['incidentes', S, 'Registro de incidentes', 'Registro y cierre de incidentes de cumplimiento.'],
  ['otra', OTRA, 'Matriz de riesgos', 'Proceso de otra sección: control de privacidad.']
]) proc[clave] = (await admin('POST', '/a/proceso', { campana_id: cid, gerencia: G, seccion: sec, macroproceso: 'Cumplimiento', proceso: nombre, descripcion: desc, codigo: 'CUM-' + clave.slice(0, 3).toUpperCase() })).id;

await admin('POST', '/a/encuestado', { campana_id: cid, personas: [
  { nombre: 'Carla Prueba', gerencia: G, seccion: S }, { nombre: 'Marta Prueba', gerencia: G, seccion: S }, { nombre: 'Pedro Prueba', gerencia: G, seccion: OTRA }] });
const gente = (await admin('GET', '/a/campana?id=' + cid)).encuestados;
const quien = n => gente.find(x => x.nombre === n);
// Como en producción: enlace abierto de la campaña, enlace de sección y entrada con nombre + PIN (el PIN se crea en el primer ingreso).
const codigo = (await admin('POST', '/a/enlace', { campana_id: cid, abierta: true })).codigo_publico;
const PIN_MARTA = '2222';
const k_marta = (await http('POST', '/r/identificar', { c: codigo, id: quien('Marta Prueba').id, pin: PIN_MARTA })).k;

// Precarga del equipo: con archivo = «Del documento del equipo»; sin archivo = «Cargado por el equipo».
await admin('POST', '/a/precarga', { proceso_id: proc.contratos, puntos: [
  { punto: 'objetivo', texto: 'Asegurar que todo contrato con proveedores se revise, firme y archive antes de iniciar el servicio.', archivos: ['procedimiento-contratos.pdf'] },
  { punto: 'actividades', texto: '1) Solicitud del área. 2) Revisión legal (3 días). 3) Firma del gerente. 4) Archivo en el repositorio. Se ejecuta por cada contrato nuevo.', archivos: ['procedimiento-contratos.pdf'] },
  { punto: 'sistemas', texto: 'SAP (registro del proveedor) y SharePoint (repositorio de contratos).', archivos: ['procedimiento-contratos.pdf'] },
  { punto: 'terceros', texto: 'Proveedores y notarías.' },
  { punto: 'documentacion', texto: 'Procedimiento de contratos, formato de solicitud y contrato firmado.' }] });
await admin('POST', '/a/precarga', { proceso_id: proc.accesos, puntos: [
  { punto: 'objetivo', texto: 'Garantizar que cada persona tenga solo los accesos que su cargo requiere.', archivos: ['politica-accesos.docx'] },
  { punto: 'sistemas', texto: 'Active Directory y la mesa de ayuda.', archivos: ['politica-accesos.docx'] }] });
// Marta ya revisó el objetivo de «Control de accesos»: para Carla debe aparecer validado.
await http('POST', '/r/campo', { k: k_marta, proceso_id: proc.accesos, punto: 'objetivo', validado: true });
// Un campo editado por la consola, en un proceso sin precarga.
await admin('POST', '/a/matriz', { proceso_id: proc.incidentes, matriz: { kpis: 'Incidentes cerrados en menos de 5 días.' } });

const base = arg('--origen') || ORIGEN;
console.log('\nListo. Campaña «' + NOMBRE + '» (ficticia):');
console.log('  Consola (admin):  ' + base + '/admin.html   código: ' + ADMIN + '   (abre la campaña «' + NOMBRE + '» → Historial de cambios de la matriz)');
const enlace = sec => base + '/index.html?c=' + codigo + '&g=' + encodeURIComponent(G) + '&s=' + encodeURIComponent(sec);
console.log('  Enlace de la sección «' + S + '» (Carla y Marta): ' + enlace(S));
console.log('    Carla Prueba: elige su nombre y crea un PIN de 4 dígitos en el primer ingreso (ej. 1111)');
console.log('    Marta Prueba: PIN ' + PIN_MARTA + ' (ya validó un punto de «Control de accesos»)');
console.log('  Enlace de la sección «' + OTRA + '» (Pedro, no debe ver nada precargado): ' + enlace(OTRA));
console.log('    Pedro Prueba: crea su PIN en el primer ingreso');

// ---- Documento clasificado: la confirmación lanza la extracción (HU02 → precarga). En local no hay IA, así que el par queda «con error»
// (Reintentar) y para ver la revisión se dejan borradores ya extraídos en «Registro de incidentes».
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(API)) {
  const pdf = new TextEncoder().encode('%PDF-1.4\n% documento de prueba de la HU03\n');
  const subida = await fetch(API + `/a/documentos?campana_id=${cid}&gerencia=${encodeURIComponent(G)}&nombre=${encodeURIComponent('procedimiento-incidentes.pdf')}`,
    { method: 'POST', headers: { origin: ORIGEN, 'x-admin-code': ADMIN, 'content-type': 'application/pdf' }, body: pdf }).then(r => r.json());
  if (!subida.ok) throw new Error('No se pudo subir el documento de prueba: ' + (subida.error || ''));
  const doc = subida.documento.id;
  await admin('POST', '/a/documentos/procesos', { id: doc, procesos: [proc.incidentes, proc.contratos] });
  await new Promise(r => setTimeout(r, 1500));   // deja terminar la extracción en segundo plano (sin IA local, termina en error)
  const t = new Date().toISOString(), q = x => "'" + String(x).replace(/'/g, "''") + "'";
  const fila = (punto, bloque, texto, cita) => `INSERT OR REPLACE INTO precarga_borrador (id, campana_id, proceso_id, documento_id, punto, bloque, texto, cita, estado, editado, creado, actualizado) VALUES (${q('bor-' + punto)}, ${q(cid)}, ${q(proc.incidentes)}, ${q(doc)}, ${q(punto)}, ${q(bloque)}, ${q(texto)}, ${q(cita)}, 'borrador', 0, ${q(t)}, ${q(t)});`;
  const sql = [
    fila('objetivo', 'b1', 'Registrar y cerrar los incidentes de cumplimiento dentro del plazo definido.', 'Objetivo: registrar y cerrar los incidentes de cumplimiento'),
    fila('actividades', 'b1', '1) Registro del incidente. 2) Análisis de causa. 3) Plan de acción. 4) Cierre. Se ejecuta ante cada incidente.', 'El incidente se registra, se analiza su causa, se define un plan de acción y se cierra'),
    fila('sistemas', 'b2', 'Herramienta de tickets de la mesa de ayuda.', 'Los incidentes se registran en la herramienta de tickets'),
    `INSERT OR REPLACE INTO documento_extracciones (documento_id, proceso_id, estado, mensaje, puntos, descartados, motivo, actualizado) VALUES (${q(doc)}, ${q(proc.incidentes)}, 'ok', '', 3, 0, '', ${q(t)});`
  ].join('\n');
  const archivo = join(mkdtempSync(join(tmpdir(), 'hu03-')), 'borradores.sql');
  writeFileSync(archivo, sql);
  try {
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'voz-relevamiento', '--local', '-c', 'wrangler.local.toml', '--file=' + archivo], { cwd: join(aqui, '..'), stdio: 'ignore', shell: true });
    console.log('  Documento «procedimiento-incidentes.pdf»: «Registro de incidentes» tiene 3 borradores por revisar; «Gestión de contratos» quedó con la extracción en error (sin IA local) → Reintentar.');
  } catch (e) { console.log('  (No se pudieron dejar los borradores de prueba: ' + e.message + ')'); }
}
