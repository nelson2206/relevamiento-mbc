// HU03: la matriz es la única fuente de lo precargado; la encuesta lo ve, lo conserva, edita o reemplaza, y cada cambio queda en el historial.
//   node --test test/unit/matriz-sync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/index.js';
import { PUNTO_CAMPO, puedeAutomatico, valoresDeProceso } from '../../src/matriz-sync.js';
import { crearD1 } from './d1-memoria.mjs';

const ORIGEN = 'http://prueba.local', ADMIN = 'admin-de-prueba-123', CODIGO = 'abcdefghij';
const G = 'Gerencia Legal', S = 'Sección Legal', OTRA = 'Sección Cumplimiento';
const { d1, db } = crearD1();
const env = { DB: d1, ALLOWED_ORIGINS: ORIGEN, ADMIN_CODE: ADMIN };

async function llamar(metodo, ruta, cuerpo, cab = {}) {
  const r = await worker.fetch(new Request('http://worker.local' + ruta, {
    method: metodo, body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    headers: { origin: ORIGEN, 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.4', ...cab }
  }), env, { waitUntil() {} });
  return { status: r.status, ...(await r.json()) };
}
const admin = (m, ruta, cuerpo) => llamar(m, ruta, cuerpo, { 'x-admin-code': ADMIN });
const registrar = async (nombre, seccion = S) => (await llamar('POST', '/r/registro', { c: CODIGO, nombre, gerencia: G, seccion, pin: '1234', fija: true })).k;
const sesion = k => llamar('GET', '/r/sesion?k=' + k);
const matriz = id => JSON.parse(db.prepare('SELECT matriz FROM procesos WHERE id=?').get(id).matriz);
const historial = (id, campo) => db.prepare('SELECT * FROM matriz_historial WHERE proceso_id=? AND campo=? ORDER BY creado, rowid').all(id, campo);

let maria, pedro;

test('preparación: dos secciones, dos procesos en Legal y una persona en cada una', async () => {
  db.prepare("INSERT INTO campanas (id, nombre, cliente, creada, codigo_publico, abierta) VALUES ('c1','Prueba','Toyota',?,?,1)").run(new Date().toISOString(), CODIGO);
  [['p1', 'Contratos A', S], ['p2', 'Contratos B', S], ['p3', 'Cumplimiento A', OTRA]].forEach(([id, p, sec]) =>
    db.prepare("INSERT INTO procesos (id, campana_id, gerencia, seccion, proceso, fuente) VALUES (?, 'c1', ?, ?, ?, 'inventario')").run(id, G, sec, p));
  maria = await registrar('María Quispe');
  pedro = await registrar('Pedro Otero', OTRA);
  assert.ok(maria && pedro);
});

test('el mapa punto → campo solo apunta a claves que existen en la matriz', () => {
  Object.values(PUNTO_CAMPO).forEach(c => assert.ok(['objetivo', 'alcance', 'aprobadores', 'carga', 'tecnologia', 'terceros', 'detalle_dp', 'finalidad_dp',
    'documentacion', 'estandar_tdp', 'estandar_tmc', 'normativa', 'kpis'].includes(c), c));
});

test('la precarga del equipo llega a la matriz con historial y la encuesta la ve con su origen', async () => {
  const r = await admin('POST', '/a/precarga', { proceso_id: 'p1', puntos: [
    { punto: 'objetivo', texto: 'Gestionar los contratos con proveedores', archivos: ['contratos.pdf'] },
    { punto: 'terceros', texto: 'Proveedores y notarías' }
  ] });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(matriz('p1').objetivo, 'Gestionar los contratos con proveedores');
  const h = historial('p1', 'objetivo');
  assert.equal(h.length, 1); assert.equal(h[0].origen, 'documento'); assert.equal(h[0].anterior, ''); assert.equal(h[0].actor_nombre, 'Equipo consultor');
  assert.equal(historial('p1', 'terceros')[0].origen, 'precarga');
  const s = await sesion(maria);
  assert.equal(s.valores.p1.objetivo.texto, 'Gestionar los contratos con proveedores');
  assert.equal(s.valores.p1.objetivo.origen, 'documento');
  assert.equal(s.valores.p1.objetivo.validado, false);
});

test('la encuesta no recibe el resto de la matriz ni valores de otra sección', async () => {
  db.prepare("UPDATE procesos SET matriz=json_set(matriz, '$.sancion', 'secreto') WHERE id='p1'").run();
  const s = await sesion(maria);
  assert.ok(!JSON.stringify(s).includes('secreto'));
  assert.ok(!s.procesos.some(p => p.matriz));
  const o = await sesion(pedro);
  assert.ok(!o.valores || !o.valores.p1);
});

test('la descripción es de solo lectura: la encuesta no puede editarla', async () => {
  const r = await llamar('POST', '/r/campo', { k: maria, proceso_id: 'p1', punto: 'objetivo', texto: 'Mi versión del objetivo' });
  assert.equal(r.status, 400, JSON.stringify(r));
  assert.equal(matriz('p1').objetivo, 'Gestionar los contratos con proveedores');
  assert.equal(historial('p1', 'objetivo').length, 1);
});

test('confirmar que sigue vigente no cambia el texto: queda validado, cubre el punto y se registra', async () => {
  const antes = historial('p1', 'terceros').length;
  const r = await llamar('POST', '/r/campo', { k: maria, proceso_id: 'p1', punto: 'terceros' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.valor.validado, true); assert.equal(r.valor.texto, 'Proveedores y notarías');
  const h = historial('p1', 'terceros');
  assert.equal(h.length, antes + 1); assert.equal(h[h.length - 1].tipo, 'validacion'); assert.equal(h[h.length - 1].actor_nombre, 'María Quispe');
  assert.equal(h[h.length - 1].anterior, h[h.length - 1].nuevo);
  const s = await sesion(maria);
  assert.equal(s.valores.p1.terceros.validado, true);
  assert.equal(s.respuestas.p1.b2.checklist.terceros.estado, 'cubierto');
});

test('con información nueva la descripción se actualiza sola aunque estuviera validada, y la validación se vuelve a pedir', async () => {
  await admin('POST', '/a/precarga', { proceso_id: 'p1', puntos: [{ punto: 'terceros', texto: 'Proveedores, notarías y SUNARP' }] });
  assert.equal(matriz('p1').terceros, 'Proveedores, notarías y SUNARP');
  const v = (await sesion(maria)).valores.p1.terceros;
  assert.equal(v.texto, 'Proveedores, notarías y SUNARP'); assert.equal(v.validado, false); assert.equal(v.origen, 'precarga');
  const h = historial('p1', 'terceros');
  assert.equal(h[h.length - 1].anterior, 'Proveedores y notarías');
});

test('un cambio de la consola quita la validación y congela la descripción: la precarga ya no la pisa', async () => {
  await llamar('POST', '/r/campo', { k: maria, proceso_id: 'p1', punto: 'terceros' });
  await admin('POST', '/a/matriz', { proceso_id: 'p1', matriz: { terceros: 'Proveedores, notarías y SUNARP (corregido)' } });
  assert.equal((await sesion(maria)).valores.p1.terceros.validado, false);
  const h = historial('p1', 'terceros');
  assert.equal(h[h.length - 1].origen, 'consola'); assert.equal(h[h.length - 1].anterior, 'Proveedores, notarías y SUNARP');
  await admin('POST', '/a/precarga', { proceso_id: 'p1', puntos: [{ punto: 'terceros', texto: 'Otro texto del documento' }] });
  assert.equal(matriz('p1').terceros, 'Proveedores, notarías y SUNARP (corregido)');
});

test('la consola también deja historial y puede borrar un campo', async () => {
  await admin('POST', '/a/matriz', { proceso_id: 'p1', matriz: { terceros: '' } });
  const h = historial('p1', 'terceros');
  assert.equal(h[h.length - 1].nuevo, ''); assert.equal(h[h.length - 1].anterior, 'Proveedores, notarías y SUNARP (corregido)');
});

test('la precarga sí actualiza lo que dejó otra fuente automática', async () => {
  await admin('POST', '/a/precarga', { proceso_id: 'p2', puntos: [{ punto: 'kpis', texto: 'Contratos vencidos' }] });
  await admin('POST', '/a/precarga', { proceso_id: 'p2', puntos: [{ punto: 'kpis', texto: 'Contratos vencidos por mes' }] });
  assert.equal(matriz('p2').kpis, 'Contratos vencidos por mes');
  assert.equal(historial('p2', 'kpis').length, 2);
});

test('una fila validada por la consola no la pisa la precarga', async () => {
  await admin('POST', '/a/matriz', { proceso_id: 'p2', validacion: 'validado', validado_por: 'Gerencia' });
  await admin('POST', '/a/precarga', { proceso_id: 'p2', puntos: [{ punto: 'kpis', texto: 'Otro indicador' }, { punto: 'normativa', texto: 'Ley 29733' }] });
  assert.equal(matriz('p2').kpis, 'Contratos vencidos por mes');
  assert.ok(!matriz('p2').normativa);
});

test('/r/campo rechaza puntos sin campo, procesos ajenos y llamadas sin nada que guardar', async () => {
  assert.equal((await llamar('POST', '/r/campo', { k: maria, proceso_id: 'p1', punto: 'riesgos', texto: 'x' })).status, 400);
  assert.equal((await llamar('POST', '/r/campo', { k: maria, proceso_id: 'p3', punto: 'objetivo', texto: 'x' })).status, 403);
  assert.equal((await llamar('POST', '/r/campo', { k: maria, proceso_id: 'p1', punto: 'carga' })).status, 400);   // sin descripción todavía
});

test('el historial se consulta con filtros desde la consola y exige código de administración', async () => {
  const sin = await llamar('GET', '/a/campana/historial?id=c1');
  assert.ok(sin.status === 401 || sin.status === 403);
  const todo = await admin('GET', '/a/campana/historial?id=c1&proceso_id=p1&campo=objetivo');
  assert.equal(todo.status, 200);
  assert.equal(todo.cambios.length, 1);
  const terc = await admin('GET', '/a/campana/historial?id=c1&proceso_id=p1&campo=terceros');
  assert.ok(terc.cambios.length >= 3 && terc.cambios[0].creado >= terc.cambios[1].creado);
  const dePersona = await admin('GET', '/a/campana/historial?id=c1&actor=' + encodeURIComponent('María'));
  assert.ok(dePersona.cambios.length >= 2 && dePersona.cambios.every(c => c.tipo === 'validacion') && dePersona.cambios.every(c => c.actor_nombre === 'María Quispe'));
  assert.equal((await admin('GET', '/a/campana/historial?id=c1&origen=documento')).cambios.length, 1);
  assert.equal((await admin('GET', '/a/campana/historial?id=nada')).status, 404);
});

test('puedeAutomatico y valoresDeProceso: reglas puras', () => {
  const libre = { validacion: '' };
  assert.equal(puedeAutomatico(libre, {}, {}, 'objetivo'), true);
  assert.equal(puedeAutomatico({ validacion: 'validado' }, {}, {}, 'objetivo'), false);
  assert.equal(puedeAutomatico(libre, { objetivo: 'a' }, {}, 'objetivo'), false);   // lo escribió una persona
  assert.equal(puedeAutomatico(libre, { objetivo: 'a' }, { objetivo: { estado: 'precarga' } }, 'objetivo'), true);   // descripción automática
  assert.equal(puedeAutomatico({ validacion: 'validado' }, { objetivo: 'a' }, { objetivo: { estado: 'dicho' } }, 'objetivo'), false);
  const v = valoresDeProceso({ actualizado_en: 't' }, { objetivo: 'o', sancion: 's' }, {});
  assert.deepEqual(Object.keys(v), ['objetivo']); assert.equal(v.objetivo.origen, 'inventario');
});

test('una validación de MBC sobre la fila cuenta como validada y se distingue de la de la persona', async () => {
  const s = await sesion(maria);
  assert.equal(s.valores.p2.kpis.validado, true); assert.equal(s.valores.p2.kpis.mbc, true);
  assert.equal(s.valores.p1.objetivo.mbc, false);
});

test('deshacer la marca revoca la confirmación de vigencia y queda en el historial', async () => {
  await llamar('POST', '/r/campo', { k: maria, proceso_id: 'p1', punto: 'objetivo' });
  assert.equal((await sesion(maria)).valores.p1.objetivo.validado, true);
  const r = await llamar('POST', '/r/punto', { k: maria, proceso_id: 'p1', pregunta: 'b1', punto: 'objetivo', estado: '' });
  assert.equal(r.status, 200, JSON.stringify(r));
  const v = (await sesion(maria)).valores.p1.objetivo;
  assert.equal(v.validado, false); assert.equal(v.origen, 'documento', 'el origen del texto no cambia por confirmar o revocar');
  assert.deepEqual(historial('p1', 'objetivo').slice(-2).map(h => h.tipo), ['validacion', 'revocacion']);
});

test('la descripción queda «desactualizada» cuando hay una respuesta más nueva que el último análisis, y la sesión informa si la IA es automática', async () => {
  let s = await sesion(maria);
  assert.equal(s.valores.p1.objetivo.desactualizado, false);
  assert.equal(typeof s.campana.ia_auto, 'number');
  await llamar('POST', '/r/respuesta', { k: maria, proceso_id: 'p1', pregunta: 'b1', texto: 'Ahora también renovamos los contratos cada año.' });
  s = await sesion(maria);
  assert.equal(s.valores.p1.objetivo.desactualizado, true);
  db.prepare("INSERT INTO estructurado (proceso_id, campana_id, datos, modelo, generado) VALUES ('p1','c1','{}','m',?)").run(new Date(Date.now() + 1000).toISOString());
  assert.equal((await sesion(maria)).valores.p1.objetivo.desactualizado, false);
});

test('mover y renombrar un proceso dejan historial de la matriz', async () => {
  const r = await admin('POST', '/a/proceso/mover', { campana_id: 'c1', proceso_ids: ['p2'], gerencia: G, seccion: S, macroproceso: 'Macro nuevo' });
  assert.equal(r.status, 200, JSON.stringify(r));
  const h = historial('p2', 'macroproceso');
  assert.equal(h.length, 1); assert.equal(h[0].nuevo, 'Macro nuevo'); assert.equal(h[0].origen, 'consola');
});

test('las confirmaciones de las personas cuentan como cubiertas en el avance del Supervisor', async () => {
  const { puntosValidados } = await import('../../src/matriz-sync.js');
  const v = await puntosValidados(env, 'c1');
  assert.ok(v.every(x => x.proceso_id && x.punto));
  assert.ok(!v.some(x => x.proceso_id === 'p1' && x.punto === 'objetivo'), 'revocado: ya no cuenta');
});
