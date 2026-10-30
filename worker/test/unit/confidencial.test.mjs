// Pregunta 3 de la encuesta: «¿El proceso gestiona información altamente confidencial?» (estructurada: Sí/No, cuál y dónde se almacena).
//   node --test test/unit/confidencial.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/index.js';
import { limpiarDatos, evaluar, resumenTexto, UBICACIONES } from '../../src/confidencial.js';
import { crearCobertura } from '../../src/cobertura.js';
import { crearD1 } from './d1-memoria.mjs';

const ORIGEN = 'http://prueba.local', ADMIN = 'admin-de-prueba-123', CODIGO = 'abcdefghij';
const G = 'Gerencia Legal', S = 'Sección Legal';
const { d1, db } = crearD1();
const env = { DB: d1, ALLOWED_ORIGINS: ORIGEN, ADMIN_CODE: ADMIN };
const H = { origin: ORIGEN, 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.6' };

async function llamar(metodo, ruta, cuerpo, cab = {}) {
  const r = await worker.fetch(new Request('http://worker.local' + ruta, { method: metodo, body: cuerpo ? JSON.stringify(cuerpo) : undefined, headers: { ...H, ...cab } }), env, { waitUntil() {} });
  return { status: r.status, ...(await r.json()) };
}
const admin = (m, ruta, c) => llamar(m, ruta, c, { 'x-admin-code': ADMIN });
const sesion = k => llamar('GET', '/r/sesion?k=' + k);
const fila = (pid, pregunta) => db.prepare('SELECT * FROM respuestas WHERE proceso_id=? AND pregunta=?').get(pid, pregunta);
let maria;

test('preparación: una persona y un proceso en su sección', async () => {
  db.prepare("INSERT INTO campanas (id, nombre, cliente, creada, codigo_publico, abierta) VALUES ('c1','Prueba','Toyota',?,?,1)").run(new Date().toISOString(), CODIGO);
  db.prepare("INSERT INTO procesos (id, campana_id, gerencia, seccion, proceso, fuente) VALUES ('p1','c1',?,?,'Contratos','inventario')").run(G, S);
  maria = (await llamar('POST', '/r/registro', { c: CODIGO, nombre: 'María Quispe', gerencia: G, seccion: S, pin: '1234', fija: true })).k;
  assert.ok(maria);
});

test('reglas puras: «No» basta; «Sí» pide cuál, una ubicación y el detalle de «Otro»', () => {
  assert.deepEqual(evaluar({}).faltan.length, 1);
  assert.equal(evaluar({ confidencial: 'no' }).completo, true);
  assert.equal(evaluar({ confidencial: 'si' }).faltan.length, 2);
  assert.equal(evaluar({ confidencial: 'si', cual: 'Nómina' }).faltan[0], 'Marca dónde se almacena');
  assert.equal(evaluar({ confidencial: 'si', cual: 'Nómina', ubicaciones: ['otro'] }).completo, false);
  assert.equal(evaluar({ confidencial: 'si', cual: 'Nómina', ubicaciones: ['otro'], otro: 'Disco externo' }).completo, true);
  assert.equal(evaluar({ confidencial: 'si', cual: 'Nómina', ubicaciones: ['correo', 'sharepoint'] }).completo, true);
});

test('limpiarDatos descarta lo que no corresponde y ubicaciones inventadas', () => {
  assert.deepEqual(limpiarDatos({ confidencial: 'no', cual: 'x', ubicaciones: ['correo'], otro: 'y' }), { confidencial: 'no', cual: '', ubicaciones: [], otro: '' });
  assert.deepEqual(limpiarDatos({ confidencial: 'tal vez' }), { confidencial: '', cual: '', ubicaciones: [], otro: '' });
  const d = limpiarDatos({ confidencial: 'si', cual: ' Nómina ', ubicaciones: ['correo', 'correo', 'nube_x', 'sharepoint'], otro: 'se ignora' });
  assert.deepEqual(d.ubicaciones, ['correo', 'sharepoint']); assert.equal(d.otro, ''); assert.equal(d.cual, 'Nómina');
  assert.equal(UBICACIONES.length, 8);
});

test('resumenTexto: legible, con «Otro» detallado', () => {
  assert.equal(resumenTexto({}), '');
  assert.equal(resumenTexto({ confidencial: 'no' }), 'No gestiona información altamente confidencial.');
  assert.equal(resumenTexto({ confidencial: 'si', cual: 'Nómina', ubicaciones: ['sharepoint', 'otro'], otro: 'Disco externo' }),
    'Gestiona información altamente confidencial: Nómina. Se almacena en: SharePoint / Teams, Otro: Disco externo.');
});

test('la encuesta recibe la pregunta como la 3.ª, entre «Sistemas y terceros» y «Datos personales…», y la de datos personales sigue siendo b3', async () => {
  const s = await sesion(maria);
  assert.deepEqual(s.bloques.map(b => b.id), ['b1', 'b2', 'bconf', 'b3']);
  assert.equal(s.bloques[2].tipo, 'estructurada'); assert.equal(s.bloques[2].puntos.length, 1);
  assert.equal(s.bloques.reduce((a, b) => a + b.puntos.length, 0), 17, 'el punto nuevo suma al checklist (16 → 17)');
});

test('una respuesta a medias se guarda pero NO cubre el punto', async () => {
  const r = await llamar('POST', '/r/respuesta', { k: maria, proceso_id: 'p1', pregunta: 'bconf', datos: { confidencial: 'si' } });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.completo, false); assert.equal(r.faltan.length, 2);
  assert.equal(r.checklist.confidencial, undefined);
  assert.equal(JSON.parse(fila('p1', 'bconf').datos).confidencial, 'si');
  assert.equal((await sesion(maria)).respuestas.p1.bconf.datos.confidencial, 'si', 'al volver a entrar se conserva lo marcado');
});

