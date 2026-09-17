// Staff/admin authentication boundary. Deliberately NOT the customer
// `authenticate` middleware: it reads a different cookie
// (STAFF_SESSION_COOKIE_NAME, never the customer SESSION_COOKIE_NAME),
// validates against a different table (staff_sessions), and a valid
// customer session presented here authenticates nothing (Wave 8A brief
// §27/§28/§58).
import { AppError } from '../utils/errors.js';
import { env } from '../config/index.js';
import { staffAuthService } from '../modules/staff/service.js';

function extractStaffToken(req) {
  const cookie = req.cookies?.[env.STAFF_SESSION_COOKIE_NAME];
  if (cookie) return cookie;
  // Bearer is accepted only for non-browser callers (CLI, verification
  // scripts). The customer access-token JWT is not a valid staff token, so
  // this cannot be used to cross the customer/staff boundary.
  const header = req.headers.authorization;
  if (header && /^Bearer\s+/i.test(header)) {
    return header.replace(/^Bearer\s+/i, '').trim();
  }
  return null;
}

export async function authenticateStaff(req, _res, next) {
  try {
    const token = extractStaffToken(req);
    if (!token) {
      throw new AppError('AUTH_REQUIRED', 'Staff authentication required.', 401);
    }
    const { staff, session } = await staffAuthService.validateSession(token, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
    });
    req.staff = staff;
    req.staffSession = session;
    next();
  } catch (error) {
    next(error);
  }
}

export default authenticateStaff;
