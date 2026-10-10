import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

export async function usageDatabase(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of ['0001_usage.sql', '0002_private_visitors.sql']) sqlite.exec(await readFile(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const db = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return { bind(...parameters) {
        return { async run() { statement.run(...parameters); return { success: true }; },
          async all() { return { results: statement.all(...parameters), success: true }; } };
      } };
    },
    withSession(mode) { assert.equal(mode, 'first-primary'); return db; },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const item of statements) results.push(await item.all()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { db, sqlite };
}
