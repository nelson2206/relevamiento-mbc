// Ayuda común de las pruebas del embudo: Worker invocado directo (worker.fetch) sobre SQLite en memoria, con ctx.waitUntil que junta las
// promesas para poder esperarlas (en producción el registro de eventos corre en segundo plano).
import worker from '../../src/index.js';
import { crearD1 } from './d1-memoria.mjs';
import { hashClaveSup } from '../../src/usuarios.js';

export const ORIGEN = 'http://prueba.local', ADMIN = 'admin-de-prueba-123', CODIGO = 'abcdefghij', G = 'Gerencia Legal', S = 'Sección Legal';
export const CLAVE_GERENTE = 'clave-gerente-1', CLAVE_CLIENTE = 'clave-cliente-1';
export const V1 = '11111111-1111-4111-8111-111111111111', V2 = '22222222-2222-4222-8222-222222222222', V3 = '33333333-3333-4333-8333-333333333333';

export function entorno(opciones = {}) {
  const { d1, db } = crearD1();
  const pend = [];
  const env = { DB: opciones.envolver ? opciones.envolver(d1) : d1, ALLOWED_ORIGINS: ORIGEN, ADMIN_CODE: ADMIN };
  const ctx = { waitUntil: p => pend.push(p) };
  const esperar = async () => { await Promise.all(pend.splice(0)); };
  async function llamar(metodo, ruta, cuerpo, cab = {}) {
    const req = new Request('http://worker.local' + ruta, {
      method: metodo, body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      headers: { origin: ORIGEN, 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...cab }
    });
    const r = await worker.fetch(req, env, ctx);
    const tipo = r.headers.get('content-type') || '';
    const salida = tipo.includes('json') ? { status: r.status, ...(await r.json()) } : { status: r.status, texto: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer()) };
    salida.cabeceras = r.headers;
    await esperar();
    return salida;
  }
  const admin = (metodo, ruta, cuerpo) => llamar(metodo, ruta, cuerpo, { 'x-admin-code': ADMIN });
  const gerente = (ruta, cuerpo) => llamar('POST', ruta, cuerpo, { 'x-client-code': CLAVE_GERENTE });
  const cliente = (ruta, cuerpo) => llamar('POST', ruta, cuerpo, { 'x-client-code': CLAVE_CLIENTE });
  return { env, db, ctx, esperar, llamar, admin, gerente, cliente };
}

// Campaña abierta con 3 procesos en la sección, dos personas precargadas por Excel (sin PIN), un gerente y el administrador del cliente.
export async function sembrar(db) {
  const t = '2026-11-01T10:00:00.000Z';
  db.prepare("INSERT INTO campanas (id, nombre, cliente, creada, codigo_publico, abierta, codigo_cliente, cliente_activo) VALUES ('c1','PRUEBA','Toyota',?,?,1,?,1)").run(t, CODIGO, CLAVE_CLIENTE);
  ['Proceso A', 'Proceso B', 'Proceso C'].forEach((p, i) => db.prepare("INSERT INTO procesos (id, campana_id, gerencia, seccion, proceso, fuente, codigo) VALUES (?, 'c1', ?, ?, ?, 'inventario', ?)").run('p' + i, G, S, p, 'PR-0' + i));
  [['e-beto', 'Beto Rojas', 'tokenbeto0123456789'], ['e-carla', 'Carla Díaz', 'tokencarla012345678']].forEach(([id, n, tk]) =>
    db.prepare("INSERT INTO encuestados (id, campana_id, token, nombre, correo, gerencia, seccion, creado) VALUES (?, 'c1', ?, ?, ?, ?, ?, ?)").run(id, tk, n, n.split(' ')[0].toLowerCase() + '@toyota.test', G, S, t));
  db.prepare("INSERT INTO supervisores (id, campana_id, nombre, clave_hash, alcance, creado, perfil) VALUES ('s-ger','c1','Gerente Legal',?,?,?,'gerente')")
    .run(await hashClaveSup(CLAVE_GERENTE), JSON.stringify({ todo: false, gerencias: [G] }), t);
}

export const eventos = (db, tipo) => db.prepare('SELECT * FROM eventos WHERE campana_id=\'c1\'' + (tipo ? ' AND tipo=?' : '') + ' ORDER BY creado, id').all(...(tipo ? [tipo] : []));
export const abierta = (e, v) => e.llamar('GET', `/r/abierta?c=${CODIGO}&g=${encodeURIComponent(G)}&s=${encodeURIComponent(S)}${v ? '&v=' + v : ''}`);
export const identificar = (e, id, pin, v) => e.llamar('POST', '/r/identificar', { c: CODIGO, id, pin, v });
export const registrar = (e, nombre, pin, v) => e.llamar('POST', '/r/registro', { c: CODIGO, nombre, gerencia: G, seccion: S, pin, fija: true, v });
export const responder = (e, k, proceso, texto) => e.llamar('POST', '/r/respuesta', { k, proceso_id: proceso, pregunta: 'b1', texto, sistemas: [] });
