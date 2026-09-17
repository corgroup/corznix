import mysql from 'mysql2/promise';
import { env } from '../../config/index.js';

/**
 * mysql2 connects lazily on first query — creating the pool never throws,
 * which is what lets `/api/v1/health` report `db: "not_connected"` instead
 * of the whole server failing to boot when MySQL isn't running yet.
 */
export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  charset: 'utf8mb4',
  timezone: '+00:00',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// DATETIME has no timezone metadata. Application-generated timestamps are
// UTC (see toMysqlDateTime), so SQL-generated NOW()/CURRENT_TIMESTAMP values
// must use the same clock. Without this, a MySQL host running in IST makes a
// fresh OTP challenge appear about 5.5 hours in the future to Node, breaking
// resend cooldown and other timestamp comparisons.
pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

/**
 * @param {string} sql
 * @param {unknown[]} [params]
 */
export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** Cheap connectivity probe used by the health endpoint. Never throws. */
export async function isDatabaseConnected() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
