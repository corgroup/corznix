export class AppError extends Error {
  /**
   * @param {string} code - Machine-readable error code, e.g. "NOT_FOUND".
   * @param {string} message - Human-readable message.
   * @param {number} [status=500]
   * @param {unknown} [details]
   */
  constructor(code, message, status = 500, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