test('completa («Sí» con cuál, ubicaciones y detalle de «Otro») cubre el punto', async () => {
  let r = await llamar('POST', '/r/respuesta', { k: maria, proceso_id: 'p1', pregunta: 'bconf', datos: { confidencial: 'si', cual: 'Nómina y contratos estratégicos', ubicaciones: ['sharepoint', 'otro'] } });
  assert.equal(r.completo, false); assert.match(r.faltan[0], /otro lugar/);
  r = await llamar('POST', '/r/respuesta', { k: maria, proceso_id: 'p1', pregunta: 'bconf', datos: { confidencial: 'si', cual: 'Nómina y contratos estratégicos', ubicaciones: ['sharepoint', 'otro'], otro: 'Disco externo' } });
  assert.equal(r.completo, true);
  assert.equal(r.checklist.confidencial.estado, 'cubierto'); assert.equal(r.checklist.confidencial.fuente, 'persona');
  assert.equal((await sesion(maria)).respuestas.p1.bconf.checklist.confidencial.estado, 'cubierto');
});

test('pasar de «Sí» a «No» limpia lo anterior y sigue cubierto; borrar la respuesta lo descubre', async () => {
  let r = await llamar('POST', '/r/respuesta', { k: maria, proceso_id: 'p1', pregunta: 'bconf', datos: { confidencial: 'no', cual: 'quedó de antes', ubicaciones: ['correo'] } });
  assert.equal(r.completo, true); assert.deepEqual(r.datos, { confidencial: 'no', cual: '', ubicaciones: [], otro: '' });
  assert.equal(r.checklist.confidencial.estado, 'cubierto');
  r = await llamar('POST', '/r/respuesta', { k: maria, proceso_id: 'p1', pregunta: 'bconf', datos: { confidencial: '' } });
  assert.equal(r.completo, false); assert.equal(r.checklist.confidencial, undefined);
});

