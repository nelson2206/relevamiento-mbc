// Datos de demostración para revisar el funnel de trazabilidad: empresa FICTICIA, fechas relativas a hoy (la inactividad se ve siempre).
//   node test/semilla-funnel.mjs                              → carga la campaña «Demo funnel de trazabilidad» en la base LOCAL de wrangler (la borra y la vuelve a crear)
//   node test/semilla-funnel.mjs --persist-to .wrangler/pruebas → si el servidor se levantó con --persist-to (debe apuntar a la misma carpeta que wrangler dev)
// Panel del cliente: clave DemoFunnel2026 (administrador) o GerenteLog2026 (Gerente de Logística: solo ve su gerencia).
// Las personas de la demo no tienen PIN real: sirven para el panel y el Excel, no para entrar a la encuesta.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hashClaveSup } from '../src/usuarios.js';

const aqui = dirname(fileURLToPath(import.meta.url)), raiz = join(aqui, '..');
const iPersist = process.argv.indexOf('--persist-to'), PERSIST = iPersist > 0 ? process.argv[iPersist + 1] : '';
const C = 'demo-funnel', CLAVE_CLIENTE = 'DemoFunnel2026', CLAVE_GERENTE = 'GerenteLog2026';
const hace = (d, h = 0) => new Date(Date.now() - d * 86400000 - h * 3600000).toISOString();
const q = s => "'" + String(s).replace(/'/g, "''") + "'";

const PUNTOS = { b1: ['objetivo', 'riesgos', 'inicio_fin', 'actividades', 'manual_sistema', 'aprobaciones', 'carga'], b2: ['sistemas', 'terceros'], bconf: ['confidencial'],
  b3: ['datos_personales', 'finalidad_dp', 'documentacion', 'estandar_tdp', 'estandar_global', 'normativa', 'kpis'] };
const ck = ids => JSON.stringify(Object.fromEntries(ids.map(i => [i, { estado: 'cubierto', fuente: 'persona' }])));

// gerencia → sección → nombres de proceso
const PROCESOS = {
  'Logística': { Miniproyectos: ['Planificación de miniproyectos', 'Seguimiento de avance', 'Cierre de miniproyectos', 'Control de costos'], 'Almacén': ['Recepción de mercadería', 'Almacenamiento', 'Inventario cíclico'],
    'Distribución': ['Despacho', 'Ruteo', 'Entrega al cliente'] },
  Compras: { Pagos: ['Programación de pagos', 'Conciliación de proveedores'] },
  Finanzas: { 'Tesorería': ['Flujo de caja', 'Conciliación bancaria'] },
  RRHH: { 'Selección': ['Reclutamiento', 'Incorporación'] }
};
const sql = [];
sql.push(`DELETE FROM respuestas WHERE encuestado_id IN (SELECT id FROM encuestados WHERE campana_id=${q(C)})`,
  `DELETE FROM revisiones WHERE encuestado_id IN (SELECT id FROM encuestados WHERE campana_id=${q(C)})`,
  `DELETE FROM asignaciones WHERE encuestado_id IN (SELECT id FROM encuestados WHERE campana_id=${q(C)})`);
['eventos', 'delegaciones', 'supervisores', 'encuestados', 'procesos', 'acciones', 'campanas'].forEach(t => sql.push(`DELETE FROM ${t} WHERE ${t === 'campanas' ? 'id' : 'campana_id'}=${q(C)}`));
sql.push(`INSERT INTO campanas (id, nombre, cliente, creada, codigo_publico, abierta, codigo_cliente, cliente_activo) VALUES (${q(C)}, 'Demo funnel de trazabilidad', 'Empresa Demo', ${q(hace(12))}, 'DEMOFUNNEL', 1, ${q(CLAVE_CLIENTE)}, 1)`);

const proc = {};   // "ger|sec|n" → id
let n = 0;
Object.entries(PROCESOS).forEach(([g, secs]) => Object.entries(secs).forEach(([s, lista]) => lista.forEach((nombre, i) => {
  const id = `${C}-p${++n}`; proc[`${g}|${s}|${i}`] = id;
  const validado = g === 'Finanzas';
  sql.push(`INSERT INTO procesos (id, campana_id, codigo, gerencia, seccion, macroproceso, proceso, subproceso, fuente, orden, validacion, validado_por, validado_en) VALUES (${q(id)}, ${q(C)}, ${q('DEM-' + String(n).padStart(2, '0'))}, ${q(g)}, ${q(s)}, ${q(s)}, ${q(nombre)}, '', 'inventario', ${n}, ${q(validado ? 'validado' : '')}, ${q(validado ? 'Consultor MBC' : '')}, ${validado ? q(hace(3)) : 'NULL'})`);
})));

let ev = 0;
const evento = (tipo, { actor = 'persona', persona = '', g = '', s = '', proceso = '', visitante = '', clave = null, cuando }) =>
  sql.push(`INSERT INTO eventos (id, campana_id, tipo, actor_tipo, actor_id, persona_id, gerencia, seccion, proceso_id, canal, visitante, reconstruido, clave, detalle, creado) VALUES (${q('ev-' + (++ev))}, ${q(C)}, ${q(tipo)}, ${q(actor)}, ${q(persona)}, ${q(persona)}, ${q(g)}, ${q(s)}, ${q(proceso)}, '', ${q(visitante)}, 0, ${clave ? q(clave) : 'NULL'}, '{}', ${q(cuando)})`);
const uuid = k => `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`;
let vis = 0;

// nombre, gerencia, sección, creado (días), última actividad (días), registrada, confirmados [procesos de la sección], nuevos, estado por proceso, terminé
// estado: 'C' completo · 'A' avanzado (2 preguntas) · 'I' iniciado (1 pregunta) · '-' sin respuestas
const PERSONAS = [
  ['Pepito Rojas', 'Logística', 'Miniproyectos', 8, 2, true, [0, 1, 2], 2, 'CCACC', false],
  ['Lucía Ramos', 'Logística', 'Miniproyectos', 9, 1, true, [0, 1, 2, 3], 0, 'CCCC', true],
  ['Marco Díaz', 'Logística', 'Almacén', 7, 3, true, [0, 1], 1, 'CCC', true],
  ['Carla Núñez', 'Logística', 'Almacén', 14, 9, true, [0, 1, 2], 0, '---', false],
  ['Diego Paz', 'Logística', 'Distribución', 13, 8, true, [0], 1, 'CC', false],
  ['Ana Torres', 'Logística', 'Distribución', 6, 0, true, [0, 1], 1, 'CCC', false],
  ['Rosa Vega', 'Compras', 'Pagos', 7, 2, true, [0, 1], 0, 'CI', false],
  ['Tito León', 'Compras', 'Pagos', 5, 5, false, [], 0, '', false],
  ['Elena Ruiz', 'Finanzas', 'Tesorería', 10, 6, true, [0, 1], 0, 'CC', true],
  ['Hugo Soto', 'RRHH', 'Selección', 9, 9, false, [], 0, '', false]
];
const completo = Object.entries(PUNTOS);
const respuestas = (eid, pid, estado, dias) => {
  const filas = estado === 'C' ? completo : estado === 'A' ? completo.slice(0, 2) : estado === 'I' ? completo.slice(0, 1).map(([b, ids]) => [b, ids.slice(0, 2)]) : [];
  filas.forEach(([b, ids]) => sql.push(`INSERT INTO respuestas (encuestado_id, proceso_id, pregunta, texto, checklist, actualizado) VALUES (${q(eid)}, ${q(pid)}, ${q(b)}, 'texto de ejemplo', ${q(ck(ids))}, ${q(hace(dias))})`));
};

PERSONAS.forEach(([nombre, g, s, creado, ultima, registrada, conf, nuevos, estados, termine], i) => {
  const id = `${C}-e${i + 1}`, token = `demofunnel-token-${String(i + 1).padStart(2, '0')}-0123456789`;
  const estadoEnc = termine ? 'enviado' : registrada && estados.replace(/-/g, '') ? 'en_curso' : 'pendiente';
  sql.push(`INSERT INTO encuestados (id, campana_id, token, nombre, correo, gerencia, seccion, estado, actualizado, origen, creado, pin_hash, pin_sal, ultimo_acceso) VALUES (${q(id)}, ${q(C)}, ${q(token)}, ${q(nombre)}, '', ${q(g)}, ${q(s)}, ${q(estadoEnc)}, ${q(hace(ultima))}, 'carga', ${q(hace(creado))}, ${q(registrada ? 'demo' : '')}, ${q(registrada ? 'demo' : '')}, ${registrada ? q(hace(ultima)) : 'NULL'})`);
  const lista = conf.map(k => proc[`${g}|${s}|${k}`]);
  for (let k = 0; k < nuevos; k++) {   // procesos que la persona creó
    const pid = `${id}-n${k + 1}`; lista.push(pid);
    sql.push(`INSERT INTO procesos (id, campana_id, codigo, gerencia, seccion, proceso, fuente, creado_por, orden) VALUES (${q(pid)}, ${q(C)}, '', ${q(g)}, ${q(s)}, ${q('Proceso nuevo de ' + nombre.split(' ')[0] + ' ' + (k + 1))}, 'nuevo', ${q(id)}, ${900 + k})`);
  }
  lista.forEach((pid, k) => {
    sql.push(`INSERT INTO revisiones (encuestado_id, proceso_id, estado, actualizado) VALUES (${q(id)}, ${q(pid)}, 'vigente', ${q(hace(creado - 1))})`);
    respuestas(id, pid, estados[k] || '-', ultima);
  });
  if (registrada) {
    const v = uuid(++vis);
    evento('enlace_abierto', { actor: 'anonimo', g, s, visitante: v, cuando: hace(creado - 1, 1) });
    evento('persona_identificada', { persona: id, g, s, visitante: v, cuando: hace(creado - 1) });
    evento('acceso_creado', { persona: id, g, s, visitante: v, clave: 'acceso_creado|' + id, cuando: hace(creado - 1) });
    if (estados.replace(/-/g, '')) evento('primera_respuesta', { persona: id, g, s, proceso: lista[0], clave: `primera_respuesta|${id}|${lista[0]}`, cuando: hace(Math.max(ultima, 2) + 1) });
    if (termine) evento('encuesta_terminada', { persona: id, g, s, clave: 'encuesta_terminada|' + id, cuando: hace(ultima) });
  }
});
// Visitantes que abrieron el enlace y no se identificaron (cuentan en «Ingreso al enlace»).
[['Logística', 'Miniproyectos', 2], ['Logística', 'Almacén', 1], ['Logística', 'Distribución', 1], ['Compras', 'Pagos', 2], ['RRHH', 'Selección', 1]].forEach(([g, s, k]) => {
  for (let j = 0; j < k; j++) evento('enlace_abierto', { actor: 'anonimo', g, s, visitante: uuid(++vis), cuando: hace(3 + j) });
});

const gerenteId = `${C}-sup1`;
sql.push(`INSERT INTO supervisores (id, campana_id, nombre, clave_hash, activo, alcance, creado, perfil) VALUES (${q(gerenteId)}, ${q(C)}, 'Gerente de Logística', ${q(await hashClaveSup(CLAVE_GERENTE))}, 1, ${q(JSON.stringify({ todo: false, gerencias: ['Logística'] }))}, ${q(hace(12))}, 'gerente')`);

const dir = mkdtempSync(join(tmpdir(), 'semilla-funnel-')), archivo = join(dir, 'semilla.sql');
writeFileSync(archivo, sql.join(';\n') + ';\n', 'utf8');
const wrangler = args => { const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'voz-relevamiento', '-c', 'wrangler.local.toml', '--local', ...(PERSIST ? ['--persist-to', PERSIST] : []), ...args], { cwd: raiz, shell: true, encoding: 'utf8' }); if (r.status) { console.error(r.stdout + r.stderr); process.exit(1); } };
wrangler(['--file=schema.sql']);
wrangler([`--file=${archivo}`]);
console.log(`Listo: campaña «Demo funnel de trazabilidad» en la base local (${PERSONAS.length} personas, ${n} procesos, ${ev} eventos).\n  Administrador del cliente: ${CLAVE_CLIENTE}\n  Gerente de Logística:      ${CLAVE_GERENTE}`);
