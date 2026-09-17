import { Router } from 'express';

/**
 * Builds a router that responds 501 to every request.
 * Used by modules whose route architecture is established but not yet implemented.
 * @param {string} moduleName
 */
export function createStubRouter(moduleName) {
  const router = Router();
  router.all('*', (req, res) => {
    res.status(501).json({
      error: {
        code: 'NOT_IMPLEMENTED',
        message: `The "${moduleName}" module is not implemented yet.`,
      },
    });
  });
  return router;
}
