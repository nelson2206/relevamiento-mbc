// Un proceso que agrega una persona lo ve toda su sección al refrescar, sin esperar a que nadie termine la encuesta.
//   node --test test/unit/proceso-nuevo-seccion.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/index.js';
import { crearD1 } from './d1-memoria.mjs';

const ORIGEN = 'http://prueba.local', ADMIN = 'admin-de-prueba-123', CODIGO = 'abcdefghij';
const G = 'Gerencia Legal', S = 'Sección Legal', OTRA = 'Sección Cumplimiento';
const { d1, db } = crearD1();
const env = { DB: d1, ALLOWED_ORIGINS: ORIGEN, ADMIN_CODE: ADMIN };

async function llamar(metodo, ruta, cuerpo, cab = {}) {
  const req = new Request('http://worker.local' + ruta, {
    method: metodo, body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    headers: { origin: ORIGEN, 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.2', ...cab }
  });
  const r = await worker.fetch(req, env, { waitUntil() {} });
  return { status: r.status, ...(await r.json()) };
}
const registrar = async (nombre, seccion = S) => (await llamar('POST', '/r/registro', { c: CODIGO, nombre, gerencia: G, seccion, pin: '1234', fija: true })).k;
const sesion = k => llamar('GET', '/r/sesion?k=' + k);
const lista = async () => (await llamar('GET', `/r/abierta?c=${CODIGO}&g=${encodeURIComponent(G)}&s=${encodeURIComponent(S)}`)).seccion.responsables;
const porNombre = (j, nombre) => j.procesos.find(p => p.proceso === nombre);

let maria, jorge, pedro, nuevoId;

test('preparación: dos secciones, 2 procesos del inventario en Sección Legal y tres personas', async () => {
  db.prepare("INSERT INTO campanas (id, nombre, cliente, creada, codigo_publico, abierta) VALUES ('c1','Prueba','Toyota',?,?,1)").run(new Date().toISOString(), CODIGO);
  [['p1', 'Contratos A', S], ['p2', 'Contratos B', S], ['p3', 'Cumplimiento A', OTRA]].forEach(([id, p, sec]) =>
    db.prepare("INSERT INTO procesos (id, campana_id, gerencia, seccion, proceso, fuente) VALUES (?, 'c1', ?, ?, ?, 'inventario')").run(id, G, sec, p));
  maria = await registrar('María Quispe');
  jorge = await registrar('Jorge Ramírez');
  pedro = await registrar('Pedro Otero', OTRA);
  assert.ok(maria && jorge && pedro);
  assert.equal((await sesion(jorge)).procesos.length, 2);
});

test('María crea un proceso nuevo en su sección', async () => {
  const r = await llamar('POST', '/r/proceso', { k: maria, proceso: 'Gestión de poderes notariales' });
  assert.equal(r.status, 200);
  assert.ok(r.proceso && r.proceso.id, JSON.stringify(r));
  nuevoId = r.proceso.id;
  assert.equal(r.proceso.propio, true);
});

test('Jorge lo ve al refrescar, en la parte 1 de su sección, aunque nadie haya terminado', async () => {
  const j = await sesion(jorge);
  const p = porNombre(j, 'Gestión de poderes notariales');
  assert.ok(p, 'Jorge ve el proceso nuevo');
  assert.equal(p.enSeccion, true, 'aparece entre los procesos de su sección');
  assert.equal(p.propio, false);
  assert.equal(j.procesos.length, 3);
  assert.equal(j.revisiones[nuevoId], undefined, 'Jorge aún no lo confirmó: es suyo marcar su relación');
});

test('María lo sigue viendo como propio (no se duplica en su parte 1)', async () => {
  const j = await sesion(maria);
  const p = porNombre(j, 'Gestión de poderes notariales');
  assert.equal(p.propio, true);
  assert.equal(p.enSeccion, false);
  assert.equal(j.procesos.length, 3);
});

test('quien está en otra sección no lo ve', async () => {
  const j = await sesion(pedro);
  assert.equal(porNombre(j, 'Gestión de poderes notariales'), undefined);
  assert.equal(j.procesos.length, 1);
});

test('Jorge puede marcar su relación con el proceso nuevo', async () => {
  assert.equal((await llamar('POST', '/r/revision', { k: jorge, proceso_id: nuevoId, estado: 'vigente' })).status, 200);
  assert.equal((await sesion(jorge)).revisiones[nuevoId].estado, 'vigente');
  assert.equal((await sesion(maria)).revisiones[nuevoId].estado, 'vigente', 'la marca de María no cambia');
});

test('la lista de ingreso cuenta el proceso nuevo para los demás y no para quien lo creó', async () => {
  const l = await lista(), de = n => l.find(x => x.nombre === n);
  assert.equal(de('María Quispe').total, 2, 'su propio proceso no suma a su lista de la parte 1');
  assert.equal(de('Jorge Ramírez').total, 3);
  assert.equal(de('Jorge Ramírez').confirmados, 1);
});

test('un proceso que el equipo quita a Jorge no vuelve a aparecer en su lista', async () => {
  const id = db.prepare("SELECT id FROM encuestados WHERE nombre='Jorge Ramírez'").get().id;
  db.prepare("INSERT INTO asignaciones (encuestado_id, proceso_id, creado, origen) VALUES (?, ?, ?, 'excluido')").run(id, nuevoId, new Date().toISOString());
  assert.equal(porNombre(await sesion(jorge), 'Gestión de poderes notariales'), undefined);
  assert.equal((await lista()).find(x => x.nombre === 'Jorge Ramírez').total, 2);
});

test('si María lo retira y nadie más lo usaba, desaparece para todos', async () => {
  const otro = await registrar('Lucía Torres');
  assert.ok(porNombre(await sesion(otro), 'Gestión de poderes notariales'), 'una tercera persona de la sección también lo ve');
  db.prepare("DELETE FROM revisiones WHERE proceso_id=? AND encuestado_id<>(SELECT id FROM encuestados WHERE nombre='María Quispe')").run(nuevoId);
  db.prepare("DELETE FROM asignaciones WHERE proceso_id=? AND origen='excluido'").run(nuevoId);
  assert.equal((await llamar('POST', '/r/soltar', { k: maria, proceso_id: nuevoId })).status, 200);
  assert.equal(porNombre(await sesion(otro), 'Gestión de poderes notariales'), undefined);
});
