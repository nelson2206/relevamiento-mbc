// Idempotencia de los eventos de «primera vez», ventana anti-ruido de aperturas y registro que nunca rompe la acción principal.
//   node --test test/unit/embudo-idempotencia.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { registrarEventos } from '../../src/embudo.js';
import { entorno, sembrar, eventos, abierta, identificar, registrar, responder, V1, V2, CLAVE_GERENTE } from './embudo-ayuda.mjs';

test('acceso_creado y primera_respuesta repetidos dejan una sola fila', async () => {
  const e = entorno(); await sembrar(e.db);
  const ev = { campana_id: 'c1', tipo: 'acceso_creado', persona_id: 'e-beto', clave: 'acceso_creado|e-beto' };
  await registrarEventos(e.env, e.ctx, [ev, ev]);
  await registrarEventos(e.env, e.ctx, [ev]);
  assert.equal(eventos(e.db, 'acceso_creado').length, 1);

  const beto = await identificar(e, 'e-beto', '4821');
  assert.equal(beto.status, 200);
  await responder(e, beto.k, 'p0', 'primera');
  await responder(e, beto.k, 'p0', 'segunda versión');
  assert.equal(eventos(e.db, 'primera_respuesta').length, 1, 'misma persona y proceso: una sola');
  await responder(e, beto.k, 'p1', 'otro proceso');
  assert.equal(eventos(e.db, 'primera_respuesta').length, 2, 'otro proceso: otra primera respuesta');
});

test('las visitas sí se repiten: cada ingreso deja persona_identificada, pero acceso_creado solo una vez', async () => {
  const e = entorno(); await sembrar(e.db);
  await identificar(e, 'e-beto', '4821', V1);
  await identificar(e, 'e-beto', '4821', V1);
  await identificar(e, 'e-beto', '4821', V1);
  assert.equal(eventos(e.db, 'persona_identificada').length, 3);
  assert.equal(eventos(e.db, 'acceso_creado').length, 1);
  assert.equal(JSON.parse(eventos(e.db, 'acceso_creado')[0].detalle).fuente, 'precargada');
});

test('un guardado sin contenido no cuenta como primera respuesta', async () => {
  const e = entorno(); await sembrar(e.db);
  const beto = await identificar(e, 'e-beto', '4821');
  assert.equal((await responder(e, beto.k, 'p0', '   ')).status, 200);
  assert.equal(eventos(e.db, 'primera_respuesta').length, 0);
});

test('enlace_abierto: mismo visitante y sección en menos de 30 min cuenta una vez; sin v o con v inválido no registra', async () => {
  const e = entorno(); await sembrar(e.db);
  await abierta(e, V1); await abierta(e, V1); await abierta(e, V1);
  assert.equal(eventos(e.db, 'enlace_abierto').length, 1);
  await abierta(e, V2);
  assert.equal(eventos(e.db, 'enlace_abierto').length, 2, 'otro visitante');
  await abierta(e); await abierta(e, 'no-es-uuid');
  assert.equal(eventos(e.db, 'enlace_abierto').length, 2, 'sin visitante válido no registra');
  // pasada la ventana, el mismo visitante vuelve a contar
  e.db.prepare("UPDATE eventos SET creado='2026-11-01T00:00:00.000Z' WHERE visitante=?").run(V1);
  await abierta(e, V1);
  assert.equal(eventos(e.db, 'enlace_abierto').filter(x => x.visitante === V1).length, 2);
  const fila = eventos(e.db, 'enlace_abierto')[0];
  assert.equal(fila.actor_tipo, 'anonimo'); assert.equal(fila.gerencia, G_); assert.equal(fila.persona_id, '');
});
const G_ = 'Gerencia Legal';

test('una apertura sin visitante o de una sección inexistente no cambia la respuesta de /r/abierta', async () => {
  const e = entorno(); await sembrar(e.db);
  const a = await abierta(e), b = await abierta(e, V1);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.deepEqual(a.seccion, b.seccion);
  const mala = await e.llamar('GET', `/r/abierta?c=abcdefghij&g=Otra&s=Nada&v=${V1}`);
  assert.equal(mala.status, 404);
  assert.equal(eventos(e.db, 'enlace_abierto').length, 1, 'la sección inválida no registra');
});

test('si el registro de eventos falla, la acción principal responde igual (200)', async () => {
  const e = entorno({ envolver: d1 => ({ prepare: sql => { if (/eventos/.test(sql)) throw new Error('D1 caído'); return d1.prepare(sql); }, batch: ss => d1.batch(ss) }) });
  await sembrar(e.db);
  assert.equal((await abierta(e, V1)).status, 200);
  const beto = await identificar(e, 'e-beto', '4821', V1);
  assert.equal(beto.status, 200); assert.ok(beto.k);
  assert.equal((await responder(e, beto.k, 'p0', 'algo')).status, 200);
  assert.equal((await registrar(e, 'Ana Salazar', '9137', V2)).status, 200);
  const r = await e.gerente('/c/enlaces', { encuestado_ids: ['e-carla'], para: 'enlace' });
  assert.equal(r.status, 200); assert.equal(r.enlaces.length, 1);
  assert.equal(eventos(e.db).length, 0);
});

test('un fallo del batch (tabla sin migrar) tampoco rompe la acción principal', async () => {
  const e = entorno({ envolver: d1 => ({ prepare: sql => d1.prepare(sql), batch: async ss => { throw new Error('no such table: eventos'); } }) });
  await sembrar(e.db);
  const r = await identificar(e, 'e-beto', '4821', V1);
  assert.equal(r.status, 200);
});
