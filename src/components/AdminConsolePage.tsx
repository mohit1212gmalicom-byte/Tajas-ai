import { useEffect, useState, type FormEvent } from 'react';
import { Download, RefreshCw, ShieldCheck } from 'lucide-react';
import { apiRequest, downloadAuthorizedFile, formatIstDateTime } from '../lib/api';
import {
  AdminOverviewData,
  MembershipState,
  SystemSettings,
  UserProfile,
} from '../types/tejas';

interface AdminConsolePageProps {
  user: UserProfile;
  onUserUpdated: (user: UserProfile, membership: MembershipState) => void;
}

interface AdminStatusResponse {
  isAdmin: boolean;
  adminEmail: string;
  envPasscodeConfigured: boolean;
  adminClaimed: boolean;
  needsFirstRunBootstrap: boolean;
}

export function AdminConsolePage({ user, onUserUpdated }: AdminConsolePageProps) {
  const [adminStatus, setAdminStatus] = useState<AdminStatusResponse | null>(null);
  const [passcode, setPasscode] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  const [overview, setOverview] = useState<AdminOverviewData | null>(null);
  const [draftSettings, setDraftSettings] = useState<SystemSettings | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [exportingZip, setExportingZip] = useState(false);
  const [actionNotice, setActionNotice] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  async function loadStatusAndOverview() {
    const status = await apiRequest<AdminStatusResponse>('/api/admin/status');
    setAdminStatus(status);
    if (status.isAdmin) {
      setLoadingOverview(true);
      try {
        const data = await apiRequest<AdminOverviewData>('/api/admin/overview');
        setOverview(data);
        setDraftSettings(structuredClone(data.settings));
      } finally {
        setLoadingOverview(false);
      }
    }
  }

  useEffect(() => {
    void loadStatusAndOverview();
  }, [user.id, user.role]);

  async function handleAdminAuth(e: FormEvent) {
    e.preventDefault();
    setAuthError('');
    setAuthLoading(true);
    try {
      const endpoint = adminStatus?.needsFirstRunBootstrap
        ? '/api/admin/bootstrap'
        : '/api/admin/unlock';
      const res = await apiRequest<{ user: UserProfile; membership: MembershipState }>(
        endpoint,
        {
          method: 'POST',
          body: JSON.stringify({ passcode }),
        }
      );
      setPasscode('');
      onUserUpdated(res.user, res.membership);
      await loadStatusAndOverview();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Admin verification failed.');
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleSaveSettings(e: FormEvent) {
    e.preventDefault();
    if (!draftSettings) return;
    setSavingSettings(true);
    setActionNotice('');
    try {
      const res = await apiRequest<{ settings: SystemSettings }>('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify(draftSettings),
      });
      setDraftSettings(structuredClone(res.settings));
      setActionNotice('Feature availability settings saved.');
      await loadStatusAndOverview();
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleClearSystemErrors() {
    setActionNotice('');
    try {
      await apiRequest('/api/admin/errors', { method: 'DELETE' });
      setActionNotice('System error log cleared.');
      await loadStatusAndOverview();
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : 'Failed to clear errors.');
    }
  }

  async function handleExportZip() {
    setExportingZip(true);
    setActionNotice('');
    try {
      await downloadAuthorizedFile('/api/admin/export-zip', 'tejas-ai-source.zip');
      setActionNotice('Downloaded tejas-ai-source.zip (full project source code).');
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : 'Failed to export ZIP.');
    } finally {
      setExportingZip(false);
    }
  }

  if (!adminStatus) {
    return (
      <div className="p-8 text-xs text-neutral-500">Checking admin authorization state...</div>
    );
  }

  if (!adminStatus.isAdmin) {
    return (
      <div className="flex h-full items-center justify-center bg-white p-6 text-neutral-900 dark:bg-[#171717] dark:text-neutral-100">
        <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-neutral-50 p-6 dark:border-neutral-800 dark:bg-[#121212]">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-5 w-5" />
            <h1 className="text-lg font-bold tracking-tight">
              {adminStatus.needsFirstRunBootstrap
                ? 'First-Run Admin Setup — Mohit Jaat'
                : 'Admin Verification — Mohit Jaat'}
            </h1>
          </div>
          <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">
            {adminStatus.needsFirstRunBootstrap
              ? 'No TEJAS_ADMIN_PASSCODE secret is set in the environment yet. Claim administrator access once by choosing a strong passcode (min 8 characters).'
              : 'Enter the server admin passcode to manage feature controls, inspect users, and view system errors.'}
          </p>

          <form onSubmit={handleAdminAuth} className="mt-5 space-y-4">
            <div>
              <label className="block text-xs font-medium">
                {adminStatus.needsFirstRunBootstrap ? 'Create Admin Passcode' : 'Admin Passcode'}
              </label>
              <input
                type="password"
                required
                minLength={adminStatus.needsFirstRunBootstrap ? 8 : 1}
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                placeholder="Minimum 8 characters"
                className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-black focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-white"
              />
            </div>

            {authError && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                {authError}
              </div>
            )}

            <button
              type="submit"
              disabled={authLoading}
              className="min-h-[42px] w-full rounded-lg bg-black px-4 py-2.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-black"
            >
              {authLoading
                ? 'Verifying...'
                : adminStatus.needsFirstRunBootstrap
                  ? 'Claim Admin Controls'
                  : 'Unlock Admin Console'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const filteredUsers =
    overview?.users.filter(
      (u) =>
        u.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
        u.name.toLowerCase().includes(searchQuery.toLowerCase())
    ) || [];

  return (
    <div className="h-full overflow-y-auto bg-white px-4 py-8 text-neutral-900 dark:bg-[#171717] dark:text-neutral-100 sm:px-8">
      <div className="mx-auto max-w-6xl space-y-8">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-200 pb-6 dark:border-neutral-800">
          <div>
            <div className="text-xs text-neutral-500 dark:text-neutral-400">
              TEJAS AI · Secure Developer Console (Mohit Jaat)
            </div>
            <h1 className="mt-1 text-2xl font-bold tracking-tight">
              Admin Controls, Usage &amp; System Errors
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={exportingZip}
              onClick={() => void handleExportZip()}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-black px-3.5 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-black"
            >
              <Download className="h-3.5 w-3.5" />
              <span>{exportingZip ? 'Preparing ZIP...' : 'Download Project ZIP'}</span>
            </button>
            <button
              type="button"
              onClick={() => void loadStatusAndOverview()}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Refresh Data</span>
            </button>
          </div>
        </div>

        {actionNotice && (
          <div className="rounded-xl border border-neutral-300 bg-neutral-100 px-4 py-2.5 text-xs dark:border-neutral-700 dark:bg-neutral-900">
            {actionNotice}
          </div>
        )}

        {loadingOverview && !overview ? (
          <div className="text-xs text-neutral-500">Loading admin metrics...</div>
        ) : overview && draftSettings ? (
          <>
            {/* 4-column KPI Strip */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-[#121212]">
                <div className="text-[11px] text-neutral-500 dark:text-neutral-400">Total Users</div>
                <div className="mt-1 font-mono text-2xl font-bold tabular-nums">
                  {overview.summary.totalUsers}
                </div>
                <div className="mt-1 text-[11px] text-neutral-500">FREE Unlimited Plan</div>
              </div>

              <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-[#121212]">
                <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  Today Chats (IST)
                </div>
                <div className="mt-1 font-mono text-2xl font-bold tabular-nums">
                  {overview.summary.dailyChats}
                </div>
                <div className="mt-1 font-mono text-[11px] text-neutral-500">
                  {overview.summary.istDate}
                </div>
              </div>

              <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-[#121212]">
                <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  Monthly Chats
                </div>
                <div className="mt-1 font-mono text-2xl font-bold tabular-nums">
                  {overview.summary.monthlyChats}
                </div>
                <div className="mt-1 text-[11px] text-neutral-500">All users combined</div>
              </div>

              <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-[#121212]">
                <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  System Errors
                </div>
                <div className="mt-1 font-mono text-2xl font-bold tabular-nums">
                  {overview.summary.systemErrorCount}
                </div>
                <div className="mt-1 text-[11px] text-neutral-500">Logged server events</div>
              </div>
            </div>

            {/* Feature Controls Form */}
            <form
              onSubmit={handleSaveSettings}
              className="space-y-4 rounded-xl border border-neutral-200 bg-neutral-50 p-6 dark:border-neutral-800 dark:bg-[#121212]"
            >
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold">Feature Availability Controls</h2>
                  <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                    Enable or pause specific AI features across TEJAS AI.
                  </p>
                </div>
                <button
                  type="submit"
                  disabled={savingSettings}
                  className="min-h-[40px] rounded-lg bg-black px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-black"
                >
                  {savingSettings ? 'Saving...' : 'Save Configuration'}
                </button>
              </div>

              <div className="flex flex-wrap gap-5 pt-2 text-xs">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draftSettings.capabilities.enableImageUnderstanding}
                    onChange={(e) =>
                      setDraftSettings({
                        ...draftSettings,
                        capabilities: {
                          ...draftSettings.capabilities,
                          enableImageUnderstanding: e.target.checked,
                        },
                      })
                    }
                  />
                  <span>Image Understanding</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draftSettings.capabilities.enableImageTextFixer}
                    onChange={(e) =>
                      setDraftSettings({
                        ...draftSettings,
                        capabilities: {
                          ...draftSettings.capabilities,
                          enableImageTextFixer: e.target.checked,
                        },
                      })
                    }
                  />
                  <span>Image Text Fixer</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draftSettings.capabilities.enableVoiceOver}
                    onChange={(e) =>
                      setDraftSettings({
                        ...draftSettings,
                        capabilities: {
                          ...draftSettings.capabilities,
                          enableVoiceOver: e.target.checked,
                        },
                      })
                    }
                  />
                  <span>Voice-Over TTS</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draftSettings.capabilities.enableVoiceInput}
                    onChange={(e) =>
                      setDraftSettings({
                        ...draftSettings,
                        capabilities: {
                          ...draftSettings.capabilities,
                          enableVoiceInput: e.target.checked,
                        },
                      })
                    }
                  />
                  <span>Voice Input (STT)</span>
                </label>
                <label className="flex items-center gap-2 font-semibold text-red-600 dark:text-red-400">
                  <input
                    type="checkbox"
                    checked={draftSettings.aiKillSwitch}
                    onChange={(e) =>
                      setDraftSettings({
                        ...draftSettings,
                        aiKillSwitch: e.target.checked,
                      })
                    }
                  />
                  <span>Global AI Kill Switch</span>
                </label>
              </div>
            </form>

            {/* User Activity Table */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold">Users &amp; Today&apos;s Activity</h2>
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter by email or name..."
                  className="w-full max-w-xs rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs focus:border-black focus:outline-none dark:border-neutral-700 dark:bg-[#121212] dark:focus:border-white"
                />
              </div>

              <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
                <table className="w-full min-w-[700px] border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-[#111111]">
                      <th className="px-4 py-3 font-semibold">User</th>
                      <th className="px-4 py-3 font-semibold">Plan</th>
                      <th className="px-4 py-3 font-semibold">Chats</th>
                      <th className="px-4 py-3 font-semibold">Image Text Fixes</th>
                      <th className="px-4 py-3 font-semibold">Voice TTS / STT</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                    {filteredUsers.map((u) => (
                      <tr key={u.id}>
                        <td className="px-4 py-3">
                          <div className="font-medium">
                            {u.name} {u.role === 'admin' ? '(Admin)' : ''}
                          </div>
                          <div className="text-[11px] text-neutral-500">{u.email}</div>
                        </td>
                        <td className="px-4 py-3 font-mono">FREE (Unlimited)</td>
                        <td className="px-4 py-3 font-mono tabular-nums">{u.usageToday.chats}</td>
                        <td className="px-4 py-3 font-mono tabular-nums">
                          {u.usageToday.imageTextFix}
                        </td>
                        <td className="px-4 py-3 font-mono tabular-nums">
                          {u.usageToday.voiceGen} / {u.usageToday.voiceTranscribe}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* System Errors Log */}
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">
                  System Errors ({overview.systemErrors.length})
                </h2>
                {overview.systemErrors.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void handleClearSystemErrors()}
                    className="rounded-lg border border-neutral-300 px-3 py-1 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                  >
                    Clear Errors
                  </button>
                )}
              </div>
              <div className="mt-3 max-h-64 overflow-y-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-[#111111]">
                      <th className="px-4 py-2.5 font-semibold">Route / Code</th>
                      <th className="px-4 py-2.5 font-semibold">Message</th>
                      <th className="px-4 py-2.5 font-semibold">Status</th>
                      <th className="px-4 py-2.5 font-semibold">Timestamp</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                    {overview.systemErrors.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-4 py-4 text-center text-neutral-500">
                          No recent system errors logged.
                        </td>
                      </tr>
                    ) : (
                      overview.systemErrors.map((err) => (
                        <tr key={err.id}>
                          <td className="px-4 py-2 font-mono">
                            <div>{err.route}</div>
                            {err.error_code && (
                              <div className="text-[10px] text-neutral-500">{err.error_code}</div>
                            )}
                          </td>
                          <td className="px-4 py-2 text-neutral-700 dark:text-neutral-300">
                            {err.message}
                          </td>
                          <td className="px-4 py-2 font-mono">{err.status_code}</td>
                          <td className="px-4 py-2 font-mono text-[11px] tabular-nums">
                            {formatIstDateTime(err.created_at)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
