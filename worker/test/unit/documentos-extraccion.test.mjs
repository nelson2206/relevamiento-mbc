// Confirmar el proceso de un documento deja el par en cola; la lectura de cada par (una solicitud por par) deja borradores para el administrador;
// aprobar los lleva a la precarga y a la matriz; los borrados no dejan rastro huérfano. HU03-b: cada par se lee y falla de forma independiente.
// La IA se reemplaza por una función falsa y R2 por un mapa en memoria.   node --test test/unit/documentos-extraccion.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/index.js';
import { rutaDocumentoProcesos, rutaDocumentoExtraer, ejecutarPar, vencerExtracciones, extraerPendientes } from '../../src/documentos.js';
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
// La consola lanza una solicitud de lectura por cada par que `por_extraer` devuelve; aquí se hacen una tras otra.
const leer = async (docId, ids, origen) => { for (const id of ids) await rutaDocumentoExtraer(env, { id: docId, proceso_id: id, origen }, null, deps); };
const confirmar = async (docId, procesos) => { const r = await rutaDocumentoProcesos(env, { id: docId, procesos }, null, deps); await leer(docId, r.por_extraer, 'confirmacion'); return r; };
const filas = (sql, ...a) => db.prepare(sql).all(...a);
const uno = (sql, ...a) => db.prepare(sql).get(...a);

// IA falsa: devuelve lo que se le indique y cuenta las llamadas.
let llamadas = [], respuesta = null, falla = null, fallaEn = null, cuelga = false;
const extraerPrecarga = async (e, ctx, archivo, p) => {
  llamadas.push(p.id);
  if (cuelga) return new Promise(() => {});   // la IA nunca responde
  if (falla && (!fallaEn || fallaEn === p.id)) throw new Error(falla);
  return respuesta;
};
const deps = { extraerPrecarga };
const lectura = (...puntos) => ({ puntos: puntos.map(([id, texto]) => ({ id, bloque: id === 'sistemas' || id === 'terceros' ? 'b2' : 'b1', texto, cita: 'cita de ' + id })), descartados: 1, motivo: '' });

let doc, doc2;
test('preparación: campaña, 12 procesos y un documento', async () => {
  db.prepare("INSERT INTO campanas (id, nombre, cliente, creada) VALUES ('c1','Prueba','Toyota',?)").run(new Date().toISOString());
  for (let i = 1; i <= 12; i++) db.prepare("INSERT INTO procesos (id, campana_id, gerencia, seccion, proceso) VALUES (?, 'c1', 'Legal', 'Contratos', ?)").run('p' + i, 'Proceso ' + i);
  const r = await subir('procedimiento.pdf');
  assert.equal(r.status, 200, JSON.stringify(r));
  doc = r.documento;
});

test('confirmar deja los pares en cola (pendiente) y la lectura de cada par los deja generados con sus borradores', async () => {
  respuesta = lectura(['objetivo', 'Gestionar contratos'], ['sistemas', 'SAP y SharePoint']);
  const r = await rutaDocumentoProcesos(env, { id: doc.id, procesos: ['p1', 'p2'] }, null, deps);
  assert.equal(r.documento.estado, 'clasificado');
  assert.deepEqual(r.documento.procesos.map(p => p.extraccion && p.extraccion.estado).sort(), ['pendiente', 'pendiente']);
  assert.deepEqual(r.por_extraer.sort(), ['p1', 'p2']);
  assert.equal(llamadas.length, 0, 'confirmar no lee nada por sí mismo');
  await leer(doc.id, r.por_extraer, 'confirmacion');
  assert.deepEqual(llamadas.sort(), ['p1', 'p2']);
  assert.equal(filas("SELECT * FROM precarga_borrador WHERE estado='borrador'").length, 4);
  const e = uno("SELECT * FROM documento_extracciones WHERE proceso_id='p1'");
  assert.equal(e.estado, 'generado'); assert.equal(e.puntos, 2); assert.equal(e.descartados, 1);
  assert.equal(filas("SELECT * FROM acciones WHERE accion='documento_precarga'").length, 2);
  const h = filas("SELECT * FROM documento_extraccion_historial WHERE documento_id=? ORDER BY proceso_id", doc.id);
  assert.deepEqual(h.map(x => [x.proceso_id, x.origen, x.resultado, x.puntos]), [['p1', 'confirmacion', 'generado', 2], ['p2', 'confirmacion', 'generado', 2]]);
  assert.ok(h.every(x => x.fin && x.solicitado_por));
});

