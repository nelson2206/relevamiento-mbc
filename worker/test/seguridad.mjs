// Pruebas de permisos y entradas inválidas del flujo del Gerente y de la carga con esqueleto.
//   node test/seguridad.mjs      → contra http://127.0.0.1:8787 (npm run dev); crea campañas temporales y las borra
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : ''; };
const API = arg('--api') || 'http://127.0.0.1:8787', ORIGEN = arg('--origen') || 'http://localhost:8080';
const ADMIN = process.env.ADMIN_CODE || (() => { try { return /^ADMIN_CODE=(.*)$/m.exec(readFileSync(join(aqui, '..', '.dev.vars'), 'utf8'))[1].trim(); } catch (e) { return ''; } })();
if (!ADMIN) { console.error('Falta ADMIN_CODE'); process.exit(2); }
const http = async (m, r, c, cab, crudo) => {
  const x = await fetch(API + r, { method: m, headers: Object.assign({ origin: ORIGEN, 'content-type': 'application/json' }, cab || {}), body: crudo !== undefined ? crudo : c ? JSON.stringify(c) : undefined });
  return Object.assign({ status: x.status }, await x.json().catch(() => ({})));
};
const admin = (m, r, c) => http(m, r, c, { 'x-admin-code': ADMIN });
const como = k => (m, r, c, crudo) => http(m, r, c, { 'x-client-code': k }, crudo);
let fallas = 0, n = 0;
const ok = (c, t, extra) => { n++; if (c) console.log('  ok   ' + t); else { fallas++; console.log('  FALLA ' + t + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); } };

