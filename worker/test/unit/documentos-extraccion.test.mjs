// Confirmar el proceso de un documento lanza la extracción de la precarga y deja borradores para el administrador;
// aprobar los lleva a la precarga y a la matriz; los borrados no dejan rastro huérfano.
// La IA se reemplaza por una función falsa y R2 por un mapa en memoria.   node --test test/unit/documentos-extraccion.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/index.js';
import { rutaDocumentoProcesos, rutaDocumentoExtraer } from '../../src/documentos.js';
import { crearD1 } from './d1-memoria.mjs';

const ORIGEN = 'http://prueba.local', ADMIN = 'admin-de-prueba-123';
const { d1, db } = crearD1();
const almacen = new Map();
const DOCS = {
  put: async (k, v) => { almacen.set(k, v); },
  get: async k => (almacen.has(k) ? { body: almacen.get(k), arrayBuffer: async () => almacen.get(k) } : null),
  list: async ({ prefix }) => ({ objects: [...almacen.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })), truncated: false }),
  delete: async claves => { [].concat(claves).forEach(k => almacen.delete(k)); }
};
const env = { DB: d1, DOCS, ALLOWED_ORIGINS: ORIGEN, ADMIN_CODE: ADMIN };
const H = { origin: ORIGEN, 'x-admin-code': ADMIN, 'cf-connecting-ip': '10.0.0.5' };

async function llamar(metodo, ruta, cuerpo, tipo = 'application/json') {
  const bytes = cuerpo instanceof Uint8Array;
  const r = await worker.fetch(new Request('http://worker.local' + ruta, {
    method: metodo, body: cuerpo ? (bytes ? cuerpo : JSON.stringify(cuerpo)) : undefined, headers: { ...H, 'content-type': tipo }
  }), env, { waitUntil() {} });
  return { status: r.status, ...(await r.json()) };
}
const pdf = txt => new TextEncoder().encode('%PDF-1.4\n' + txt);
const subir = nombre => llamar('POST', `/a/documentos?campana_id=c1&gerencia=Legal&nombre=${encodeURIComponent(nombre)}`, pdf(nombre), 'application/pdf');
const ctxCaptura = () => { const ps = []; return { ctx: { waitUntil: p => ps.push(p) }, listo: () => Promise.all(ps) }; };
const filas = (sql, ...a) => db.prepare(sql).all(...a);
const uno = (sql, ...a) => db.prepare(sql).get(...a);

// IA falsa: devuelve lo que se le indique y cuenta las llamadas.
let llamadas = [], respuesta = null, falla = null;
const extraerPrecarga = async (e, ctx, archivo, p) => {
  llamadas.push(p.id);
  if (falla) throw new Error(falla);
  return respuesta;
};
const deps = { extraerPrecarga };
const lectura = (...puntos) => ({ puntos: puntos.map(([id, texto]) => ({ id, bloque: id === 'sistemas' || id === 'terceros' ? 'b2' : 'b1', texto, cita: 'cita de ' + id })), descartados: 1, motivo: '' });

let doc;
test('preparación: campaña, 12 procesos y un documento', async () => {
  db.prepare("INSERT INTO campanas (id, nombre, cliente, creada) VALUES ('c1','Prueba','Toyota',?)").run(new Date().toISOString());
  for (let i = 1; i <= 12; i++) db.prepare("INSERT INTO procesos (id, campana_id, gerencia, seccion, proceso) VALUES (?, 'c1', 'Legal', 'Contratos', ?)").run('p' + i, 'Proceso ' + i);
  const r = await subir('procedimiento.pdf');
  assert.equal(r.status, 200, JSON.stringify(r));
  doc = r.documento;
});