test('el borrador no llega a la precarga, a la matriz ni a la encuesta hasta que se aprueba', () => {
  assert.equal(uno('SELECT COUNT(*) n FROM precarga').n, 0);
  assert.equal(uno("SELECT matriz FROM procesos WHERE id='p1'").matriz, '{}');
  assert.equal(uno('SELECT COUNT(*) n FROM matriz_historial').n, 0);
});

test('reconfirmar la misma lista no vuelve a leer el documento', async () => {
  llamadas = [];
  const r = await rutaDocumentoProcesos(env, { id: doc.id, procesos: ['p1', 'p2'] }, null, deps);
  assert.deepEqual(r.por_extraer, []);
  assert.equal(llamadas.length, 0);
  assert.equal(uno("SELECT estado FROM documento_extracciones WHERE proceso_id='p1'").estado, 'generado', 'los demás pares no se reprocesan');
});

test('si la IA falla, el documento sigue clasificado y el par queda en error con su motivo y su auditoría', async () => {
  falla = 'caída de la IA';
  const r = await rutaDocumentoProcesos(env, { id: doc.id, procesos: ['p1', 'p2', 'p3'] }, null, deps);
  assert.equal(r.documento.estado, 'clasificado');
  await leer(doc.id, r.por_extraer, 'confirmacion');
  const e = uno("SELECT * FROM documento_extracciones WHERE proceso_id='p3'");
  assert.equal(e.estado, 'error'); assert.match(e.mensaje, /caída de la IA/);
  assert.equal(uno("SELECT COUNT(*) n FROM acciones WHERE accion='documento_precarga_error'").n, 1);
  assert.equal(uno("SELECT estado FROM documento_extracciones WHERE proceso_id='p1'").estado, 'generado', 'lo que ya estaba bien no se toca');
});

test('Reextraer: reintenta el par con error; lo corregido por el administrador no se pisa y lo que ya no aparece se descarta', async () => {
  falla = null; llamadas = [];
  db.prepare("UPDATE precarga_borrador SET editado=1, texto='Mi corrección' WHERE proceso_id='p1' AND punto='objetivo'").run();
  respuesta = lectura(['objetivo', 'Otro objetivo del documento'], ['terceros', 'Notarías']);
  await rutaDocumentoExtraer(env, { id: doc.id, proceso_id: 'p1' }, null, deps);
  assert.equal(uno("SELECT texto FROM precarga_borrador WHERE proceso_id='p1' AND punto='objetivo'").texto, 'Mi corrección');
  assert.equal(uno("SELECT estado FROM precarga_borrador WHERE proceso_id='p1' AND punto='sistemas'").estado, 'descartado');
  assert.equal(uno("SELECT estado FROM precarga_borrador WHERE proceso_id='p1' AND punto='terceros'").estado, 'borrador');
  await rutaDocumentoExtraer(env, { id: doc.id, proceso_id: 'p3' }, null, deps);
  assert.equal(uno("SELECT estado FROM documento_extracciones WHERE proceso_id='p3'").estado, 'generado');
  await assert.rejects(() => rutaDocumentoExtraer(env, { id: doc.id, proceso_id: 'p9' }, null, deps), /Confirma primero/);
});

