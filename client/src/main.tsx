import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import App from './App';
import { ApiError } from './api/client';
import { AuthProvider, ME_QUERY_KEY, noteUnauthenticated } from './auth/AuthContext';
import { ToastProvider } from './components/Toast';
import './index.css';

// Any API call answered with 401 means the session is gone: forget the user,
// and the route guards send the browser to the sign-in page.
function onApiError(error: unknown) {
  if (error instanceof ApiError && error.status === 401) {
    noteUnauthenticated(error);
    queryClient.setQueryData(ME_QUERY_KEY, null);
  }
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onApiError }),
  mutationCache: new MutationCache({ onError: onApiError }),
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
      refetchOnWindowFocus: true,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
