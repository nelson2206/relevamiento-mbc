// Funnel de trazabilidad del llenado: 6 etapas (acumulativas salvo la declarativa), estado y avance de gerencia, secciones, usuarios y alcance del gerente.
//   node --test test/unit/embudo-funnel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularFunnel, backfillEmbudo, ETAPAS_FUNNEL } from '../../src/embudo.js';
import { entorno, sembrar, eventos, abierta, identificar, V1, V2, G, S, CLAVE_GERENTE } from './embudo-ayuda.mjs';

const BLOQUES = [{ id: 'b1', puntos: [['a'], ['b']] }, { id: 'b2', puntos: [['c']] }, { id: 'b3', puntos: [['d']] }];
const ck = (...ids) => JSON.stringify(Object.fromEntries(ids.map(i => [i, { estado: 'cubierto' }])));
const resp = (db, e, p, pregunta, checklist, texto = '') =>
  db.prepare('INSERT INTO respuestas (encuestado_id, proceso_id, pregunta, texto, checklist, actualizado) VALUES (?,?,?,?,?,?)').run(e, p, pregunta, texto, checklist, '2026-11-09T10:00:00.000Z');
const revisar = (db, e, p) => db.prepare("INSERT INTO revisiones (encuestado_id, proceso_id, estado, actualizado) VALUES (?,?, 'vigente', '2026-11-05T10:00:00.000Z')").run(e, p);
const fila = (f, g) => f.gerencias.find(x => x.gerencia === g);
const etapas = (f, g) => { const r = fila(f, g); return [r.registrados, r.con_procesos, r.iniciados, r.avanzados, r.terminados, r.encuesta_terminada]; };

// Beto: se identifica (crea su PIN), confirma p0 y p1, completa p0 y deja p1 con una sola pregunta. Carla: nunca entró; un visitante anónimo abrió el enlace.
async function escenario() {
  const e = entorno(); await sembrar(e.db);
  await abierta(e, V1); await abierta(e, V2);
  await identificar(e, 'e-beto', '4821', V1);
  revisar(e.db, 'e-beto', 'p0'); revisar(e.db, 'e-beto', 'p1');
  resp(e.db, 'e-beto', 'p0', 'b1', ck('a', 'b'), 'x'); resp(e.db, 'e-beto', 'p0', 'b2', ck('c')); resp(e.db, 'e-beto', 'p0', 'b3', ck('d'));
  resp(e.db, 'e-beto', 'p1', 'b1', ck('a'), 'algo');
  const hace = d => new Date(Date.now() - d * 86400000).toISOString();
  e.db.prepare("UPDATE encuestados SET creado=?, actualizado=? WHERE id='e-carla'").run(hace(10), hace(10));
  return e;
}
const camp = { id: 'c1', nombre: 'PRUEBA' };

test('las 6 etapas avanzan por persona; los visitantes que nunca se registraron no cuentan', async () => {
  const e = await escenario();
  const f = await calcularFunnel(e.env, camp, BLOQUES);
  assert.deepEqual(f.etapas, ETAPAS_FUNNEL);
  // Solo Beto está registrado: el visitante anónimo V2 y Carla (sin acceso) no entran al funnel.
  assert.deepEqual(etapas(f, 'Total'), [1, 1, 1, 1, 0, 0]);
  assert.deepEqual(etapas(f, G), [1, 1, 1, 1, 0, 0]);
  // Porcentajes: todos sobre los registrados. El avance real es de procesos (1 terminado de 2).
  const t = fila(f, 'Total');
  assert.equal(t.pct_con_procesos, 100); assert.equal(t.pct_iniciados, 100); assert.equal(t.pct_avanzados, 100);
  assert.equal(t.pct_terminados, 0); assert.equal(t.pct_encuesta_terminada, 0);
  assert.equal(t.avance_asumido_pct, 50, 'lo asumido por las personas: 1 de los 2 procesos que Beto tomó');
  assert.equal(t.avance_pct, 33.3, 'avance oficial: 1 de los 3 procesos vigentes de la gerencia');
  assert.deepEqual(f.gerencias.map(x => x.gerencia), [G, 'Total'], 'una fila por gerencia y el total al final');
  assert.equal(f.secciones[0].avance_pct, 33.3); assert.equal(f.secciones[0].avance_asumido_pct, 50);
});

test('Encuesta terminada guarda la fecha una sola vez y es independiente de «Procesos terminados»', async () => {
  const e = await escenario();
  await e.llamar('POST', '/r/enviar', { k: 'tokenbeto0123456789' });
  await e.llamar('POST', '/r/enviar', { k: 'tokenbeto0123456789' });
  const ev = eventos(e.db, 'encuesta_terminada');
  assert.equal(ev.length, 1); assert.equal(ev[0].persona_id, 'e-beto'); assert.equal(ev[0].reconstruido, 0);
  const f = await calcularFunnel(e.env, camp, BLOQUES);
  assert.deepEqual(etapas(f, 'Total'), [1, 1, 1, 1, 0, 1]);
  const bk = await backfillEmbudo(e.env, 'c1');
  assert.equal(bk.insertados.encuesta_terminada, 0, 'el evento medido ya existe: el backfill no lo duplica');
});