test('quitar un proceso del documento descarta sus borradores y su estado; la lista vacía lo devuelve a Pendiente', async () => {
  await rutaDocumentoProcesos(env, { id: doc.id, procesos: ['p1', 'p3'] }, null, deps);
  assert.equal(filas("SELECT * FROM precarga_borrador WHERE proceso_id='p2' AND estado='borrador'").length, 0);
  assert.equal(filas("SELECT * FROM documento_extracciones WHERE proceso_id='p2'").length, 0);
  assert.ok(filas("SELECT * FROM documento_extraccion_historial WHERE documento_id=? AND proceso_id='p2'", doc.id).length >= 1, 'quitar el proceso conserva su historial');
  const vacio = await rutaDocumentoProcesos(env, { id: doc.id, procesos: [] }, null, deps);
  assert.equal(vacio.documento.estado, 'pendiente');
  assert.equal(filas("SELECT * FROM precarga_borrador WHERE estado='borrador'").length, 0);
});

test('aprobar un borrador (con el texto corregido) lo lleva a la precarga y a la matriz con historial; descartar solo lo cierra', async () => {
  respuesta = lectura(['objetivo', 'Gestionar contratos'], ['terceros', 'Notarías'], ['kpis', 'Contratos vencidos']);
  falla = null;
  await confirmar(doc.id, ['p4']);
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
  await confirmar(doc.id, ['p5']);
  const b = filas("SELECT id FROM precarga_borrador WHERE proceso_id='p5' AND estado='borrador'");
  const r = await llamar('POST', '/a/precarga/borrador', { proceso_id: 'p5', decisiones: b.map(x => ({ id: x.id, accion: 'aprobar' })) });
  assert.deepEqual(r.bloqueados.map(x => x.punto), ['objetivo']);
  assert.equal(JSON.parse(uno("SELECT matriz FROM procesos WHERE id='p5'").matriz).objetivo, 'Texto escrito por el equipo');
});

test('confirmar 12 procesos: todos quedan en cola, ninguno en error, y por_extraer trae los 12 (sin el tope de 8)', async () => {
  llamadas = []; respuesta = lectura(['objetivo', 'x']);
  const d2 = (await subir('segundo.pdf')).documento;
  const todos = Array.from({ length: 12 }, (_, i) => 'p' + (i + 1));
  const r = await rutaDocumentoProcesos(env, { id: d2.id, procesos: todos }, null, deps);
  assert.deepEqual(r.por_extraer.sort(), todos.slice().sort());
  assert.equal(filas("SELECT * FROM documento_extracciones WHERE documento_id=? AND estado='pendiente'", d2.id).length, 12);
  assert.equal(filas("SELECT * FROM documento_extracciones WHERE documento_id=? AND estado='error'", d2.id).length, 0);
  assert.equal(llamadas.length, 0);
  doc2 = d2;
});

test('confirmar por HTTP funciona aunque la IA no esté disponible: el par queda en cola y la confirmación no depende de la IA', async () => {
  const d3 = (await subir('tercero.pdf')).documento;
  const r = await llamar('POST', '/a/documentos/procesos', { id: d3.id, procesos: ['p6'] });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.documento.estado, 'clasificado');
  assert.deepEqual(r.por_extraer, ['p6']);
});

test('la consola recibe los borradores y el estado de extracción de la campaña', async () => {
  const c = await llamar('GET', '/a/campana?id=c1');
  assert.ok(Array.isArray(c.precarga_borrador) && Array.isArray(c.extracciones));
  assert.ok(c.extracciones.some(x => x.estado === 'generado'));
  assert.ok(c.extracciones.every(x => x.estado !== 'ok'));
});

test('borrar un proceso limpia sus asociaciones, borradores, estado e historial, y devuelve a Pendiente al documento que se queda sin procesos', async () => {
  const d4 = (await subir('cuarto.pdf')).documento;
  respuesta = lectura(['objetivo', 'Algo']);
  await confirmar(d4.id, ['p11']);
  assert.equal(filas("SELECT * FROM documento_extraccion_historial WHERE proceso_id='p11'").length, 1);
  await llamar('POST', '/a/matriz', { proceso_id: 'p11', matriz: { kpis: 'Indicador' } });
  assert.equal(uno("SELECT estado FROM documentos WHERE id=?", d4.id).estado, 'clasificado');
  const r = await llamar('POST', '/a/proceso/borrar', { proceso_id: 'p11' });
  assert.equal(r.status, 200, JSON.stringify(r));
  for (const t of ['documento_procesos', 'documento_extracciones', 'documento_extraccion_historial', 'precarga_borrador', 'matriz_historial']) assert.equal(uno(`SELECT COUNT(*) n FROM ${t} WHERE proceso_id='p11'`).n, 0, t);
  assert.equal(uno('SELECT estado FROM documentos WHERE id=?', d4.id).estado, 'pendiente');
  const lista = await llamar('GET', '/a/documentos?campana_id=c1');
  assert.ok(lista.documentos.every(x => x.procesos.every(p => p.nombre && p.nombre !== 'undefined')));
});

