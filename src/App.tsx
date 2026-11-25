import { useCallback, useEffect, useState } from 'react';
import { Menu, Moon, PanelLeftOpen, Sun } from 'lucide-react';
import { AdminConsolePage } from './components/AdminConsolePage';
import { AuthModal } from './components/AuthModal';
import { ChatWorkspace } from './components/ChatWorkspace';
import { ImageTextFixerPage } from './components/ImageTextFixerPage';
import { PlanBadge } from './components/PlanBadge';
import { Sidebar } from './components/Sidebar';
import { VoiceStudioPage } from './components/VoiceStudioPage';
import { apiRequest, setInMemorySessionToken } from './lib/api';
import {
  ChatMessage,
  ConversationSummary,
  MembershipState,
  UserProfile,
  WorkspaceView,
} from './types/tejas';

export default function App() {
  const [darkMode, setDarkMode] = useState(true);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [membership, setMembership] = useState<MembershipState | null>(null);
  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState('');

  const [activeView, setActiveView] = useState<WorkspaceView>('workspace');
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [darkMode]);

  const loadConversations = useCallback(async () => {
    try {
      const res = await apiRequest<{ conversations: ConversationSummary[] }>(
        '/api/conversations'
      );
      setConversations(res.conversations);
    } catch {
      // ignore if unauthenticated
    }
  }, []);

  const loadMessages = useCallback(async (convId: string) => {
    setLoadingMessages(true);
    try {
      const res = await apiRequest<{ messages: ChatMessage[] }>(
        `/api/conversations/${convId}`
      );
      setMessages(res.messages);
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  const initializeSession = useCallback(async () => {
    setBootLoading(true);
    setBootError('');
    try {
      try {
        const me = await apiRequest<{ user: UserProfile; membership: MembershipState }>(
          '/api/auth/me',
          { timeoutMs: 12000 }
        );
        setUser(me.user);
        setMembership(me.membership);
      } catch {
        const guest = await apiRequest<{
          user: UserProfile;
          membership: MembershipState;
          sessionToken?: string;
        }>('/api/auth/guest', { method: 'POST', timeoutMs: 12000 });
        if (guest.sessionToken) {
          setInMemorySessionToken(guest.sessionToken);
        }
        setUser(guest.user);
        setMembership(guest.membership);
      }
      await loadConversations();
    } catch (err) {
      setBootError(err instanceof Error ? err.message : 'Failed to initialize TEJAS AI session.');
    } finally {
      setBootLoading(false);
    }
  }, [loadConversations]);

  useEffect(() => {
    void initializeSession();
  }, [initializeSession]);

  async function handleSelectConversation(id: string) {
    setActiveConversationId(id);
    await loadMessages(id);
  }

  async function handleRenameConversation(id: string, title: string) {
    const res = await apiRequest<{ conversation: ConversationSummary }>(
      `/api/conversations/${id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      }
    );
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title: res.conversation.title } : c))
    );
  }

  async function handleDeleteConversation(id: string) {
    await apiRequest(`/api/conversations/${id}`, { method: 'DELETE' });
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeConversationId === id) {
      setActiveConversationId(null);
      setMessages([]);
    }
  }

  function handleNewChat() {
    setActiveConversationId(null);
    setMessages([]);
    setActiveView('workspace');
  }

  async function handleLogout() {
    await apiRequest('/api/auth/logout', { method: 'POST' });
    setInMemorySessionToken(null);
    setActiveConversationId(null);
    setMessages([]);
    setConversations([]);
    await initializeSession();
  }

  if (bootLoading || !user || !membership) {
    return (
      <div className="flex h-dvh w-screen items-center justify-center bg-white px-6 text-neutral-900 dark:bg-[#0d0d0d] dark:text-neutral-100">
        {bootError ? (
          <div className="max-w-sm space-y-3 text-center">
            <div className="text-sm font-medium text-red-500">{bootError}</div>
            <button
              type="button"
              onClick={() => void initializeSession()}
              className="min-h-[40px] rounded-lg bg-black px-4 py-2 text-xs font-semibold text-white dark:bg-white dark:text-black"
            >
              Retry Connection
            </button>
          </div>
        ) : (
          <div className="text-xs font-mono tracking-wide text-neutral-500">
            Connecting to TEJAS AI...
          </div>
        )}
      </div>
    );
  }

  const viewTitleMap: Record<WorkspaceView, string> = {
    workspace: 'AI Chat (Unlimited)',
    voice: 'Voice & Talk Studio',
    text_fixer: 'Image Text Fixer',
    admin: 'Admin Dashboard',
  };

  return (
    <div className="flex h-dvh w-screen overflow-hidden bg-white text-neutral-900 dark:bg-[#171717] dark:text-neutral-100">
      <Sidebar
        user={user}
        membership={membership}
        conversations={conversations}
        activeConversationId={activeConversationId}
        activeView={activeView}
        desktopCollapsed={desktopCollapsed}
        isOpenMobile={mobileSidebarOpen}
        onToggleDesktopCollapse={() => setDesktopCollapsed((prev) => !prev)}
        onCloseMobile={() => setMobileSidebarOpen(false)}
        onSelectView={(v) => setActiveView(v)}
        onNewChat={handleNewChat}
        onSelectConversation={(id) => void handleSelectConversation(id)}
        onRenameConversation={handleRenameConversation}
        onDeleteConversation={handleDeleteConversation}
        onOpenAuth={() => setAuthModalOpen(true)}
        onLogout={() => void handleLogout()}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Clean Workspace Top Bar */}
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-neutral-200 bg-white px-4 dark:border-neutral-800 dark:bg-[#171717]">
          <div className="flex min-w-0 items-center gap-2.5">
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(true)}
              className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg p-2 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 lg:hidden"
              aria-label="Open navigation sidebar"
            >
              <Menu className="h-4 w-4" />
            </button>
            {desktopCollapsed && (
              <button
                type="button"
                onClick={() => setDesktopCollapsed(false)}
                className="hidden lg:inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg p-2 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                aria-label="Expand sidebar"
                title="Expand sidebar"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </button>
            )}
            <div className="truncate text-sm font-semibold tracking-tight">
              TEJAS AI <span className="mx-1.5 text-neutral-400">/</span>{' '}
              <span className="font-normal text-neutral-600 dark:text-neutral-400">
                {viewTitleMap[activeView]}
              </span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2.5">
            <div className="hidden sm:inline-flex items-center">
              <PlanBadge />
            </div>

            <button
              type="button"
              onClick={() => setDarkMode((prev) => !prev)}
              className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-neutral-200 p-2 text-neutral-600 hover:bg-neutral-100 hover:text-black dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
              aria-label={darkMode ? 'Switch to light theme' : 'Switch to dark theme'}
              title={darkMode ? 'Light monochrome' : 'Dark monochrome'}
            >
              {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </header>

        {/* Active View Viewport */}
        <main className="min-h-0 flex-1">
          {activeView === 'workspace' && (
            <ChatWorkspace
              membership={membership}
              conversationId={activeConversationId}
              messages={messages}
              loadingMessages={loadingMessages}
              onMessagesUpdated={(convId, nextMembership) => {
                setMembership(nextMembership);
                setActiveConversationId(convId);
                void loadConversations();
                void loadMessages(convId);
              }}
              onMembershipUpdated={(nextMembership) => setMembership(nextMembership)}
              onNavigate={(view) => setActiveView(view)}
            />
          )}

          {activeView === 'voice' && (
            <VoiceStudioPage
              membership={membership}
              onMembershipUpdated={(nextMembership) => setMembership(nextMembership)}
            />
          )}

          {activeView === 'text_fixer' && (
            <ImageTextFixerPage
              membership={membership}
              onMembershipUpdated={(nextMembership) => setMembership(nextMembership)}
            />
          )}

          {activeView === 'admin' && (
            <AdminConsolePage
              user={user}
              onUserUpdated={(nextUser, nextMembership) => {
                setUser(nextUser);
                setMembership(nextMembership);
              }}
            />
          )}
        </main>
      </div>

      <AuthModal
        isOpen={authModalOpen}
        isGuest={user.isGuest}
        onClose={() => setAuthModalOpen(false)}
        onSuccess={(nextUser, nextMembership) => {
          setUser(nextUser);
          setMembership(nextMembership);
          void loadConversations();
        }}
      />
    </div>
  );
}
