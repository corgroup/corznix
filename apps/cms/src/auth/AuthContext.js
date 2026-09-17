import { createContext } from 'react';

// Kept in a `.js` file (not `.jsx`) so react-refresh's "only export
// components" rule is satisfied — the Provider component and hooks live in
// their own files.
export const AUTH_STATES = Object.freeze({
  LOADING: 'LOADING',
  AUTHENTICATED: 'AUTHENTICATED',
  GUEST: 'GUEST',
});

export const AuthContext = createContext(null);

export default AuthContext;
