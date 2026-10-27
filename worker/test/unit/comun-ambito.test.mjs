// Pruebas unitarias de comun.js y ambito.js (sin red ni base de datos): node --test test/unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, txt, normal, mismaArea } from '../../src/comun.js';
import { ambitoSobre, enSecs, claveArea, alcanceDe, esIncorporado } from '../../src/ambito.js';

test('normal: sin mayúsculas, tildes ni espacios repetidos', () => {
  assert.equal(normal('  Importación   DE  Vehículos '), 'importacion de vehiculos');
  assert.equal(normal(null), '');
  assert.equal(normal(undefined), '');
  assert.equal(normal(0), '0');
});

test('normal: comportamiento conocido: la eñe se trata como n (Año y Ano coinciden)', () => {
  // Documenta el comportamiento actual: NFD separa la tilde de la ñ. Para nombres de áreas es inocuo, pero dos nombres que solo difieran en ñ/n se unificarían.
  assert.equal(normal('Compañía'), normal('Compania'));
});

test('mismaArea ignora mayúsculas y tildes', () => {
  assert.ok(mismaArea('Control Interno', 'control  interno'));
  assert.ok(mismaArea('Logística', 'LOGISTICA'));
  assert.ok(!mismaArea('Logística', 'Logística 2'));
});

test('txt recorta, limita y tolera valores raros', () => {
  assert.equal(txt('  hola  ', 10), 'hola');
  assert.equal(txt('abcdefghij', 4), 'abcd');
  assert.equal(txt(null), '');
  assert.equal(txt(undefined, 5), '');
  assert.equal(txt(12345, 3), '123');
  assert.equal(txt('x'.repeat(600)).length, 500, 'el límite por defecto es 500');
});

test('HttpError lleva status y datos extra (para el 409 con confirmación)', () => {
  const e = new HttpError(409, 'msg', { requiere_confirmacion: true, se_reiniciaran: [2, 3] });
  assert.equal(e.status, 409);
  assert.equal(e.message, 'msg');
  assert.deepEqual(e.extra.se_reiniciaran, [2, 3]);
  assert.deepEqual(new HttpError(400, 'x').extra, {});
  assert.ok(e instanceof Error);
});

const filas = [
  { id: 'p1', gerencia: 'Operaciones', seccion: 'Planta' }, { id: 'p2', gerencia: 'Operaciones', seccion: 'Logística' },
  { id: 'p3', gerencia: 'Finanzas', seccion: 'Tesorería' }, { id: 'p4', gerencia: 'Finanzas', seccion: 'Contabilidad' }, { id: 'p5', gerencia: 'Legal', seccion: 'Contratos' }
];
const sup = al => ({ rol: 'supervisor', sup: { alcance: JSON.stringify(al) } });

test('ambitoSobre: el administrador del cliente ve todo', () => {
  const a = ambitoSobre({ rol: 'cliente' }, filas);
  assert.equal(a.procs.size, 5);
  assert.equal(a.secs, null);
  assert.ok(enSecs(a, 'Cualquiera', 'Cosa'), 'secs = null significa todas las secciones');
});

test('ambitoSobre: por gerencia, por sección y por proceso suelto', () => {
  assert.deepEqual([...ambitoSobre(sup({ gerencias: ['finanzas'] }), filas).procs].sort(), ['p3', 'p4']);
  assert.deepEqual([...ambitoSobre(sup({ secciones: [{ g: 'Operaciones', s: 'planta' }] }), filas).procs], ['p1']);
  assert.deepEqual([...ambitoSobre(sup({ procesos: ['p5'] }), filas).procs], ['p5']);
  assert.deepEqual([...ambitoSobre(sup({ gerencias: ['Legal'], procesos: ['p1'] }), filas).procs].sort(), ['p1', 'p5']);
});

test('ambitoSobre: acceso total y alcance vacío o dañado', () => {
  assert.equal(ambitoSobre(sup({ todo: true }), filas).procs.size, 5);
  assert.equal(ambitoSobre(sup({}), filas).procs.size, 0, 'sin alcance no ve nada');
  assert.equal(ambitoSobre({ rol: 'supervisor', sup: { alcance: 'no es json' } }, filas).procs.size, 0, 'un JSON dañado no rompe ni da acceso');
  assert.equal(ambitoSobre({ rol: 'supervisor', sup: { alcance: 'null' } }, filas).procs.size, 0);
  assert.equal(ambitoSobre({ rol: 'supervisor', sup: {} }, filas).procs.size, 0, 'sin campo alcance tampoco');
});

test('enSecs respeta las secciones del alcance', () => {
  const a = ambitoSobre(sup({ gerencias: ['Finanzas'] }), filas);
  assert.ok(enSecs(a, 'FINANZAS', 'tesoreria'));
  assert.ok(!enSecs(a, 'Operaciones', 'Planta'));
});

test('claveArea es estable entre escrituras distintas', () => {
  assert.equal(claveArea('Logística', 'Importaciones'), claveArea('LOGISTICA', ' importaciones '));
  assert.notEqual(claveArea('A', 'B'), claveArea('AB', ''));
});

test('alcanceDe tolera JSON roto y campos faltantes', () => {
  assert.deepEqual(alcanceDe({ alcance: '{"todo":true}' }), { todo: true, gerencias: [], secciones: [], procesos: [] });
  assert.deepEqual(alcanceDe({ alcance: 'basura' }), { todo: false, gerencias: [], secciones: [], procesos: [] });
  assert.deepEqual(alcanceDe({}), { todo: false, gerencias: [], secciones: [], procesos: [] });
});

test('esIncorporado: solo si está suelto y no lo cubre su gerencia o sección', () => {
  const p = { id: 'p3', gerencia: 'Finanzas', seccion: 'Tesorería' };
  assert.ok(esIncorporado({ alcance: JSON.stringify({ procesos: ['p3'] }) }, p), 'suelto de otra gerencia');
  assert.ok(!esIncorporado({ alcance: JSON.stringify({ gerencias: ['finanzas'], procesos: ['p3'] }) }, p), 'si su gerencia ya lo cubre, no es incorporado');
  assert.ok(!esIncorporado({ alcance: JSON.stringify({ secciones: [{ g: 'Finanzas', s: 'tesoreria' }], procesos: ['p3'] }) }, p), 'ni si lo cubre su sección');
  assert.ok(!esIncorporado({ alcance: JSON.stringify({ procesos: ['otro'] }) }, p));
  assert.ok(!esIncorporado({ alcance: JSON.stringify({ todo: true, procesos: ['p3'] }) }, p), 'con acceso total nada es incorporado');
});
