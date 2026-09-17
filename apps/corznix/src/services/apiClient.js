import { ApiClient } from '@cor-group/api-client';

export const apiClient = new ApiClient({
  baseURL: import.meta.env.VITE_API_BASE_URL,
});
