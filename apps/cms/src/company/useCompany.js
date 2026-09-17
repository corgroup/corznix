import { useContext } from 'react';
import { CompanyContext } from './CompanyContext.js';

export function useCompany() {
  const ctx = useContext(CompanyContext);
  if (!ctx) {
    throw new Error('useCompany must be used within <CompanyProvider>.');
  }
  return ctx;
}

export default useCompany;
