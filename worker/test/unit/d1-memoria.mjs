// Base de pruebas sin servidor: SQLite en memoria (node:sqlite) con la interfaz mínima de D1 y el esquema real (schema.sql, que ya incluye todas las migraciones).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Interfaz mínima de D1 (prepare/bind/first/all/run y batch) sobre node:sqlite.
export function crearD1() {
  const db = new DatabaseSync(':memory:');
  const clon = f => (f ? { ...f } : null);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a.map(x => (x === undefined ? null : x))),
    first: async () => clon(db.prepare(sql).get(...args)),
    all: async () => ({ results: db.prepare(sql).all(...args).map(clon) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; }
  });
  const d1 = { prepare: sql => stmt(sql), batch: async ss => { const out = []; for (const s of ss) out.push(await s.run()); return out; } };
  const sinComentarios = t => t.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
  db.exec(sinComentarios(readFileSync(join(raiz, 'schema.sql'), 'utf8')));
  // schema.sql trae el estado final: las migraciones no se repiten aquí (test/unit/esquema.test.mjs comprueba que no haya desfase).
  return { d1, db };
}