test('gerencia: avance oficial = procesos respondidos / procesos vigentes; el de lo asumido va aparte; estado y última actividad', async () => {
  const e = await escenario();
  const f = await calcularFunnel(e.env, camp, BLOQUES);
  assert.equal(f.resumen.length, 1);
  assert.equal(f.resumen[0].avance_pct, 33.3);          // oficial: 1 de 3 procesos vigentes
  assert.equal(f.resumen[0].avance_asumido_pct, 50);    // lo asumido por las personas: 1 de 2
  assert.equal(f.resumen[0].estado, 'En levantamiento');
  assert.match(f.resumen[0].ultima_actividad, /^\d{4}-\d{2}-\d{2}$/);
  e.db.prepare("DELETE FROM respuestas WHERE encuestado_id='e-beto' AND proceso_id='p1'").run();
  resp(e.db, 'e-beto', 'p1', 'b1', ck('a', 'b'), 'x'); resp(e.db, 'e-beto', 'p1', 'b2', ck('c')); resp(e.db, 'e-beto', 'p1', 'b3', ck('d'));
  const g2 = (await calcularFunnel(e.env, camp, BLOQUES)).resumen[0];
  assert.equal(g2.avance_asumido_pct, 100); assert.equal(g2.avance_pct, 66.7); assert.equal(g2.estado, 'En levantamiento', 'falta p2: el avance oficial no llega a 100 %');
  resp(e.db, 'e-beto', 'p2', 'b1', ck('a', 'b'), 'x'); resp(e.db, 'e-beto', 'p2', 'b2', ck('c')); resp(e.db, 'e-beto', 'p2', 'b3', ck('d'));
  const g3 = (await calcularFunnel(e.env, camp, BLOQUES)).resumen[0];
  assert.equal(g3.avance_pct, 100); assert.equal(g3.estado, 'Lista para validar');
  e.db.prepare("UPDATE procesos SET validacion='validado'").run();
  assert.equal((await calcularFunnel(e.env, camp, BLOQUES)).resumen[0].estado, 'Validada');
});

test('usuarios y secciones: x de N, SÍ/NO e inactividad de 7 días o más', async () => {
  const e = await escenario();
  const f = await calcularFunnel(e.env, camp, BLOQUES);
  const b = f.usuarios.find(u => u.usuario === 'Beto Rojas'), c = f.usuarios.find(u => u.usuario === 'Carla Díaz');
  assert.deepEqual([b.confirmados, b.nuevos, b.total, b.iniciados, b.avanzados, b.terminados], [2, 0, 2, 2, 1, 1]);
  assert.deepEqual([b.pct_iniciados, b.pct_avanzados, b.pct_terminados], [100, 50, 50]);
  assert.equal(b.encuesta_terminada, 'NO'); assert.equal(b.inactivo, 'NO');
  assert.deepEqual([c.total, c.iniciados, c.terminados], [0, 0, 0]);
  assert.equal(c.inactivo, 'SÍ');
  assert.equal(f.secciones.length, 1);
  assert.deepEqual([f.secciones[0].registrados, f.secciones[0].terminados, f.secciones[0].inactivos], [1, 0, 1]);
  assert.ok(f.usuarios.every(u => !('correo' in u) && !('token' in u)), 'sin correos ni tokens');
});

test('GET /a/embudo/funnel: solo administración; el cliente y el gerente no tienen la ruta', async () => {
  const e = await escenario();
  e.db.prepare("INSERT INTO encuestados (id, campana_id, token, nombre, gerencia, seccion, creado) VALUES ('e-otro','c1','tokenotro0123456789','Otro Compras','Compras','Pagos','2026-11-01T10:00:00.000Z')").run();
  const admin = await e.admin('GET', '/a/embudo/funnel?campana_id=c1');
  assert.equal(admin.status, 200); assert.ok(admin.usuarios.some(u => u.gerencia === 'Compras') && admin.usuarios.some(u => u.gerencia === G));
  assert.equal((await e.llamar('GET', '/a/embudo/funnel?campana_id=c1')).status, 401, 'sin código de administrador no entra');
  assert.equal((await e.llamar('GET', '/a/embudo/funnel?campana_id=c1', null, { 'x-client-code': CLAVE_GERENTE })).status, 401, 'la clave del gerente no sirve');
  assert.equal((await e.llamar('GET', '/c/funnel', null, { 'x-client-code': CLAVE_GERENTE })).status, 404, 'el panel del cliente ya no trae el funnel');
  assert.equal((await e.admin('GET', '/a/embudo/funnel?campana_id=no-existe')).status, 404);
});
