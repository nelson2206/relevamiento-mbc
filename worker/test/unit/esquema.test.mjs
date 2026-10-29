// schema.sql es el estado final de la base: toda tabla, columna e índice que crea una migración debe estar también en él.
// Una base nueva se crea solo con schema.sql; si falta algo, el Worker falla en producción aunque las pruebas pasen.
//   node --test test/unit/esquema.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearD1 } from './d1-memoria.mjs';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { db } = crearD1();
const sinComentarios = t => t.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
const migraciones = readdirSync(raiz).filter(n => /^migracion-\d+\.sql$/.test(n)).sort();

test('hay migraciones que revisar', () => assert.ok(migraciones.length >= 20));

for (const f of migraciones) {
  test(`${f}: sus tablas, columnas e índices están en schema.sql`, () => {
    const sql = sinComentarios(readFileSync(join(raiz, f), 'utf8'));
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(m[1]), `${f}: falta la tabla ${m[1]}`);
    }
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi)) {
      const cols = db.prepare(`PRAGMA table_info(${m[1]})`).all().map(c => c.name);
      assert.ok(cols.includes(m[2]), `${f}: falta la columna ${m[1]}.${m[2]}`);
    }
    for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(m[1]), `${f}: falta el índice ${m[1]}`);
    }
  });
}
