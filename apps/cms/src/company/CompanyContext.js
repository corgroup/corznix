import { createContext } from 'react';

// Kept in a `.js` file (not `.jsx`) so react-refresh's "only export
// components" rule is satisfied — mirrors auth/AuthContext.js.
export const CompanyContext = createContext(null);

export default CompanyContext;
