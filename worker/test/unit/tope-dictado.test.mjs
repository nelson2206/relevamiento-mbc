// Tope diario de dictado por voz: suma mientras cabe y, al pasarse, corta sin registrar el audio rechazado.   node --test test/unit/tope-dictado.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { reservarAudioIA } from '../../src/index.js';
import { crearD1 } from './d1-memoria.mjs';

const { d1, db } = crearD1();
const env = { DB: d1, IA_MINUTOS_DIA: '1' };
const uso = () => db.prepare('SELECT segundos, llamadas FROM uso_ia').get();

test('suma el audio mientras quepa en el tope', async () => {
  await reservarAudioIA(env, 40);
  await reservarAudioIA(env, 20);
  assert.equal(uso().segundos, 60);
  assert.equal(uso().llamadas, 2);
});

test('al pasarse responde 429 con el aviso y no suma el audio rechazado', async () => {
  await assert.rejects(reservarAudioIA(env, 1), e => e.status === 429 && /límite de hoy/.test(e.message));
  assert.equal(uso().segundos, 60);
  assert.equal(uso().llamadas, 2);
});

test('sin configuración usa el tope por defecto de 1.000 minutos', async () => {
  const otro = crearD1();
  await reservarAudioIA({ DB: otro.d1 }, 60000);
  await assert.rejects(reservarAudioIA({ DB: otro.d1 }, 1), /límite de hoy/);
});