// ---- HU03-b: lectura independiente por proceso
let dA;
test('HU03-b: dos procesos confirmados y la IA falla para el primero: el segundo queda generado, el primero en error, y el historial tiene dos filas cerradas', async () => {
  dA = (await subir('independiente.pdf')).documento;
  respuesta = lectura(['objetivo', 'Algo del documento']); falla = 'la IA se cayó con p7'; fallaEn = 'p7'; llamadas = [];
  const r = await confirmar(dA.id, ['p7', 'p8']);
  assert.deepEqual(r.por_extraer.sort(), ['p7', 'p8']);
  const est = pid => uno('SELECT estado, mensaje FROM documento_extracciones WHERE documento_id=? AND proceso_id=?', dA.id, pid);
  assert.equal(est('p7').estado, 'error'); assert.match(est('p7').mensaje, /se cayó con p7/);
  assert.equal(est('p8').estado, 'generado');
  assert.equal(filas("SELECT * FROM precarga_borrador WHERE documento_id=? AND proceso_id='p8' AND estado='borrador'", dA.id).length, 1);
  assert.equal(filas("SELECT * FROM precarga_borrador WHERE documento_id=? AND proceso_id='p7'", dA.id).length, 0);
  const h = filas('SELECT * FROM documento_extraccion_historial WHERE documento_id=? ORDER BY proceso_id', dA.id);
  assert.deepEqual(h.map(x => [x.proceso_id, x.resultado]), [['p7', 'error'], ['p8', 'generado']]);
  assert.ok(h.every(x => x.fin && x.fin >= x.inicio)); assert.match(h[0].mensaje, /se cayó con p7/);
});

test('HU03-b: reprocesar solo el par con error lo deja generado, sin tocar lo aprobado del otro par; el historial registra el reproceso', async () => {
  const b8 = uno("SELECT id FROM precarga_borrador WHERE documento_id=? AND proceso_id='p8'", dA.id).id;
  assert.equal((await llamar('POST', '/a/precarga/borrador', { proceso_id: 'p8', decisiones: [{ id: b8, accion: 'aprobar' }] })).status, 200);
  falla = null; fallaEn = null; llamadas = [];
  const r = await rutaDocumentoExtraer(env, { id: dA.id, proceso_id: 'p7' }, null, deps);   // sin origen: reproceso
  assert.equal(r.documento.procesos.find(p => p.proceso_id === 'p7').extraccion.estado, 'generado');
  assert.deepEqual(llamadas, ['p7']);
  assert.equal(uno('SELECT estado FROM precarga_borrador WHERE id=?', b8).estado, 'aprobado');
  assert.equal(uno("SELECT estado FROM documento_extracciones WHERE documento_id=? AND proceso_id='p8'", dA.id).estado, 'generado');
  const h = filas("SELECT origen, resultado FROM documento_extraccion_historial WHERE documento_id=? AND proceso_id='p7' ORDER BY inicio", dA.id);
  assert.deepEqual(h.map(x => [x.origen, x.resultado]), [['confirmacion', 'error'], ['reproceso', 'generado']]);
  const g = await llamar('GET', `/a/documentos/historial?id=${dA.id}`);
  assert.equal(g.status, 200); assert.equal(g.historial.length, 3);
  assert.equal(g.historial[0].origen, 'reproceso', 'más reciente primero'); assert.equal(g.historial[0].proceso, 'Proceso 7');
  const solo = await llamar('GET', `/a/documentos/historial?id=${dA.id}&proceso_id=p8`);
  assert.equal(solo.historial.length, 1);
  assert.equal((await llamar('GET', '/a/documentos/historial?id=nadie')).status, 404);
});