const suf = Date.now().toString(36), creadas = [];
let contador = 0;
async function campana(nombre, gerencia) {
  const id = (await admin('POST', '/a/campana', { nombre: nombre + suf, cliente: 'C' })).id; creadas.push([id, nombre + suf]);
  const clave = 'Acceso' + suf + (++contador) + 'x9';   // no puede contener el nombre de la campaña
  await admin('POST', '/a/campana/cliente', { campana_id: id, accion: 'definir', codigo: clave });
  const p = (await admin('POST', '/a/proceso', { campana_id: id, gerencia, seccion: 'S1', proceso: 'Proceso ' + gerencia })).id;
  const sup = await admin('POST', '/a/usuario', { campana_id: id, nombre: 'Gerente ' + gerencia, gerencia, seccion: 'S1', perfil: 'gerente' });
  return { id, p, clave, dueno: como(clave), gerente: como(sup.clave), supId: sup.supervisor_id, claveSup: sup.clave };
}
try {
  const A = await campana('Alfa', 'GerA'), B = await campana('Beta', 'GerB');
  const pOtra = (await admin('POST', '/a/proceso', { campana_id: A.id, gerencia: 'GerOtra', seccion: 'S9', proceso: 'Ajeno' })).id;

  console.log('Autenticación');
  ok((await http('GET', '/c/flujo', null, { 'x-admin-code': ADMIN })).status === 401, 'el código de administración no abre el flujo del Gerente');
  ok((await http('GET', '/c/flujo')).status === 401, 'sin clave no hay flujo');
  ok((await como('clave-falsa-123')('GET', '/c/flujo')).status === 401, 'una clave inventada no entra');
  ok((await http('GET', '/a/campana/flujo?id=' + A.id, null, { 'x-client-code': A.claveSup })).status === 401, 'un Gerente no entra a las rutas de administración');
  ok((await http('POST', '/a/flujo/reabrir', { campana_id: A.id, supervisor_id: A.supId, motivo: 'intento' }, { 'x-client-code': A.claveSup })).status === 401, 'un Gerente no puede reabrir su propia aprobación');
  const fB = await B.gerente('GET', '/c/flujo');
  ok(fB.ok && fB.procesos.every(p => p.id !== A.p), 'el Gerente de otra campaña no ve procesos ajenos', fB.error || fB.status);

  console.log('Alcance');
  ok((await A.gerente('POST', '/c/flujo/proceso', { accion: 'quitar', proceso_id: pOtra })).status === 404, 'no quita un proceso fuera de su alcance');
  ok((await A.gerente('POST', '/c/flujo/proceso', { accion: 'quitar', proceso_id: B.p })).status === 404, 'no quita un proceso de otra campaña');
  ok((await A.gerente('POST', '/c/flujo/proceso', { accion: 'incorporar', proceso_ids: [B.p] })).status === 404, 'no incorpora un proceso de otra campaña');
  ok((await A.gerente('POST', '/c/flujo/proceso', { accion: 'incorporar', proceso_ids: ['no-existe'] })).status === 404, 'no incorpora un id inexistente');
  ok((await A.gerente('POST', '/c/flujo/proceso', { accion: 'incorporar', proceso_ids: [] })).status === 400, 'incorporar sin elegir nada es un error claro');
  ok((await A.gerente('POST', '/c/flujo/proceso', { accion: 'incorporar' })).status === 400, 'incorporar sin lista tampoco rompe');
  const catalogo = await A.gerente('GET', '/c/flujo/catalogo');
  ok(!JSON.stringify(catalogo).includes('Proceso GerB'), 'el catálogo no filtra procesos de otras campañas');
  ok((await A.gerente('POST', '/c/flujo/proceso', { accion: 'agregar', gerencia: 'GerOtra', seccion: 'S404', proceso: 'Colado' })).status === 400, 'no crea procesos en una sección que no existe en la campaña');
  const persona = (await admin('POST', '/a/encuestado', { campana_id: B.id, personas: [{ nombre: 'Persona de Beta', gerencia: 'GerB', seccion: 'S1' }] })).nuevos[0].id;
  ok((await A.gerente('POST', '/c/asignar', { encuestado_id: persona, agregar: [A.p] })).status === 404, 'no asigna a una persona de otra campaña');
  const personaOtra = (await admin('POST', '/a/encuestado', { campana_id: A.id, personas: [{ nombre: 'Persona Ajena', gerencia: 'GerOtra', seccion: 'S9' }] })).nuevos[0].id;
  ok((await A.gerente('POST', '/c/asignar', { encuestado_id: personaOtra, agregar: [A.p] })).status === 404, 'no asigna a una persona fuera de su alcance');
  ok((await A.gerente('POST', '/c/personas', { personas: [{ nombre: 'Intruso Nuevo', gerencia: 'GerOtra', seccion: 'S9' }] })).status === 403, 'no crea personas en secciones ajenas');

  console.log('Entradas inválidas');
  for (const [paso, esperado] of [['abc', 400], [0, 400], [5, 400], [1.5, 400], [null, 400], [undefined, 400]]) {
    ok((await A.gerente('POST', '/c/flujo/confirmar', { paso })).status === esperado, 'confirmar con paso ' + JSON.stringify(paso) + ' → ' + esperado);
  }
  ok((await A.gerente('POST', '/c/flujo/confirmar', null, 'esto no es json')).status === 400, 'cuerpo que no es JSON → 400, no 500');
  ok((await A.gerente('POST', '/c/flujo/proceso', { accion: 'borrar-todo' })).status === 400, 'acción desconocida → 400');
  ok((await A.gerente('POST', '/c/flujo/proceso', { accion: 'agregar', gerencia: 'GerA', seccion: 'S1', proceso: '  ' })).status === 400, 'proceso sin nombre → 400');
  const largo = await A.gerente('POST', '/c/flujo/proceso', { accion: 'agregar', gerencia: 'GerA', seccion: 'S1', proceso: 'x'.repeat(5000), descripcion: 'y'.repeat(9000) });
  ok(largo.ok, 'nombres enormes se aceptan recortados');
  const fl = await A.gerente('GET', '/c/flujo');
  const guardado = fl.procesos.find(p => p.id === largo.id);
  ok(guardado && guardado.proceso.length <= 200 && guardado.descripcion.length <= 1500, 'quedan recortados a 200 y 1500 caracteres', guardado && [guardado.proceso.length, guardado.descripcion.length]);
  const html = await A.gerente('POST', '/c/flujo/proceso', { accion: 'agregar', gerencia: 'GerA', seccion: 'S1', proceso: '<img src=x onerror=alert(1)>' });
  ok(html.ok, 'un nombre con HTML se guarda como texto (la pantalla lo escapa)');
  ok((await A.gerente('POST', '/c/flujo/confirmar', { paso: 4, confirmar_final: 'true' })).status !== 200, 'confirmar_final como texto no vale');
  ok((await A.gerente('POST', '/c/flujo/proceso', { accion: 'quitar', proceso_id: A.p, forzar: 'true' })).status !== 500, 'forzar como texto no rompe');

  console.log('Carga con esqueleto: entradas raras');
  const importar = (c, crudo) => admin('POST', '/a/importar', Object.assign({ campana_id: A.id, modo: 'agregar' }, c));
  ok((await importar({ estructura: [null, 5, 'texto', { gerencia: 'G', seccion: 'S' }] })).status < 500, 'filas nulas o de otro tipo en la hoja no dan error 500', (await importar({ estructura: [null] })).status);
  ok((await importar({ estructura: 'no es lista' })).status < 500, 'una hoja que no es lista se ignora');
  ok((await importar({ estructura: Array.from({ length: 2001 }, (_, i) => ({ gerencia: 'G' + i, seccion: 'S' })) })).status === 413, 'más de 2000 filas → 413');
  ok((await importar({ estructura: [{ area: 12, gerencia: 345, seccion: true }] })).status < 500, 'números y booleanos en la hoja no rompen');
  ok((await importar({ procesos: [null] })).status < 500, 'filas nulas en procesos no dan 500', (await importar({ procesos: [null] })).status);
  ok((await importar({ encuestados: [null] })).status < 500, 'filas nulas en encuestados no dan 500', (await importar({ encuestados: [null] })).status);
  ok((await admin('POST', '/a/importar', { campana_id: 'no-existe', estructura: [] })).status === 404, 'campaña inexistente → 404');
  const colision = await importar({ estructura: [{ area: 'X', gerencia: "Ger'; DROP TABLE procesos;--", seccion: 'S' }] });
  ok(colision.ok && (await admin('GET', '/a/campana?id=' + A.id)).procesos.length > 0, 'texto con comillas SQL se guarda como texto (consultas parametrizadas)');
} finally {
  for (const [id, nombre] of creadas) await admin('POST', '/a/borrar-campana', { campana_id: id, confirmar: nombre });
}
console.log('\n' + (n - fallas) + ' de ' + n + ' comprobaciones correctas' + (fallas ? ' · ' + fallas + ' con falla' : ''));
process.exit(fallas ? 1 : 0);
