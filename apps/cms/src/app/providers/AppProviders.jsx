import { AuthProvider } from '../../auth/AuthProvider.jsx';
import { CompanyProvider } from '../../company/CompanyProvider.jsx';

// The router itself now lives in `router.jsx` (a data router via
// createBrowserRouter/RouterProvider). AuthProvider is pure React context
// with no router dependency, so it wraps the router cleanly. CompanyProvider
// (multi-company, DESIGN.md §6) sits inside it — it reads the company
// fields off the same /me response AuthProvider already fetched.
export function AppProviders({ children }) {
  return (
    <AuthProvider>
      <CompanyProvider>{children}</CompanyProvider>
    </AuthProvider>
  );
}

export default AppProviders;