test('confirmar lanza la extracción en segundo plano: el par queda «pendiente» y luego «ok» con sus borradores', async () => {
  respuesta = lectura(['objetivo', 'Gestionar contratos'], ['sistemas', 'SAP y SharePoint']);
  const { ctx, listo } = ctxCaptura();
  const r = await rutaDocumentoProcesos(env, { id: doc.id, procesos: ['p1', 'p2'] }, ctx, deps);
  assert.equal(r.documento.estado, 'clasificado');
  assert.deepEqual(r.documento.procesos.map(p => p.extraccion && p.extraccion.estado).sort(), ['pendiente', 'pendiente']);
  await listo();
  assert.deepEqual(llamadas.sort(), ['p1', 'p2']);
  assert.equal(filas("SELECT * FROM precarga_borrador WHERE estado='borrador'").length, 4);
  const e = uno("SELECT * FROM documento_extracciones WHERE proceso_id='p1'");
  assert.equal(e.estado, 'ok'); assert.equal(e.puntos, 2); assert.equal(e.descartados, 1);
  assert.equal(filas("SELECT * FROM acciones WHERE accion='documento_precarga'").length, 2);
});

test('el borrador no llega a la precarga, a la matriz ni a la encuesta hasta que se aprueba', () => {
  assert.equal(uno('SELECT COUNT(*) n FROM precarga').n, 0);
  assert.equal(uno("SELECT matriz FROM procesos WHERE id='p1'").matriz, '{}');
  assert.equal(uno('SELECT COUNT(*) n FROM matriz_historial').n, 0);
});

test('reconfirmar la misma lista no vuelve a leer el documento', async () => {
  llamadas = [];
  const { ctx, listo } = ctxCaptura();
  await rutaDocumentoProcesos(env, { id: doc.id, procesos: ['p1', 'p2'] }, ctx, deps);
  await listo();
  assert.equal(llamadas.length, 0);
});

test('si la IA falla, el documento sigue clasificado y el par queda en error con su motivo y su auditoría', async () => {
  falla = 'caída de la IA';
  const { ctx, listo } = ctxCaptura();
  const r = await rutaDocumentoProcesos(env, { id: doc.id, procesos: ['p1', 'p2', 'p3'] }, ctx, deps);
  assert.equal(r.documento.estado, 'clasificado');
  await listo();
  const e = uno("SELECT * FROM documento_extracciones WHERE proceso_id='p3'");
  assert.equal(e.estado, 'error'); assert.match(e.mensaje, /caída de la IA/);
  assert.equal(uno("SELECT COUNT(*) n FROM acciones WHERE accion='documento_precarga_error'").n, 1);
  assert.equal(uno("SELECT estado FROM documento_extracciones WHERE proceso_id='p1'").estado, 'ok', 'lo que ya estaba bien no se toca');
});

test('Reextraer: reintenta el par con error; lo corregido por el administrador no se pisa y lo que ya no aparece se descarta', async () => {
  falla = null; llamadas = [];
  db.prepare("UPDATE precarga_borrador SET editado=1, texto='Mi corrección' WHERE proceso_id='p1' AND punto='objetivo'").run();
  respuesta = lectura(['objetivo', 'Otro objetivo del documento'], ['terceros', 'Notarías']);
  let c = ctxCaptura();
  await rutaDocumentoExtraer(env, { id: doc.id, proceso_id: 'p1' }, c.ctx, deps);
  await c.listo();
  assert.equal(uno("SELECT texto FROM precarga_borrador WHERE proceso_id='p1' AND punto='objetivo'").texto, 'Mi corrección');
  assert.equal(uno("SELECT estado FROM precarga_borrador WHERE proceso_id='p1' AND punto='sistemas'").estado, 'descartado');
  assert.equal(uno("SELECT estado FROM precarga_borrador WHERE proceso_id='p1' AND punto='terceros'").estado, 'borrador');
  c = ctxCaptura();
  await rutaDocumentoExtraer(env, { id: doc.id, proceso_id: 'p3' }, c.ctx, deps);
  await c.listo();
  assert.equal(uno("SELECT estado FROM documento_extracciones WHERE proceso_id='p3'").estado, 'ok');
  await assert.rejects(() => rutaDocumentoExtraer(env, { id: doc.id, proceso_id: 'p9' }, ctxCaptura().ctx, deps), /Confirma primero/);
});

