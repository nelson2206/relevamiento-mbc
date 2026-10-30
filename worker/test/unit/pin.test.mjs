// Pruebas unitarias del PIN de 4 dígitos (sin red ni base de datos): node --test test/unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { pinValido, salNueva, hashPin, verificarPin } from '../../src/comun.js';

test('pinValido: exactamente 4 dígitos', () => {
  assert.ok(pinValido('0420'));
  for (const x of ['123', '12345', 'abcd', '12 4', '', null, undefined]) assert.equal(pinValido(x), false, String(x));
});

test('verificarPin: acepta el PIN correcto y rechaza otro, otra sal o formato inválido', async () => {
  const sal = salNueva(), h = await hashPin('1234', sal);
  assert.ok(await verificarPin('1234', sal, h));
  assert.equal(await verificarPin('1235', sal, h), false);
  assert.equal(await verificarPin('1234', salNueva(), h), false);
  assert.equal(await verificarPin('12', sal, h), false);
  assert.equal(await verificarPin('1234', '', ''), false);
});

test('hashPin: la sal distinta da huella distinta y el PIN no aparece en ella', async () => {
  const a = await hashPin('1234', salNueva()), b = await hashPin('1234', salNueva());
  assert.notEqual(a, b);
  assert.ok(!a.includes('1234') || a.length === 64);
});
