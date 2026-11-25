import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { apiRequest, setInMemorySessionToken } from '../lib/api';
import { MembershipState, UserProfile } from '../types/tejas';

interface AuthModalProps {
  isOpen: boolean;
  initialMode?: 'login' | 'register';
  isGuest: boolean;
  onClose: () => void;
  onSuccess: (user: UserProfile, membership: MembershipState) => void;
}

export function AuthModal({
  isOpen,
  initialMode = 'login',
  isGuest,
  onClose,
  onSuccess,
}: AuthModalProps) {
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const payload =
        mode === 'login' ? { email, password } : { name, email, password };
      const res = await apiRequest<{
        user: UserProfile;
        membership: MembershipState;
        sessionToken?: string;
      }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (res.sessionToken) {
        setInMemorySessionToken(res.sessionToken);
      }
      onSuccess(res.user, res.membership);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
    >
      <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-6 text-neutral-900 shadow-2xl dark:border-neutral-800 dark:bg-[#141414] dark:text-neutral-100">
        <div className="flex items-center justify-between border-b border-neutral-200 pb-4 dark:border-neutral-800">
          <div>
            <h2 id="auth-modal-title" className="text-lg font-semibold tracking-tight">
              {mode === 'login' ? 'Sign in to TEJAS AI' : 'Create TEJAS AI Account'}
            </h2>
            <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
              {isGuest && mode === 'register'
                ? 'Your current guest chats will be preserved.'
                : 'Save your conversations across devices for free.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 hover:text-black dark:hover:bg-neutral-800 dark:hover:text-white"
            aria-label="Close sign in dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg bg-neutral-100 p-1 dark:bg-neutral-900">
          <button
            type="button"
            onClick={() => {
              setMode('login');
              setError('');
            }}
            className={`rounded-md py-2 text-xs font-medium transition-colors ${
              mode === 'login'
                ? 'bg-white text-black shadow-xs dark:bg-neutral-800 dark:text-white'
                : 'text-neutral-600 hover:text-black dark:text-neutral-400 dark:hover:text-white'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('register');
              setError('');
            }}
            className={`rounded-md py-2 text-xs font-medium transition-colors ${
              mode === 'register'
                ? 'bg-white text-black shadow-xs dark:bg-neutral-800 dark:text-white'
                : 'text-neutral-600 hover:text-black dark:text-neutral-400 dark:hover:text-white'
            }`}
          >
            Create Account
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          {mode === 'register' && (
            <div>
              <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300">
                Full Name
              </label>
              <input
                type="text"
                required
                minLength={2}
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mohit Jaat"
                className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-black focus:outline-none dark:border-neutral-700 dark:focus:border-white"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Email Address
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-black focus:outline-none dark:border-neutral-700 dark:focus:border-white"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Password
            </label>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Minimum 6 characters"
              className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-black focus:outline-none dark:border-neutral-700 dark:focus:border-white"
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-black px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-black"
          >
            {loading
              ? 'Please wait...'
              : mode === 'login'
                ? 'Sign In'
                : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  );
}
