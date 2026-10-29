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
    run: async () => { db.prepare(sql).run(...args); return { success: true }; }
  });
  const d1 = { prepare: sql => stmt(sql), batch: async ss => { for (const s of ss) await s.run(); return []; } };
  const sinComentarios = t => t.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
  db.exec(sinComentarios(readFileSync(join(raiz, 'schema.sql'), 'utf8')));
  // schema.sql trae el estado final: las migraciones no se repiten aquí (test/unit/esquema.test.mjs comprueba que no haya desfase).
  return { d1, db };
}