test('quitar un proceso del documento descarta sus borradores y su estado; la lista vacía lo devuelve a Pendiente', async () => {
  const { ctx, listo } = ctxCaptura();
  await rutaDocumentoProcesos(env, { id: doc.id, procesos: ['p1', 'p3'] }, ctx, deps);
  await listo();
  assert.equal(filas("SELECT * FROM precarga_borrador WHERE proceso_id='p2' AND estado='borrador'").length, 0);
  assert.equal(filas("SELECT * FROM documento_extracciones WHERE proceso_id='p2'").length, 0);
  const vacio = await rutaDocumentoProcesos(env, { id: doc.id, procesos: [] }, ctxCaptura().ctx, deps);
  assert.equal(vacio.documento.estado, 'pendiente');
  assert.equal(filas("SELECT * FROM precarga_borrador WHERE estado='borrador'").length, 0);
});

test('aprobar un borrador (con el texto corregido) lo lleva a la precarga y a la matriz con historial; descartar solo lo cierra', async () => {
  const { ctx, listo } = ctxCaptura();
  respuesta = lectura(['objetivo', 'Gestionar contratos'], ['terceros', 'Notarías'], ['kpis', 'Contratos vencidos']);
  falla = null;
  await rutaDocumentoProcesos(env, { id: doc.id, procesos: ['p4'] }, ctx, deps);
  await listo();
  const b = filas("SELECT id, punto FROM precarga_borrador WHERE proceso_id='p4' AND estado='borrador'");
  assert.equal(b.length, 3);
  const id = p => b.find(x => x.punto === p).id;
  const r = await llamar('POST', '/a/precarga/borrador', { proceso_id: 'p4', decisiones: [
    { id: id('objetivo'), accion: 'aprobar', texto: 'Administrar los contratos del área' },
    { id: id('terceros'), accion: 'aprobar' },
    { id: id('kpis'), accion: 'descartar' }
  ] });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.escritos.length, 2); assert.equal(r.bloqueados.length, 0); assert.equal(r.pendientes, 0);
  assert.equal(uno("SELECT texto, archivos FROM precarga WHERE proceso_id='p4' AND punto='objetivo'").texto, 'Administrar los contratos del área');
  assert.deepEqual(JSON.parse(uno("SELECT archivos FROM precarga WHERE proceso_id='p4' AND punto='terceros'").archivos), ['procedimiento.pdf']);
  assert.equal(JSON.parse(uno("SELECT matriz FROM procesos WHERE id='p4'").matriz).objetivo, 'Administrar los contratos del área');
  const h = filas("SELECT * FROM matriz_historial WHERE proceso_id='p4' ORDER BY campo");
  assert.deepEqual(h.map(x => x.origen), ['documento', 'documento']);
  assert.equal(uno("SELECT editado FROM precarga_borrador WHERE id=?", id('objetivo')).editado, 1);
  assert.equal(uno("SELECT estado FROM precarga_borrador WHERE id=?", id('kpis')).estado, 'descartado');
  assert.equal(filas("SELECT * FROM precarga WHERE proceso_id='p4' AND punto='kpis'").length, 0);
  // Resolver dos veces el mismo borrador no hace nada.
  assert.equal((await llamar('POST', '/a/precarga/borrador', { proceso_id: 'p4', decisiones: [{ id: id('objetivo'), accion: 'aprobar' }] })).status, 400);
});

