import { useState } from 'react';
import { signInWithGoogle } from '../lib/firebase';

export default function Login() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setLoading(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (e: any) {
      setError(e?.message ?? 'sign-in failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-full flex flex-col items-center justify-center px-6 safe-top safe-bottom">
      <div className="w-full max-w-sm text-center">
        <div className="text-5xl mb-4">⚡</div>
        <h1 className="text-3xl font-bold text-white mb-2">OpenMi</h1>
        <p className="text-slate-400 mb-8 text-sm">
          Type a prompt on your phone. A background agent edits your GitHub repo and commits — even
          after you close the tab.
        </p>
        <button
          onClick={go}
          disabled={loading}
          className="w-full bg-white text-slate-900 font-semibold py-3 px-4 rounded-xl hover:bg-slate-100 disabled:opacity-50 transition active:scale-[0.98]"
        >
          {loading ? 'Signing in…' : 'Continue with Google'}
        </button>
        {error && <p className="mt-4 text-red-400 text-sm">{error}</p>}
        <p className="mt-6 text-xs text-slate-500">
          GitHub is linked after sign-in so the agent can push.
        </p>
      </div>
    </div>
  );
}