test('exige la respuesta y las preguntas de texto libre siguen funcionando igual', async () => {
  assert.equal((await llamar('POST', '/r/respuesta', { k: maria, proceso_id: 'p1', pregunta: 'bconf' })).status, 400);
  assert.equal((await llamar('POST', '/r/respuesta', { k: maria, proceso_id: 'p1', pregunta: 'b3', texto: 'Manejamos datos de proveedores.' })).status, 200);
  assert.equal((await sesion(maria)).respuestas.p1.b3.texto, 'Manejamos datos de proveedores.');
});

test('las rutas de texto libre rechazan la pregunta estructurada (voz, archivos, marcas a mano y revisión de la IA)', async () => {
  for (const [ruta, cuerpo] of [['/r/verificar', { k: maria, proceso_id: 'p1', pregunta: 'bconf' }],
    ['/r/punto', { k: maria, proceso_id: 'p1', pregunta: 'bconf', punto: 'confidencial', estado: 'cubierto' }]]) {
    const r = await llamar('POST', ruta, cuerpo);
    assert.equal(r.status, 400, ruta); assert.match(r.error, /opciones/, ruta);
  }
  const img = await worker.fetch(new Request(`http://worker.local/r/imagen?k=${maria}&proceso_id=p1&pregunta=bconf`, { method: 'POST', body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]), headers: { ...H, 'content-type': 'image/png' } }), env, { waitUntil() {} });
  assert.equal(img.status, 400);
});

test('el punto no entra a la precarga ni a los borradores de documentos', async () => {
  const r = await admin('POST', '/a/precarga', { proceso_id: 'p1', puntos: [{ punto: 'confidencial', texto: 'Sí, nómina' }] });
  assert.equal(r.status, 400, 'ignorado: no hay nada que guardar');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM precarga').get().n, 0);
});

test('la cobertura cuenta el punto nuevo: con 16 de 17 el proceso no está completo; con 17, sí', async () => {
  const { bloques } = await sesion(maria);
  const todos = bloques.flatMap(b => b.puntos.map(p => p[0]));
  const ck = ids => Object.fromEntries(ids.map(id => [id, { estado: 'cubierto', fuente: 'persona' }]));
  const resp = (ids, b) => ({ encuestado_id: 'e1', proceso_id: 'p1', pregunta: b.id, texto: 'x', sistemas: '[]', checklist: JSON.stringify(ck(ids.filter(id => b.puntos.some(p => p[0] === id)))) });
  const calcular = ids => crearCobertura({ bloques, revisiones: [{ encuestado_id: 'e1', proceso_id: 'p1', estado: 'vigente' }], respuestas: bloques.map(b => resp(ids, b)), precarga: [] })('p1');
  assert.equal(calcular(todos.filter(id => id !== 'confidencial')).estado, 'en_curso');
  assert.equal(calcular(todos).estado, 'respondido');
  assert.equal(calcular(todos).total, 17);
});

test('borrar un proceso con respuestas sigue bloqueado, también con la pregunta estructurada', async () => {
  assert.equal(db.prepare("SELECT COUNT(*) n FROM respuestas WHERE pregunta='bconf'").get().n, 1);
  const r = await admin('POST', '/a/proceso/borrar', { proceso_id: 'p1' });
  assert.equal(r.status, 409, 'con respuestas de texto no se puede borrar: la guarda de siempre sigue en pie');
});

// ---------------------------------------------------------------- responder con voz o con un archivo
import { desdeSalidaIA, ESQUEMA_IA, PROMPT_IA } from '../../src/confidencial.js';

