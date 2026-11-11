// Recorrido de los pasos 3 a 6 de punta a punta (Worker directo sobre SQLite en memoria) y lo que sale en la extracción de personas.
//   node --test test/unit/embudo-recorrido.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { entorno, sembrar, eventos, abierta, identificar, registrar, responder, V1, V2, V3, G, S } from './embudo-ayuda.mjs';

const personas = async e => (await e.admin('GET', '/a/embudo/export?campana_id=c1&conjunto=personas')).personas.filas;
const de = (filas, nombre) => filas.find(f => f.persona_nombre === nombre);

test('pasos 3 a 6: compartir, abrir, crear acceso y primera respuesta quedan con fecha y persona', async () => {
  const e = entorno(); await sembrar(e.db);

  // Paso 3: el gerente genera el correo para dos personas y delega procesos; el administrador del cliente agrega a una persona.
  const en = await e.gerente('/c/enlaces', { encuestado_ids: ['e-beto', 'e-carla'], para: 'correo' });
  assert.equal(en.enlaces.length, 2);
  const comp = eventos(e.db, 'enlace_compartido');
  assert.deepEqual(comp.map(x => x.persona_id).sort(), ['e-beto', 'e-carla']);
  comp.forEach(x => { assert.equal(x.actor_tipo, 'gerente'); assert.equal(x.actor_id, 's-ger'); assert.equal(x.canal, 'correo'); assert.equal(x.gerencia, G); assert.equal(x.seccion, S); });

  const asig = await e.gerente('/c/asignar', { encuestado_id: 'e-beto', agregar: ['p0', 'p1'] });
  assert.equal(asig.status, 200, JSON.stringify(asig));
  const del = eventos(e.db, 'procesos_delegados');
  assert.equal(del.length, 1);
  assert.equal(del[0].persona_id, 'e-beto'); assert.equal(JSON.parse(del[0].detalle).procesos, 2);

  const nueva = await e.cliente('/c/personas', { personas: [{ nombre: 'Diego Soto', gerencia: G, seccion: S }] });
  assert.equal(nueva.status, 200, JSON.stringify(nueva));
  const agr = eventos(e.db, 'persona_agregada');
  assert.equal(agr.length, 1); assert.equal(agr[0].actor_tipo, 'cliente');
  assert.equal(agr[0].persona_id, e.db.prepare("SELECT id FROM encuestados WHERE nombre='Diego Soto'").get().id);

  // Paso 4: abre el enlace de sección (anónimo) y se identifica con el mismo navegador.
  await abierta(e, V1);
  const beto = await identificar(e, 'e-beto', '4821', V1);
  assert.equal(beto.status, 200);
  const ap = eventos(e.db, 'enlace_abierto')[0];
  assert.equal(ap.actor_tipo, 'anonimo'); assert.equal(ap.visitante, V1);
  const ident = eventos(e.db, 'persona_identificada')[0];
  assert.equal(ident.persona_id, 'e-beto'); assert.equal(ident.visitante, V1);

  // Paso 5: acceso creado (Beto precargada) y otra persona que se registra sola.
  assert.equal(eventos(e.db, 'acceso_creado').length, 1);
  await abierta(e, V2);
  const ana = await registrar(e, 'Ana Salazar', '9137', V2);
  assert.equal(ana.status, 200);
  const accesos = eventos(e.db, 'acceso_creado');
  assert.equal(accesos.length, 2);
  assert.equal(JSON.parse(accesos.find(x => x.persona_id !== 'e-beto').detalle).fuente, 'registro_abierto');

  // Paso 6: primera respuesta de Beto.
  await responder(e, beto.k, 'p0', 'Así se hace el proceso');
  const pr = eventos(e.db, 'primera_respuesta');
  assert.equal(pr.length, 1); assert.equal(pr[0].persona_id, 'e-beto'); assert.equal(pr[0].proceso_id, 'p0');

  const filas = await personas(e);
  const b = de(filas, 'Beto Rojas');
  assert.ok(b.f_compartido && b.f_delegado && b.f_acceso_creado && b.f_primera_respuesta);
  assert.equal(b.f_abrio, ap.creado); assert.equal(b.f_abrio_origen, 'medido'); assert.equal(b.n_aperturas, 1);
  assert.equal(b.f_acceso_creado_origen, 'medido');
  assert.equal(b.ultimo_paso, 6); assert.equal(b.ultimo_paso_nombre, 'empezó');
  assert.equal(b.gerente_nombre, 'Gerente Legal'); assert.equal(b.procesos_asignados, 3);
  const c = de(filas, 'Carla Díaz');
  assert.ok(c.f_compartido); assert.equal(c.f_abrio, ''); assert.equal(c.ultimo_paso, 3); assert.equal(c.ultimo_paso_nombre, 'compartido');
  const a = de(filas, 'Ana Salazar');
  assert.equal(a.f_abrio_origen, 'medido'); assert.equal(a.ultimo_paso, 5); assert.equal(a.origen, 'abierto');
  assert.equal(de(filas, 'Diego Soto').ultimo_paso, 3);
});

test('un visitante compartido por dos personas no se atribuye a ninguna: la apertura queda como inferida', async () => {
  const e = entorno(); await sembrar(e.db);
  await abierta(e, V3);
  await identificar(e, 'e-beto', '4821', V3);
  await identificar(e, 'e-carla', '5555', V3);
  const filas = await personas(e);
  for (const n of ['Beto Rojas', 'Carla Díaz']) {
    const f = de(filas, n);
    assert.equal(f.f_abrio_origen, 'inferido', n); assert.equal(f.n_aperturas, 0);
    assert.ok(f.f_abrio);
  }
});

test('un ingreso con almacenamiento bloqueado (sin visitante) igual crea el acceso y se infiere la apertura', async () => {
  const e = entorno(); await sembrar(e.db);
  await identificar(e, 'e-beto', '4821');
  const ident = eventos(e.db, 'persona_identificada')[0];
  assert.equal(ident.visitante, '');
  const b = de(await personas(e), 'Beto Rojas');
  assert.equal(b.f_abrio_origen, 'inferido'); assert.equal(b.f_abrio, ident.creado);
});

test('el panel del gerente y el del cliente no cambian de respuesta por el registro de eventos', async () => {
  const e = entorno(); await sembrar(e.db);
  const r = await e.gerente('/c/enlaces', { encuestado_ids: ['e-beto', 'no-existe'], para: 'enlace' });
  assert.deepEqual(r.enlaces, [{ id: 'e-beto', nombre: 'Beto Rojas', correo: 'beto@toyota.test' }]);
  assert.equal(eventos(e.db, 'enlace_compartido').length, 1);
  assert.equal(eventos(e.db, 'enlace_compartido')[0].canal, 'enlace');
});

test('la extracción pide el código de administrador y valida los parámetros', async () => {
  const e = entorno(); await sembrar(e.db);
  assert.equal((await e.llamar('GET', '/a/embudo/export?campana_id=c1')).status, 401);
  assert.equal((await e.admin('GET', '/a/embudo/export?campana_id=nada')).status, 404);
  assert.equal((await e.admin('GET', '/a/embudo/export?campana_id=c1&conjunto=raro')).status, 400);
  assert.equal((await e.admin('GET', '/a/embudo/export?campana_id=c1&formato=csv')).status, 400);
  assert.equal((await e.admin('GET', '/a/embudo/export?campana_id=c1&desde=ayer')).status, 400);
  assert.equal((await e.admin('POST', '/a/embudo/backfill', { campana_id: 'nada' })).status, 404);
});
