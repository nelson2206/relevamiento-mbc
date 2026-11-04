// Reintentos de las llamadas al servidor (red.js), sin red: node --test test/unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { pedir, SIN_LECTURA, SIN_ESCRITURA } = createRequire(import.meta.url)('../../../red.js');

// Respuestas en orden: un número es un estado HTTP; 'corte' es el rechazo de fetch («Failed to fetch»).
function guion(pasos) {
  const d = { llamadas: 0, pausas: [], esperar: ms => { d.pausas.push(ms); return Promise.resolve(); } };
  d.fetch = () => { const p = pasos[Math.min(d.llamadas++, pasos.length - 1)]; return p === 'corte' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve({ status: p }); };
  return d;
}

test('una consulta se recupera sola tras un corte', async () => {
  const d = guion(['corte', 200]);
  assert.equal((await pedir('/a/campana', {}, d)).status, 200);
  assert.equal(d.llamadas, 2);
});

test('una consulta reintenta un 503 legible', async () => {
  const d = guion([503, 503, 200]);
  assert.equal((await pedir('/a/campana', {}, d)).status, 200);
  assert.deepEqual(d.pausas, [800, 2000]);
});

test('una consulta se rinde tras 3 intentos con un mensaje claro', async () => {
  const d = guion(['corte']);
  await assert.rejects(pedir('/a/campana', {}, d), e => e.message === SIN_LECTURA && e.sinRespuesta === true);
  assert.equal(d.llamadas, 3);
});

test('si el último intento sigue en 503, entrega la respuesta', async () => {
  const d = guion([503]);
  assert.equal((await pedir('/a/campana', {}, d)).status, 503);
  assert.equal(d.llamadas, 3);
});

test('una consulta con error del negocio no se reintenta', async () => {
  const d = guion([401]);
  assert.equal((await pedir('/a/campana', {}, d)).status, 401);
  assert.equal(d.llamadas, 1);
});

test('una escritura NUNCA se reintenta: podría duplicarse', async () => {
  const d = guion(['corte', 200]);
  await assert.rejects(pedir('/a/precarga', { method: 'POST' }, d), e => e.message === SIN_ESCRITURA);
  assert.equal(d.llamadas, 1);
  const d2 = guion([503, 200]);
  assert.equal((await pedir('/a/precarga', { method: 'POST' }, d2)).status, 503);
  assert.equal(d2.llamadas, 1);
});
