// ADAPTED_SOURCE_TO_TARGET from corcotton-store/server/src/db/transaction.js
// (Wave 5) — target has no transaction helper yet; needed for operations
// that must be atomic (e.g. identity-link confirmation, refresh-token
// rotation with reuse detection — see modules/auth/service.js).
import { pool } from './pool.js';

export async function withTransaction(fn) {
  const connection = await pool.getConnection();
  await connection.beginTransaction();

  try {
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
