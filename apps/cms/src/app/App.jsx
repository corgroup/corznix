import { AppProviders } from './providers/AppProviders.jsx';
import { AppRouter } from './router.jsx';

export default function App() {
  return (
    <AppProviders>
      <AppRouter />
    </AppProviders>
  );
}