test('HU03-b: un par «leyendo» vencido pasa a error con el mensaje del tiempo máximo y cierra su historial; uno reciente no se toca', async () => {
  const viejo = new Date(Date.now() - 20 * 60000).toISOString(), t = new Date().toISOString();
  db.prepare("INSERT INTO documento_extracciones (documento_id, proceso_id, estado, actualizado) VALUES (?, 'p9', 'leyendo', ?)").run(dA.id, viejo);
  db.prepare("INSERT INTO documento_extracciones (documento_id, proceso_id, estado, actualizado) VALUES (?, 'p10', 'procesando', ?)").run(dA.id, t);
  db.prepare("INSERT INTO documento_extraccion_historial (id, campana_id, documento_id, proceso_id, origen, inicio) VALUES ('h-viejo','c1',?, 'p9','confirmacion',?)").run(dA.id, viejo);
  assert.equal(await vencerExtracciones(env, 'c1'), 1);
  const e = uno("SELECT estado, mensaje FROM documento_extracciones WHERE documento_id=? AND proceso_id='p9'", dA.id);
  assert.equal(e.estado, 'error'); assert.match(e.mensaje, /Se superó el tiempo máximo de lectura \(8 min\)/);
  const h = uno("SELECT resultado, fin, mensaje FROM documento_extraccion_historial WHERE id='h-viejo'");
  assert.equal(h.resultado, 'error'); assert.ok(h.fin); assert.match(h.mensaje, /tiempo máximo/);
  assert.equal(uno("SELECT estado FROM documento_extracciones WHERE documento_id=? AND proceso_id='p10'", dA.id).estado, 'procesando');
  // la bandeja de documentos hace el mismo barrido
  db.prepare("UPDATE documento_extracciones SET actualizado=? WHERE documento_id=? AND proceso_id='p10'").run(viejo, dA.id);
  const lista = await llamar('GET', '/a/documentos?campana_id=c1');
  assert.equal(uno("SELECT estado FROM documento_extracciones WHERE documento_id=? AND proceso_id='p10'", dA.id).estado, 'error');
  assert.ok(lista.lecturas_error >= 2);
  db.prepare("DELETE FROM documento_extracciones WHERE documento_id=? AND proceso_id IN ('p9','p10')").run(dA.id);
});

test('HU03-b: leer un par que ya está «leyendo» (vigente) responde 409 y no llama a la IA', async () => {
  llamadas = [];
  db.prepare("UPDATE documento_extracciones SET estado='leyendo', actualizado=? WHERE documento_id=? AND proceso_id='p8'").run(new Date().toISOString(), dA.id);
  const r = await llamar('POST', '/a/documentos/extraer', { id: dA.id, proceso_id: 'p8' });
  assert.equal(r.status, 409); assert.match(r.error, /ya se está leyendo/);
  assert.equal(llamadas.length, 0);
  const o = await ejecutarPar(env, null, dA, 'p8', deps, 'reproceso', 'x');
  assert.equal(o.resultado, 'ocupado', 'la reclamación atómica también protege a quien llama directo (cron)');
  db.prepare("UPDATE documento_extracciones SET estado='generado' WHERE documento_id=? AND proceso_id='p8'").run(dA.id);
});

