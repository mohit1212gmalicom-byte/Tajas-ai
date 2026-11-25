import { useState, type FormEvent } from 'react';
import {
  Check,
  FilePenLine,
  LogIn,
  LogOut,
  MessageSquare,
  Mic,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  ConversationSummary,
  MembershipState,
  UserProfile,
  WorkspaceView,
} from '../types/tejas';
import { PlanBadge } from './PlanBadge';
import { TejasMark } from './TejasMark';

interface SidebarProps {
  user: UserProfile;
  membership: MembershipState;
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  activeView: WorkspaceView;
  desktopCollapsed: boolean;
  isOpenMobile: boolean;
  onToggleDesktopCollapse: () => void;
  onCloseMobile: () => void;
  onSelectView: (view: WorkspaceView) => void;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onRenameConversation: (id: string, title: string) => Promise<void>;
  onDeleteConversation: (id: string) => Promise<void>;
  onOpenAuth: () => void;
  onLogout: () => void;
}

export function Sidebar({
  user,
  membership,
  conversations,
  activeConversationId,
  activeView,
  desktopCollapsed,
  isOpenMobile,
  onToggleDesktopCollapse,
  onCloseMobile,
  onSelectView,
  onNewChat,
  onSelectConversation,
  onRenameConversation,
  onDeleteConversation,
  onOpenAuth,
  onLogout,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  const filteredConversations = conversations.filter((c) =>
    c.title.toLowerCase().includes(searchQuery.trim().toLowerCase())
  );

  async function submitRename(e: FormEvent, id: string) {
    e.preventDefault();
    const trimmed = editingTitle.trim();
    if (!trimmed) {
      setEditingId(null);
      return;
    }
    await onRenameConversation(id, trimmed);
    setEditingId(null);
  }

  const navItems: Array<{
    view: WorkspaceView;
    label: string;
    icon: typeof MessageSquare;
    badge?: string;
  }> = [
    { view: 'workspace', label: 'AI Chat (Unlimited)', icon: MessageSquare },
    { view: 'voice', label: 'Voice & Talk Studio', icon: Mic },
    { view: 'text_fixer', label: 'Image Text Fixer', icon: FilePenLine },
    {
      view: 'admin',
      label: 'Admin Dashboard',
      icon: ShieldCheck,
      badge: user.role === 'admin' ? 'OWNER' : undefined,
    },
  ];

  const navContent = (
    <aside className="flex h-full w-[280px] flex-col border-r border-neutral-200 bg-[#f9f9f9] text-neutral-900 dark:border-neutral-800/80 dark:bg-[#0d0d0d] dark:text-neutral-100">
      {/* Top Brand + Collapse + New Chat */}
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3.5 py-3 dark:border-neutral-800/80">
        <button
          type="button"
          onClick={() => {
            onSelectView('workspace');
            onCloseMobile();
          }}
          className="flex items-center gap-2.5 text-left whitespace-nowrap shrink-0 min-h-[40px]"
        >
          <TejasMark size={22} />
          <span className="text-sm font-bold tracking-tight">TEJAS AI</span>
        </button>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              onNewChat();
              onCloseMobile();
            }}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-900 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800 whitespace-nowrap shrink-0"
            title="New Chat"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New Chat</span>
          </button>
          <button
            type="button"
            onClick={onToggleDesktopCollapse}
            className="hidden lg:inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-200 hover:text-black dark:hover:bg-neutral-800 dark:hover:text-white"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onCloseMobile}
            className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-800 lg:hidden"
            aria-label="Close sidebar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Primary Navigation */}
      <div className="border-b border-neutral-200 px-3 py-2.5 space-y-0.5 dark:border-neutral-800/80">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.view;
          return (
            <button
              key={item.view}
              type="button"
              onClick={() => {
                onSelectView(item.view);
                onCloseMobile();
              }}
              className={`flex min-h-[40px] w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                isActive
                  ? 'bg-neutral-200 text-black dark:bg-neutral-800 dark:text-white'
                  : 'text-neutral-600 hover:bg-neutral-100 hover:text-black dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-white'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </span>
              {item.badge && (
                <span className="font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Search Conversations */}
      <div className="px-3 pt-3 pb-2">
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-neutral-400" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversations..."
            aria-label="Search conversations"
            className="w-full rounded-lg border border-neutral-200 bg-white py-1.5 pl-8 pr-3 text-xs placeholder:text-neutral-400 focus:border-black focus:outline-none dark:border-neutral-800 dark:bg-[#141414] dark:focus:border-white"
          />
        </div>
      </div>

      {/* Chat History */}
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        <div className="px-2 pb-1.5 text-[11px] font-medium text-neutral-500">
          Conversations ({filteredConversations.length})
        </div>
        {filteredConversations.length === 0 ? (
          <p className="px-2 py-3 text-xs text-neutral-500">
            {searchQuery
              ? 'No matching conversations.'
              : 'No chats yet. Start a message in AI Chat.'}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {filteredConversations.map((conv) => {
              const isSelected = activeView === 'workspace' && activeConversationId === conv.id;
              const isEditing = editingId === conv.id;

              if (isEditing) {
                return (
                  <li key={conv.id} className="px-1 py-0.5">
                    <form
                      onSubmit={(e) => void submitRename(e, conv.id)}
                      className="flex items-center gap-1 rounded-lg border border-neutral-400 bg-white px-2 py-1 dark:border-neutral-600 dark:bg-neutral-900"
                    >
                      <input
                        type="text"
                        autoFocus
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        className="min-w-0 flex-1 bg-transparent text-xs focus:outline-none"
                      />
                      <button
                        type="submit"
                        className="rounded p-1 text-neutral-600 hover:text-black dark:text-neutral-300 dark:hover:text-white"
                        aria-label="Save title"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="rounded p-1 text-neutral-500 hover:text-black dark:hover:text-white"
                        aria-label="Cancel rename"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  </li>
                );
              }

              return (
                <li key={conv.id} className="group relative flex items-center">
                  <button
                    type="button"
                    onClick={() => {
                      onSelectConversation(conv.id);
                      onSelectView('workspace');
                      onCloseMobile();
                    }}
                    className={`min-h-[38px] w-full truncate rounded-lg py-2 pl-2.5 pr-14 text-left text-xs transition-colors ${
                      isSelected
                        ? 'bg-neutral-200 font-medium text-black dark:bg-neutral-800 dark:text-white'
                        : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900'
                    }`}
                    title={conv.title}
                  >
                    {conv.title}
                  </button>
                  <div className="absolute right-1 flex items-center gap-0.5 opacity-100 sm:opacity-0 transition-opacity sm:group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(conv.id);
                        setEditingTitle(conv.title);
                      }}
                      className="rounded p-1.5 text-neutral-400 hover:text-black dark:hover:text-white"
                      aria-label={`Rename ${conv.title}`}
                      title="Rename"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDeleteConversation(conv.id);
                      }}
                      className="rounded p-1.5 text-neutral-400 hover:text-black dark:hover:text-white"
                      aria-label={`Delete ${conv.title}`}
                      title="Delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Free Unlimited Status & Account Footer */}
      <div className="border-t border-neutral-200 p-3.5 space-y-2.5 dark:border-neutral-800/80">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">
            Free Unlimited Access
          </span>
          <span className="font-mono tabular-nums text-[11px] text-neutral-500">
            {membership.usage.totalChatsToday} chats today
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-neutral-200 pt-2.5 dark:border-neutral-800/80">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-xs font-semibold">{user.name}</span>
              <PlanBadge compact />
            </div>
            <p className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
              {user.isGuest ? 'Guest session' : user.email}
            </p>
          </div>
          {user.isGuest ? (
            <button
              type="button"
              onClick={() => {
                onOpenAuth();
                onCloseMobile();
              }}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-neutral-300 px-2.5 py-1.5 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800 whitespace-nowrap shrink-0"
            >
              <LogIn className="h-3.5 w-3.5" />
              <span>Sign In</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onLogout}
              className="min-h-[36px] min-w-[36px] rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-200 hover:text-black dark:hover:bg-neutral-800 dark:hover:text-white"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="text-[10px] text-neutral-500">
          TEJAS AI · भारत का अपना AI साथी · Mohit Jaat
        </div>
      </div>
    </aside>
  );

  return (
    <>
      {!desktopCollapsed && (
        <div className="hidden h-full shrink-0 lg:block">{navContent}</div>
      )}

      {isOpenMobile && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-black/60"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <div className="relative z-50 h-full">{navContent}</div>
        </div>
      )}
    </>
  );
}
