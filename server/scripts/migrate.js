import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { env } from '../src/config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'database', 'migrations');

async function main() {
  let connection;
  try {
    connection = await mysql.createConnection({
      host: env.DB_HOST,
      port: env.DB_PORT,
      database: env.DB_NAME,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      multipleStatements: true,
    });
  } catch (err) {
    console.error(
      `\nMigration failed: could not reach MySQL at ${env.DB_HOST}:${env.DB_PORT} (database "${env.DB_NAME}").\n` +
        'Copy server/.env.example to server/.env, start MySQL, and verify the DB_* credentials.\n' +
        `Underlying error: ${err.message}\n`
    );
    process.exitCode = 1;
    return;
  }

  try {
    // Wave 8J-5 — a MySQL named lock so two app instances (or a deploy racing
    // a manual run) cannot apply migrations concurrently. Released on
    // connection close even if the process crashes mid-run.
    const [[lock]] = await connection.query("SELECT GET_LOCK('corcotton_migrations', 30) AS ok");
    if (!lock.ok) {
      console.error('Migration aborted: another migration run holds the lock. Try again shortly.');
      process.exitCode = 1;
      return;
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        version VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_schema_migrations_version (version),
        UNIQUE KEY uq_schema_migrations_name (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    const [appliedRows] = await connection.query('SELECT name FROM schema_migrations');
    const applied = new Set(appliedRows.map((row) => row.name));

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    if (files.length === 0) {
      console.log('No migration files found in server/database/migrations.');
      return;
    }

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip    ${file} (already applied)`);
        continue;
      }
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      const version = file.split('_')[0];
      console.log(`apply   ${file}`);
      await connection.query(sql);
      await connection.query('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [version, file]);
    }

    console.log('Migrations complete.');
  } finally {
    try { await connection.query("SELECT RELEASE_LOCK('corcotton_migrations')"); } catch { /* connection may be gone */ }
    await connection.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exitCode = 1;
});