test('HU03-b: la IA que excede el tiempo máximo deja el par en error (se cancela la espera)', async () => {
  const dB = (await subir('colgado.pdf')).documento;
  cuelga = true; llamadas = [];
  await rutaDocumentoProcesos(env, { id: dB.id, procesos: ['p7'] }, null, deps);
  const r = await ejecutarPar(env, null, dB, 'p7', { ...deps, maxMin: 0.0005 }, 'confirmacion', 'x');   // 30 ms
  cuelga = false;
  assert.equal(r.resultado, 'error'); assert.match(r.mensaje, /tiempo máximo de lectura/);
  assert.equal(uno("SELECT estado FROM documento_extracciones WHERE documento_id=? AND proceso_id='p7'", dB.id).estado, 'error');
  assert.equal(uno('SELECT resultado FROM documento_extraccion_historial WHERE documento_id=?', dB.id).resultado, 'error');
  // la variable de entorno también fija el máximo
  const dC = (await subir('colgado2.pdf')).documento;
  cuelga = true;
  await rutaDocumentoProcesos(env, { id: dC.id, procesos: ['p7'] }, null, deps);
  const r2 = await ejecutarPar({ ...env, EXTRACCION_MAX_MIN: '0.0005' }, null, dC, 'p7', deps, 'reproceso', 'x');
  cuelga = false;
  assert.equal(r2.resultado, 'error');
});

test('HU03-b: el cron toma hasta 4 pares «pendiente» antiguos por corrida, con origen automático; los recientes esperan', async () => {
  respuesta = lectura(['objetivo', 'x']); llamadas = [];
  const viejo = new Date(Date.now() - 10 * 60000).toISOString();
  // doc2 (segundo.pdf) tiene sus pares «pendiente» recién creados: no se tocan
  assert.equal(await extraerPendientes(env, null, deps), 0);
  db.prepare("UPDATE documento_extracciones SET actualizado=? WHERE documento_id=? AND proceso_id IN ('p1','p2','p3','p4','p5')").run(viejo, doc2.id);
  assert.equal(await extraerPendientes(env, null, deps), 4);
  assert.equal(llamadas.length, 4);
  assert.equal(filas("SELECT * FROM documento_extracciones WHERE documento_id=? AND estado='generado'", doc2.id).length, 4);
  assert.equal(filas("SELECT * FROM documento_extracciones WHERE documento_id=? AND estado='pendiente'", doc2.id).length, 7, '11 pares: p11 se borró en una prueba anterior');
  const h = filas('SELECT DISTINCT origen, solicitado_por FROM documento_extraccion_historial WHERE documento_id=?', doc2.id);
  assert.deepEqual(h.map(x => [x.origen, x.solicitado_por]), [['automatico', 'automático']]);
  assert.equal(await extraerPendientes(env, null, deps), 1, 'la siguiente corrida toma el que quedó');
  assert.equal(filas("SELECT * FROM documento_extracciones WHERE documento_id=? AND estado='pendiente'", doc2.id).length, 6);
});

test('HU03-b: en el cron, un fallo de completarPendientes no impide extraerPendientes (el error se relanza al final)', async () => {
  const viejo = new Date(Date.now() - 10 * 60000).toISOString();
  db.prepare("UPDATE documento_extracciones SET actualizado=? WHERE documento_id=? AND proceso_id='p6'").run(viejo, doc2.id);
  const roto = { ...env, DB: { ...d1, prepare: sql => { if (/FROM respuestas r/.test(sql)) throw new Error('D1 caído para la matriz'); return d1.prepare(sql); } } };
  // sin IA configurada, la lectura real termina en error controlado (no hay red): lo importante es que el par se intentó
  await assert.rejects(() => worker.scheduled({}, roto, { waitUntil() {} }), /D1 caído para la matriz/);
  const e = uno("SELECT estado, mensaje FROM documento_extracciones WHERE documento_id=? AND proceso_id='p6'", doc2.id);
  assert.equal(e.estado, 'error'); assert.ok(e.mensaje, 'el par se intentó y quedó con su motivo');
});

test('borrar la campaña elimina sus documentos, sus filas relacionadas y sus archivos de R2', async () => {
  assert.ok([...almacen.keys()].some(k => k.startsWith('c1/')));
  const r = await llamar('POST', '/a/borrar-campana', { campana_id: 'c1', confirmar: 'Prueba' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal([...almacen.keys()].length, 0);
  for (const t of ['documentos', 'documento_procesos', 'documento_extracciones', 'documento_extraccion_historial', 'precarga_borrador', 'matriz_historial', 'procesos']) assert.equal(uno(`SELECT COUNT(*) n FROM ${t}`).n, 0, t);
});
