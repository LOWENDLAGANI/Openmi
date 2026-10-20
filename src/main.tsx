import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { AppProvider } from './lib/app-context';
import { loadRuntimeConfig, type RuntimeConfig } from './lib/config';
import { Setup } from './pages/Setup';
import { Banner } from './components/ui';

function Bootstrap() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRuntimeConfig()
      .then(setConfig)
      .catch((loadError: unknown) =>
        setError(loadError instanceof Error ? loadError.message : 'Could not load app config'),
      );
  }, []);

  if (error) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5">
        <Banner>
          The API is unreachable ({error}). Check the Worker deployment and reload.
        </Banner>
      </main>
    );
  }

  if (!config) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <div className="flex size-11 animate-pulse items-center justify-center rounded-2xl bg-emerald-400 text-lg font-black text-emerald-950">
          M
        </div>
      </main>
    );
  }

  if (!config.ready) return <Setup config={config} />;

  return (
    <AppProvider config={config}>
      <App />
    </AppProvider>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing');

createRoot(container).render(
  <StrictMode>
    <Bootstrap />
  </StrictMode>,
);
