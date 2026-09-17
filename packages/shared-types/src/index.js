/**
 * Shared type documentation for the CORCOTTON platform.
 *
 * The stack is plain JavaScript (no TypeScript), so "shared types" here means:
 *   1. JSDoc typedefs — editor intellisense, zero runtime cost.
 */

/**
 * @typedef {object} HealthResponse
 * @property {'ok'} status
 * @property {string} service
 * @property {string} timestamp - ISO 8601.
 * @property {'connected'|'not_connected'} db
 */

/**
 * @typedef {object} ApiErrorBody
 * @property {object} error
 * @property {string} error.code
 * @property {string} error.message
 * @property {unknown} [error.details]
 */
