// Prueba de las rutas de ingreso con PIN sin servidor: el Worker se invoca directamente (worker.fetch) sobre una base SQLite en
// memoria (node:sqlite) con la interfaz mínima de D1. Cubre registro, reingreso, bloqueo a los 5 intentos y desbloqueo.
//   node --test test/unit/acceso-pin.test.mjs
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import worker from '../../src/index.js';
import { crearD1 } from './d1-memoria.mjs';


const ORIGEN = 'http://prueba.local', ADMIN = 'admin-de-prueba-123';
const { d1, db } = crearD1();
const env = { DB: d1, ALLOWED_ORIGINS: ORIGEN, ADMIN_CODE: ADMIN };
const CODIGO = 'abcdefghij', G = 'Gerencia Legal', S = 'Sección Legal';

async function llamar(metodo, ruta, cuerpo, cab = {}) {
  const req = new Request('http://worker.local' + ruta, {
    method: metodo, body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    headers: { origin: ORIGEN, 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...cab }
  });
  const r = await worker.fetch(req, env, { waitUntil() {} });
  return { status: r.status, ...(await r.json()) };
}
const abierta = () => llamar('GET', `/r/abierta?c=${CODIGO}&g=${encodeURIComponent(G)}&s=${encodeURIComponent(S)}`);
const registro = (nombre, pin) => llamar('POST', '/r/registro', { c: CODIGO, nombre, gerencia: G, seccion: S, pin, fija: true });
const entrar = (id, pin) => llamar('POST', '/r/identificar', { c: CODIGO, id, pin });
const admin = (ruta, cuerpo) => llamar('POST', ruta, cuerpo, { 'x-admin-code': ADMIN });
const idDe = async nombre => (await abierta()).seccion.responsables.find(r => r.nombre === nombre).id;

test('preparación: campaña abierta con 3 procesos en la sección', async () => {
  db.prepare("INSERT INTO campanas (id, nombre, cliente, creada, codigo_publico, abierta) VALUES ('c1','Prueba','Toyota',?,?,1)").run(new Date().toISOString(), CODIGO);
  ['Proceso A', 'Proceso B', 'Proceso C'].forEach((p, i) => db.prepare("INSERT INTO procesos (id, campana_id, gerencia, seccion, proceso, fuente) VALUES (?, 'c1', ?, ?, ?, 'inventario')").run('p' + i, G, S, p));
  const j = await abierta();
  assert.equal(j.ok, true);
  assert.deepEqual(j.seccion.responsables, []);
});

test('registro: exige un PIN de 4 dígitos y no pide correo', async () => {
  for (const pin of [undefined, '', '12', 'abcd', '12345']) {
    const r = await registro('Ana Salazar', pin);
    assert.equal(r.status, 400, 'pin ' + pin);
    assert.equal(r.requierePin, 'crear');
  }
  const r = await registro('Ana Salazar', '1234');
  assert.equal(r.status, 200);
  assert.ok(r.k && r.k.length >= 12);
  const fila = db.prepare("SELECT pin_hash, pin_sal, correo, ultimo_acceso FROM encuestados WHERE token=?").get(r.k);
  assert.ok(fila.pin_hash && fila.pin_sal && !fila.pin_hash.includes('1234'), 'se guarda solo la huella');
  assert.equal(fila.correo, '');
  assert.ok(fila.ultimo_acceso);
});

