// Ambiente de prueba del recorrido «documento → proceso precargado → persona que llena la encuesta». Empresa FICTICIA.
//   node test/semilla-journey.mjs                  → contra http://127.0.0.1:8787 (npm run dev); borra y vuelve a crear la campaña
//
// Deja UN proceso, «Gestión de contratos», alimentado de un documento por el camino real:
//   documento cargado → clasificado en el proceso → borradores extraídos → el administrador aprueba 5 → pasan a la matriz.
// Un sexto borrador (indicadores) queda SIN aprobar para ver la revisión del administrador; la persona no lo ve.
// La IA no corre en local: los borradores se insertan ya extraídos (lo único simulado); el resto usa las rutas reales.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const API = 'http://127.0.0.1:8787', ORIGEN = 'http://localhost:8080';
const ADMIN = process.env.ADMIN_CODE || (() => { try { return /^ADMIN_CODE=(.*)$/m.exec(readFileSync(join(aqui, '..', '.dev.vars'), 'utf8'))[1].trim(); } catch (e) { return ''; } })();
if (!ADMIN) { console.error('Falta ADMIN_CODE (variable de entorno o worker/.dev.vars)'); process.exit(2); }

const NOMBRE = 'Demo recorrido de llenado', G = 'Cumplimiento', S = 'Contratos', PIN = '1111';
async function http(metodo, ruta, cuerpo, cab, crudo) {
  const r = await fetch(API + ruta, { method: metodo, headers: Object.assign({ origin: ORIGEN, 'content-type': 'application/json' }, cab || {}), body: crudo || (cuerpo ? JSON.stringify(cuerpo) : undefined) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(metodo + ' ' + ruta + ' → ' + r.status + ' ' + (j.error || ''));
  return j;
}
const admin = (m, r, c) => http(m, r, c, { 'x-admin-code': ADMIN });

console.log('Recreando la campaña «' + NOMBRE + '»…');
for (const c of (await admin('GET', '/a/campanas')).campanas.filter(x => x.nombre === NOMBRE)) await admin('POST', '/a/borrar-campana', { campana_id: c.id, confirmar: NOMBRE });
const cid = (await admin('POST', '/a/campana', { nombre: NOMBRE, cliente: 'Empresa Demo (ficticia)' })).id;
await admin('POST', '/a/importar', { campana_id: cid, modo: 'agregar', estructura: [{ area: 'Soporte', gerencia: G, seccion: S }] });
const pid = (await admin('POST', '/a/proceso', { campana_id: cid, gerencia: G, seccion: S, macroproceso: 'Cumplimiento', proceso: 'Gestión de contratos',
  descripcion: 'Alta, revisión legal, firma y seguimiento de contratos con proveedores.', codigo: 'CUM-CON-01' })).id;
await admin('POST', '/a/encuestado', { campana_id: cid, personas: [{ nombre: 'Carla Prueba', gerencia: G, seccion: S }] });
const enlace = (await admin('POST', '/a/enlace', { campana_id: cid, abierta: true })).codigo_publico;

// 1. El administrador carga el documento y lo clasifica en el proceso (ruta real; la lectura por IA falla en local y queda «con error»).
const pdf = new TextEncoder().encode('%PDF-1.4\n% procedimiento de contratos (documento de prueba)\n');
const doc = (await http('POST', `/a/documentos?campana_id=${cid}&gerencia=${encodeURIComponent(G)}&nombre=${encodeURIComponent('procedimiento-contratos.pdf')}`, null,
  { 'x-admin-code': ADMIN, 'content-type': 'application/pdf' }, pdf)).documento.id;
await admin('POST', '/a/documentos/procesos', { id: doc, procesos: [pid] });
await new Promise(r => setTimeout(r, 1500));

// 2. Lo que la IA habría extraído, como borradores con su cita (simulado: solo esto).
const t = new Date().toISOString(), q = x => "'" + String(x).replace(/'/g, "''") + "'";
const BORRADORES = [
  ['objetivo', 'b1', 'Asegurar que todo contrato con proveedores se revise, firme y archive antes de iniciar el servicio.', 'Todo contrato debe revisarse, firmarse y archivarse antes de iniciar el servicio'],
  ['actividades', 'b1', '1) Solicitud del área. 2) Revisión legal (3 días hábiles). 3) Firma del gerente. 4) Archivo en el repositorio. Se ejecuta por cada contrato nuevo.', 'Solicitud del área, revisión legal en 3 días hábiles, firma del gerente y archivo en el repositorio'],
  ['sistemas', 'b2', 'SAP (registro del proveedor) y SharePoint (repositorio de contratos).', 'El proveedor se registra en SAP y el contrato se archiva en SharePoint'],
  ['terceros', 'b2', 'Proveedores y notarías.', 'Intervienen el proveedor y la notaría'],
  ['documentacion', 'b3', 'Procedimiento de contratos, formato de solicitud y contrato firmado.', 'Documentos: procedimiento, formato de solicitud y contrato firmado'],
  ['kpis', 'b3', 'Contratos firmados dentro del plazo.', 'Indicador: contratos firmados dentro del plazo']
];
const sql = BORRADORES.map(([punto, bloque, texto, cita]) => `INSERT OR REPLACE INTO precarga_borrador (id, campana_id, proceso_id, documento_id, punto, bloque, texto, cita, estado, editado, creado, actualizado)
  VALUES (${q('bor-' + punto)}, ${q(cid)}, ${q(pid)}, ${q(doc)}, ${q(punto)}, ${q(bloque)}, ${q(texto)}, ${q(cita)}, 'borrador', 0, ${q(t)}, ${q(t)});`).join('\n') +
  `\nINSERT OR REPLACE INTO documento_extracciones (documento_id, proceso_id, estado, mensaje, puntos, descartados, motivo, actualizado) VALUES (${q(doc)}, ${q(pid)}, 'ok', '', ${BORRADORES.length}, 0, '', ${q(t)});`;
const archivo = join(mkdtempSync(join(tmpdir(), 'journey-')), 'borradores.sql');
writeFileSync(archivo, sql);
execFileSync('npx wrangler d1 execute voz-relevamiento --local -c wrangler.local.toml --file="' + archivo + '"', { cwd: join(aqui, '..'), stdio: 'ignore', shell: true });

// 3. El administrador aprueba cinco (ruta real): pasan a la precarga y a la matriz, con historial. El de indicadores queda pendiente.
const aprobar = BORRADORES.filter(b => b[0] !== 'kpis').map(b => ({ id: 'bor-' + b[0], accion: 'aprobar' }));
const r = await admin('POST', '/a/precarga/borrador', { proceso_id: pid, decisiones: aprobar });

// 4. La persona entra por el enlace de la sección con su nombre y su PIN (se crea aquí para que no tengas que inventarlo).
const personas = (await http('GET', `/r/abierta?c=${enlace}&g=${encodeURIComponent(G)}&s=${encodeURIComponent(S)}`)).seccion.responsables;
const carla = personas.find(x => x.nombre === 'Carla Prueba');
await http('POST', '/r/identificar', { c: enlace, id: carla.id, pin: PIN });

console.log('\nListo. Campaña «' + NOMBRE + '» (ficticia). ' + r.escritos.length + ' puntos de «Gestión de contratos» llegaron a la matriz desde el documento.');
console.log('\n  ADMINISTRADOR  ' + ORIGEN + '/admin.html   código: ' + ADMIN);
console.log('    Campaña «' + NOMBRE + '» → pestaña Documentos (procedimiento-contratos.pdf, clasificado) y Procesos → «Gestión de contratos»:');
console.log('    bloque «Borradores por revisar» (1: indicadores), historial de cambios de la matriz.');
console.log('\n  PERSONA        ' + ORIGEN + '/index.html?c=' + enlace + '&g=' + encodeURIComponent(G) + '&s=' + encodeURIComponent(S));
console.log('    Elige «Carla Prueba» · PIN ' + PIN + ' → abre «Gestión de contratos»: verá 5 resúmenes del documento, solo lectura, con «Sigue vigente».');