test('aprobar avisa qué puntos quedaron bloqueados porque una persona ya escribió ese campo', async () => {
  await llamar('POST', '/a/matriz', { proceso_id: 'p5', matriz: { objetivo: 'Texto escrito por el equipo' } });
  respuesta = lectura(['objetivo', 'Del documento'], ['terceros', 'Notarías']);
  const { ctx, listo } = ctxCaptura();
  await rutaDocumentoProcesos(env, { id: doc.id, procesos: ['p5'] }, ctx, deps);
  await listo();
  const b = filas("SELECT id FROM precarga_borrador WHERE proceso_id='p5' AND estado='borrador'");
  const r = await llamar('POST', '/a/precarga/borrador', { proceso_id: 'p5', decisiones: b.map(x => ({ id: x.id, accion: 'aprobar' })) });
  assert.deepEqual(r.bloqueados.map(x => x.punto), ['objetivo']);
  assert.equal(JSON.parse(uno("SELECT matriz FROM procesos WHERE id='p5'").matriz).objetivo, 'Texto escrito por el equipo');
});

test('con más procesos que el máximo por confirmación, el resto queda para extraer a pedido', async () => {
  llamadas = []; respuesta = lectura(['objetivo', 'x']);
  const d2 = (await subir('segundo.pdf')).documento;
  const { ctx, listo } = ctxCaptura();
  const todos = Array.from({ length: 10 }, (_, i) => 'p' + (i + 1));
  await rutaDocumentoProcesos(env, { id: d2.id, procesos: todos }, ctx, deps);
  await listo();
  assert.equal(llamadas.length, 8);
  const err = filas("SELECT * FROM documento_extracciones WHERE documento_id=? AND estado='error'", d2.id);
  assert.equal(err.length, 2); assert.match(err[0].mensaje, /Extraer/);
});

test('sin la IA configurada, confirmar por HTTP funciona y el par queda en error (la confirmación no depende de la IA)', async () => {
  const d3 = (await subir('tercero.pdf')).documento;
  const r = await llamar('POST', '/a/documentos/procesos', { id: d3.id, procesos: ['p6'] });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.documento.estado, 'clasificado');
});

test('la consola recibe los borradores y el estado de extracción de la campaña', async () => {
  const c = await llamar('GET', '/a/campana?id=c1');
  assert.ok(Array.isArray(c.precarga_borrador) && Array.isArray(c.extracciones));
  assert.ok(c.extracciones.some(x => x.estado === 'ok'));
});

test('borrar un proceso limpia sus asociaciones, borradores, estado e historial, y devuelve a Pendiente al documento que se queda sin procesos', async () => {
  const d4 = (await subir('cuarto.pdf')).documento;
  respuesta = lectura(['objetivo', 'Algo']);
  const { ctx, listo } = ctxCaptura();
  await rutaDocumentoProcesos(env, { id: d4.id, procesos: ['p11'] }, ctx, deps);
  await listo();
  await llamar('POST', '/a/matriz', { proceso_id: 'p11', matriz: { kpis: 'Indicador' } });
  assert.equal(uno("SELECT estado FROM documentos WHERE id=?", d4.id).estado, 'clasificado');
  const r = await llamar('POST', '/a/proceso/borrar', { proceso_id: 'p11' });
  assert.equal(r.status, 200, JSON.stringify(r));
  for (const t of ['documento_procesos', 'documento_extracciones', 'precarga_borrador', 'matriz_historial']) assert.equal(uno(`SELECT COUNT(*) n FROM ${t} WHERE proceso_id='p11'`).n, 0, t);
  assert.equal(uno('SELECT estado FROM documentos WHERE id=?', d4.id).estado, 'pendiente');
  const lista = await llamar('GET', '/a/documentos?campana_id=c1');
  assert.ok(lista.documentos.every(x => x.procesos.every(p => p.nombre && p.nombre !== 'undefined')));
});

test('borrar la campaña elimina sus documentos, sus filas relacionadas y sus archivos de R2', async () => {
  assert.ok([...almacen.keys()].some(k => k.startsWith('c1/')));
  const r = await llamar('POST', '/a/borrar-campana', { campana_id: 'c1', confirmar: 'Prueba' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal([...almacen.keys()].length, 0);
  for (const t of ['documentos', 'documento_procesos', 'documento_extracciones', 'precarga_borrador', 'matriz_historial', 'procesos']) assert.equal(uno(`SELECT COUNT(*) n FROM ${t}`).n, 0, t);
});