test('registro: rechaza un nombre repetido en la misma sección (aunque cambien mayúsculas y tildes)', async () => {
  const r = await registro('ANA  salazar', '9999');
  assert.equal(r.status, 409);
  assert.match(r.error, /elígelo en la lista/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM encuestados").get().n, 1);
});

test('la lista de la sección trae acceso y avance, y nunca tokens ni PIN', async () => {
  const j = await abierta();
  const ana = j.seccion.responsables[0];
  assert.equal(ana.nombre, 'Ana Salazar');
  assert.equal(ana.total, 3);
  assert.equal(ana.confirmados, 0);
  assert.ok(ana.acceso);
  assert.deepEqual(Object.keys(ana).sort(), ['acceso', 'confirmados', 'id', 'nombre', 'rol', 'total']);
});

test('el avance cuenta los procesos de la sección con relación marcada', async () => {
  const k = db.prepare("SELECT token FROM encuestados WHERE nombre='Ana Salazar'").get().token;
  const r = await llamar('POST', '/r/revision', { k, proceso_id: 'p0', estado: 'vigente' });
  assert.equal(r.status, 200);
  await llamar('POST', '/r/revision', { k, proceso_id: 'p1', estado: 'no_participo' });
  const ana = (await abierta()).seccion.responsables[0];
  assert.equal(ana.confirmados, 2);
  assert.equal(ana.total, 3);
});

test('reingreso: pide el PIN, rechaza el incorrecto y entrega el acceso con el correcto', async () => {
  const id = await idDe('Ana Salazar');
  assert.equal((await entrar(id)).status, 400);
  const mal = await entrar(id, '0000');
  assert.equal(mal.status, 401);
  assert.equal(mal.k, undefined, 'un PIN incorrecto no entrega el acceso');
  const bien = await entrar(id, '1234');
  assert.equal(bien.status, 200);
  assert.ok(bien.k);
  assert.equal(db.prepare('SELECT pin_fallos FROM encuestados WHERE id=?').get(id).pin_fallos, 0, 'un acierto reinicia los fallos');
});

test('reingreso: el correo ya no es una vía de ingreso', async () => {
  const r = await llamar('POST', '/r/identificar', { c: CODIGO, correo: 'ana@toyota.com.pe', pin: '1234' });
  assert.equal(r.status, 404);
  assert.equal(r.k, undefined);
});

test('5 fallos seguidos bloquean hasta que MBC desbloquee (ni el PIN correcto entra)', async () => {
  const id = await idDe('Ana Salazar');
  for (let i = 1; i <= 4; i++) assert.equal((await entrar(id, '1111')).status, 401, 'fallo ' + i);
  const quinto = await entrar(id, '1111');
  assert.equal(quinto.status, 423);
  assert.equal(quinto.bloqueado, true);
  const correcto = await entrar(id, '1234');
  assert.equal(correcto.status, 423, 'bloqueada: el PIN correcto tampoco entra');
  assert.equal(correcto.k, undefined);
  // La consola lo ve como bloqueado.
  const camp = await llamar('GET', '/a/campana?id=c1', undefined, { 'x-admin-code': ADMIN });
  const ana = camp.encuestados.find(e => e.id === id);
  assert.equal(!!ana.bloqueado, true);
  assert.equal(!!ana.tiene_pin, true);
  // Desbloqueo por MBC: conserva el PIN.
  assert.equal((await admin('/a/encuestado/pin', { encuestado_id: id, accion: 'desbloquear' })).status, 200);
  assert.equal((await entrar(id, '1234')).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM acciones WHERE accion='pin_desbloqueado'").get().n, 1);
});

test('restablecer el PIN: la persona crea uno nuevo en su próximo ingreso', async () => {
  const id = await idDe('Ana Salazar');
  assert.equal((await admin('/a/encuestado/pin', { encuestado_id: id })).status, 200);
  const sin = await entrar(id);
  assert.equal(sin.status, 400);
  assert.equal(sin.requierePin, 'crear');
  assert.equal((await entrar(id, '5678')).status, 200);
  assert.equal((await entrar(id, '1234')).status, 401, 'el PIN anterior ya no sirve');
  assert.equal((await entrar(id, '5678')).status, 200);
});

test('revocar el enlace cambia el token: el anterior deja de valer', async () => {
  const id = await idDe('Ana Salazar');
  const viejo = db.prepare('SELECT token FROM encuestados WHERE id=?').get(id).token;
  const r = await admin('/a/encuestado/pin', { encuestado_id: id, revocar_enlace: true });
  assert.equal(r.status, 200);
  assert.ok(r.k && r.k !== viejo);
  assert.equal((await llamar('GET', '/r/sesion?k=' + viejo)).status, 401);
});

test('persona cargada por Excel (sin PIN): el primero que entra crea el PIN', async () => {
  db.prepare("INSERT INTO encuestados (id, campana_id, token, nombre, gerencia, seccion, origen, creado) VALUES ('x1','c1','tokencargado0001','Luis Paredes',?,?,'carga',?)").run(G, S, new Date().toISOString());
  const sin = await entrar('x1');
  assert.equal(sin.status, 400);
  assert.equal(sin.requierePin, 'crear');
  assert.equal((await entrar('x1', '4321')).status, 200);
  assert.equal((await entrar('x1', '1234')).status, 401);
});

test('las rutas /a/ del PIN exigen el código de administración', async () => {
  const r = await llamar('POST', '/a/encuestado/pin', { encuestado_id: 'x1', accion: 'desbloquear' });
  assert.ok(r.status === 401 || r.status === 403, 'estado ' + r.status);
});

test('una ráfaga de 25 intentos en paralelo no puede probar más de 5 PIN', async () => {
  const k = (await registro('Rafaga Prueba', '1357')).k;
  assert.ok(k);
  const id = await idDe('Rafaga Prueba');
  const respuestas = await Promise.all(Array.from({ length: 25 }, (_, i) => entrar(id, String(2000 + i))));
  const comparados = respuestas.filter(r => r.status === 401).length;
  assert.ok(comparados <= 5, 'solo los primeros 5 llegan a compararse (llegaron ' + comparados + ')');
  assert.ok(respuestas.every(r => r.status === 401 || r.status === 423 || r.status === 429));
  assert.equal(respuestas.filter(r => r.k).length, 0);
  assert.equal((await entrar(id, '1357')).status, 423, 'tras la ráfaga queda bloqueada aunque ahora acierte');
  await admin('/a/encuestado/pin', { encuestado_id: id, accion: 'desbloquear' });
  assert.equal((await entrar(id, '1357')).status, 200, 'MBC la desbloquea y conserva su PIN');
});

test('dos personas que crean el PIN de la misma cuenta a la vez: solo gana la primera', async () => {
  db.prepare("INSERT INTO encuestados (id, campana_id, token, nombre, gerencia, seccion, origen, creado) VALUES ('x2','c1','tokencargado0002','Marta Cargada',?,?,'carga',?)").run(G, S, new Date().toISOString());
  const [a, b] = await Promise.all([entrar('x2', '1111'), entrar('x2', '2222')]);
  const ok = [a, b].filter(r => r.status === 200), rechazadas = [a, b].filter(r => r.status === 409);
  assert.equal(ok.length, 1);
  assert.equal(rechazadas.length, 1);
  const ganador = a.status === 200 ? '1111' : '2222';
  assert.equal((await entrar('x2', ganador)).status, 200);
});

test('un acierto antes del límite reinicia el contador de fallos', async () => {
  const id = await idDe('Ana Salazar');
  await admin('/a/encuestado/pin', { encuestado_id: id, accion: 'desbloquear' });
  assert.equal((await entrar(id, '5678')).status, 200, 'si no tenía PIN, lo crea');
  await entrar(id, '0001'); await entrar(id, '0002'); await entrar(id, '0003');
  assert.equal(db.prepare('SELECT pin_fallos FROM encuestados WHERE id=?').get(id).pin_fallos, 3);
  assert.equal((await entrar(id, '5678')).status, 200);
  assert.equal(db.prepare('SELECT pin_fallos FROM encuestados WHERE id=?').get(id).pin_fallos, 0);
});

test('cerrar sesiones activas: el enlace anterior deja de servir y la persona vuelve a entrar con su PIN', async () => {
  const id = await idDe('Ana Salazar');
  await admin('/a/encuestado/pin', { encuestado_id: id });   // PIN restablecido: lo crea de nuevo con este ingreso
  const k0 = (await entrar(id, '2468')).k;
  assert.equal((await sesion0(k0)).status, 200);
  const r = await admin('/a/campana/renovar-accesos', { campana_id: 'c1' });
  assert.equal(r.status, 200);
  assert.ok(r.personas >= 3);
  assert.equal((await sesion0(k0)).status, 401, 'el enlace anterior ya no entra');
  const k1 = (await entrar(id, '2468')).k;
  assert.ok(k1 && k1 !== k0, 'con el PIN recibe un acceso nuevo');
  assert.equal((await sesion0(k1)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM acciones WHERE accion='accesos_renovados'").get().n, 1);
});
const sesion0 = k => llamar('GET', '/r/sesion?k=' + k);

test('cerrar sesiones activas exige el código de administración y una campaña válida', async () => {
  const sin = await llamar('POST', '/a/campana/renovar-accesos', { campana_id: 'c1' });
  assert.ok(sin.status === 401 || sin.status === 403);
  assert.equal((await admin('/a/campana/renovar-accesos', { campana_id: 'no-existe' })).status, 404);
});

test('migración 018: renueva todos los tokens, sin repetidos y con la longitud mínima', async () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migracion-018.sql'), 'utf8');
  const antes = db.prepare('SELECT id, token FROM encuestados').all();
  db.exec(sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n'));
  const despues = db.prepare('SELECT id, token FROM encuestados').all();
  assert.equal(despues.length, antes.length);
  assert.equal(new Set(despues.map(x => x.token)).size, despues.length, 'todos distintos');
  assert.ok(despues.every(x => x.token.length >= 12));
  const previo = Object.fromEntries(antes.map(x => [x.id, x.token]));
  assert.ok(despues.every(x => x.token !== previo[x.id]), 'ninguno conserva su token anterior');
});