test('la salida de la IA se limpia: ids inventados fuera, «Otro» sin detalle queda incompleto y lo no relevante no marca nada', () => {
  const ok = desdeSalidaIA({ relevante: true, motivo: '', confidencial: 'si', cual: 'Nómina', ubicaciones: ['onedrive', 'nube_x', 'otro'], otro: 'USB' });
  assert.deepEqual(ok.datos, { confidencial: 'si', cual: 'Nómina', ubicaciones: ['onedrive', 'otro'], otro: 'USB' }); assert.equal(ok.completo, true);
  const sinOtro = desdeSalidaIA({ relevante: true, confidencial: 'si', cual: 'Nómina', ubicaciones: ['otro'], otro: '' });
  assert.equal(sinOtro.completo, false); assert.match(sinOtro.faltan[0], /otro lugar/);
  const no = desdeSalidaIA({ relevante: true, confidencial: 'no', cual: 'x', ubicaciones: ['correo'] });
  assert.deepEqual(no.datos, { confidencial: 'no', cual: '', ubicaciones: [], otro: '' }); assert.equal(no.completo, true);
  const nada = desdeSalidaIA({ relevante: false, motivo: 'Se habla de otra cosa', confidencial: 'si', cual: 'Nómina' });
  assert.equal(nada.datos.confidencial, ''); assert.equal(nada.motivo, 'Se habla de otra cosa'); assert.equal(nada.completo, false);
  assert.equal(desdeSalidaIA(null).datos.confidencial, '');
});

test('el esquema y las instrucciones de la IA usan exactamente las ubicaciones de la pregunta', () => {
  const ids = UBICACIONES.map(u => u[0]);
  assert.deepEqual(ESQUEMA_IA.properties.ubicaciones.items.enum, ids);
  ids.forEach(id => assert.ok(PROMPT_IA.includes(id + ' = '), id));
  assert.match(PROMPT_IA, /cero alucinación/);
  assert.deepEqual(ESQUEMA_IA.properties.confidencial.enum, ['si', 'no', '']);
});

test('POST /r/confidencial: pide texto; sin la IA configurada responde un error claro (marcar a mano sigue disponible) y no guarda nada', async () => {
  assert.equal((await llamar('POST', '/r/confidencial', { k: maria, proceso_id: 'p1', texto: '   ' })).status, 400);
  const r = await llamar('POST', '/r/confidencial', { k: maria, proceso_id: 'p1', texto: 'Sí, manejamos la nómina y está en SharePoint.' });
  assert.equal(r.status, 502); assert.match(r.error, /No pudimos interpretar/);
  const antes = fila('p1', 'bconf');
  assert.ok(!antes || JSON.parse(antes.datos).confidencial === '', 'interpretar solo propone: no escribe la respuesta');
  assert.equal((await llamar('POST', '/r/confidencial', { k: 'inexistente', proceso_id: 'p1', texto: 'x' })).status, 401);
});

test('/r/imagen: la finalidad «confidencial» es solo de la pregunta de opciones y valida el archivo antes de llamar a la IA', async () => {
  const subir = (pregunta, extra, tipo, cuerpo) => worker.fetch(new Request(`http://worker.local/r/imagen?k=${maria}&proceso_id=p1&pregunta=${pregunta}${extra}`,
    { method: 'POST', body: cuerpo, headers: { ...H, 'content-type': tipo } }), env, { waitUntil() {} }).then(r => r.status);
  assert.equal(await subir('b1', '&finalidad=confidencial', 'image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])), 400, 'una pregunta de texto no acepta esa finalidad');
  assert.equal(await subir('bconf', '', 'image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])), 400, 'la de opciones exige la finalidad');
  assert.equal(await subir('bconf', '&finalidad=confidencial', 'text/plain', new Uint8Array([1, 2, 3])), 415, 'tipo de archivo no permitido');
  assert.equal(await subir('bconf', '&finalidad=confidencial', 'image/png', new Uint8Array([1, 2, 3, 4])), 415, 'imagen dañada');
  assert.equal(await subir('bconf', '&finalidad=confidencial', 'image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])), 502, 'archivo válido pero sin IA configurada');
});
