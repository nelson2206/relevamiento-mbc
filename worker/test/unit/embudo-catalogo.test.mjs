// Catálogo cerrado del embudo: tipos válidos, lista blanca del detalle y registro que nunca rompe.
//   node --test test/unit/embudo-catalogo.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENTOS, ACTORES, DETALLE_PERMITIDO, normalizarEvento, limpiarDetalle, visitanteValido, registrarEventos } from '../../src/embudo.js';
import { entorno, sembrar, eventos, abierta, identificar, registrar, responder, V1, V2, CLAVE_GERENTE } from './embudo-ayuda.mjs';

test('el catálogo trae los tipos del plan y cada uno tiene su paso', () => {
  ['acceso_gerente_generado', 'acceso_gerente_enviado', 'gerente_abrio', 'gerente_entro', 'enlace_compartido', 'persona_agregada', 'procesos_delegados', 'enlace_abierto',
    'persona_identificada', 'acceso_creado', 'pin_fallido', 'primera_respuesta', 'bloque_completado', 'proceso_completo', 'proceso_validado'].forEach(t => {
    assert.ok(EVENTOS[t], 'falta ' + t);
    assert.ok(EVENTOS[t].paso >= 1 && EVENTOS[t].paso <= 7);
  });
  assert.ok(ACTORES.includes('anonimo') && ACTORES.includes('gerente'));
});

test('un tipo fuera del catálogo se rechaza al normalizar', () => {
  assert.throws(() => normalizarEvento({ campana_id: 'c1', tipo: 'inventado' }), /fuera del catálogo/);
  assert.throws(() => normalizarEvento({ campana_id: 'c1' }), /fuera del catálogo/);
  assert.throws(() => normalizarEvento({ tipo: 'enlace_abierto' }), /sin campaña/i);
});

test('en el registro un tipo inválido se ignora sin lanzar y sin escribir', async () => {
  const e = entorno(); await sembrar(e.db);
  await registrarEventos(e.env, e.ctx, [{ campana_id: 'c1', tipo: 'inventado' }]);
  assert.equal(eventos(e.db).length, 0);
});

test('el detalle solo conserva claves de la lista blanca y descarta correos', () => {
  const d = limpiarDetalle({ texto: 'lo que dijo', token: 'abc', correo: 'a@b.com', procesos: 3, motivo: 'a@b.com', pin: 'creado', fuente: 'precargada', anidado: { x: 1 }, perfil: ['x'] });
  assert.deepEqual(d, { procesos: 3, pin: 'creado', fuente: 'precargada' });
  Object.keys(d).forEach(k => assert.ok(DETALLE_PERMITIDO.includes(k)));
});

test('el visitante debe ser un UUID; cualquier otra cosa queda vacía', () => {
  assert.equal(visitanteValido(V1), V1);
  assert.equal(visitanteValido(V1.toUpperCase()), V1);
  ['', null, undefined, 'abc', 'x'.repeat(36), V1 + 'zz', '../../etc/passwd'].forEach(v => assert.equal(visitanteValido(v), ''));
});

test('el canal y el actor fuera de lista se vacían', () => {
  const f = normalizarEvento({ campana_id: 'c1', tipo: 'enlace_compartido', actor_tipo: 'hacker', canal: 'paloma' });
  assert.equal(f.actor_tipo, ''); assert.equal(f.canal, '');
});

test('barrido: ningún evento de un recorrido guarda correos, PIN, tokens ni textos de respuesta', async () => {
  const e = entorno(); await sembrar(e.db);
  await abierta(e, V1);
  const beto = await identificar(e, 'e-beto', '4821', V1);
  await responder(e, beto.k, 'p0', 'Texto secreto de la respuesta sobre compras');
  await registrar(e, 'Ana Salazar', '9137', V2);
  await e.gerente('/c/enlaces', { encuestado_ids: ['e-beto', 'e-carla'], para: 'correo' });
  const filas = eventos(e.db);
  assert.ok(filas.length >= 6);
  const volcado = JSON.stringify(filas);
  for (const prohibido of ['@', '4821', '9137', beto.k, 'tokencarla', 'Texto secreto', 'compras', CLAVE_GERENTE]) assert.ok(!volcado.includes(prohibido), 'aparece ' + prohibido);
  filas.forEach(f => Object.keys(JSON.parse(f.detalle)).forEach(k => assert.ok(DETALLE_PERMITIDO.includes(k), k)));
  assert.deepEqual(Object.keys(filas[0]).sort(), ['actor_id', 'actor_tipo', 'campana_id', 'canal', 'clave', 'creado', 'detalle', 'gerencia', 'id', 'persona_id', 'proceso_id', 'reconstruido', 'seccion', 'tipo', 'visitante']);
});
