import { useEffect, useState, type ReactNode } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { initAuth, isAuthenticated, login, getUserProfile } from "@/services/auth";
import { ws } from "@/services/websocket";
import { useAppStore } from "@/stores/appStore";
import { AppShell } from "@/components/Layout/AppShell";
import { StableMark } from "@/components/StableMark";
import { VoiceProvider } from "@/contexts/VoiceProvider";

function AuthGate({ children }: { children: ReactNode }) {
  const [authReady, setAuthReady] = useState(false);
  const [authFailed, setAuthFailed] = useState(false);
  const setCurrentUser = useAppStore((s) => s.setCurrentUser);

  useEffect(() => {
    let mounted = true;

    async function checkAuth() {
      try {
        const authenticated = await initAuth();
        if (!mounted) return;

        if (authenticated) {
          const profile = getUserProfile();
          if (profile) {
            setCurrentUser({
              id: profile.id,
              username: profile.username,
              displayName: profile.displayName,
              email: profile.email,
              avatarUrl: profile.avatarUrl,
              roles: profile.roles,
            });
          }
          ws.connect();
        }
        setAuthReady(true);
      } catch {
        if (!mounted) return;
        setAuthFailed(true);
        setAuthReady(true);
      }
    }

    checkAuth();
    return () => {
      mounted = false;
    };
  }, [setCurrentUser]);

  if (!authReady) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-900">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-stable-purple border-t-transparent" />
          <p className="text-sm text-slate-400">
            Connecting to the Stable…
          </p>
        </div>
      </div>
    );
  }

  // In dev mode without Keycloak, seed a mock user so the UI is explorable
  if (authFailed || !isAuthenticated()) {
    const isDev = import.meta.env.DEV;
    if (isDev) {
      const now = new Date().toISOString();
      const hourAgo = new Date(Date.now() - 3600000).toISOString();
      const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();

      // Seed a dev user into the store so the shell renders
      setCurrentUser({
        id: "dev-user-001",
        username: "aaron",
        displayName: "Aaron Stransky",
        email: "aaron@magicunicorn.dev",
        avatarUrl: null,
        roles: ["admin"],
      });

      const store = useAppStore.getState();

      // Seed rooms
      store.setRooms([
        {
          id: "room-general",
          name: "general",
          description: "General discussion for the team",
          type: "channel",
          created_at: now,
          updated_at: now,
          member_count: 8,
          unread_count: 2,
          last_message: {
            id: "msg-1", room_id: "room-general", sender_id: "user-jason",
            sender_type: "human", sender_name: "Nate Ellison", sender_avatar: null,
            content: "Hey team, the new deploy is live", content_type: "text",
            thread_id: null, reply_count: 0, edited: false, created_at: now, updated_at: now, metadata: {},
          },
          members: [],
          agents: [],
        },
        {
          id: "room-ops",
          name: "ops",
          description: "Operations & infrastructure",
          type: "channel",
          created_at: now,
          updated_at: now,
          member_count: 5,
          unread_count: 0,
          last_message: {
            id: "msg-2", room_id: "room-ops", sender_id: "agent-triage",
            sender_type: "agent", sender_name: "Triage Agent", sender_avatar: null,
            content: "GPU temps nominal across the board", content_type: "text",
            thread_id: null, reply_count: 0, edited: false, created_at: hourAgo, updated_at: hourAgo, metadata: {},
          },
          members: [],
          agents: [],
        },
        {
          id: "room-dev",
          name: "dev",
          description: "Development chat",
          type: "channel",
          created_at: now,
          updated_at: now,
          member_count: 4,
          unread_count: 5,
          last_message: {
            id: "msg-3", room_id: "room-dev", sender_id: "agent-coder",
            sender_type: "agent", sender_name: "Coder", sender_avatar: null,
            content: "PR #42 ready for review - added the new API endpoints", content_type: "text",
            thread_id: null, reply_count: 3, edited: false, created_at: now, updated_at: now, metadata: {},
          },
          members: [],
          agents: [],
        },
        {
          id: "room-dm-jason",
          name: "dm-jason",
          description: "",
          type: "dm",
          created_at: now,
          updated_at: now,
          member_count: 2,
          unread_count: 1,
          last_message: {
            id: "msg-4", room_id: "room-dm-jason", sender_id: "user-jason",
            sender_type: "human", sender_name: "Nate Ellison", sender_avatar: null,
            content: "Got the Summit Medical meeting confirmed for Thursday", content_type: "text",
            thread_id: null, reply_count: 0, edited: false, created_at: twoHoursAgo, updated_at: twoHoursAgo, metadata: {},
          },
          members: [],
          agents: [],
        },
      ]);

      // Seed agents
      store.setAgents([
        { id: "agent-triage", name: "Triage", display_name: "Triage Agent", description: "Routes requests and coordinates", avatar_url: null, status: "active", capabilities: ["routing", "summarization", "ticket-creation"], model: "claude-sonnet-4-20250514" },
        { id: "agent-analyst", name: "Deep Analyst", display_name: "Deep Analyst", description: "Research and analysis", avatar_url: null, status: "idle", capabilities: ["research", "analysis", "data-viz"], model: "claude-sonnet-4-20250514" },
        { id: "agent-coder", name: "Coder", display_name: "Coder Agent", description: "Writes and reviews code", avatar_url: null, status: "working", capabilities: ["code-gen", "code-review", "debugging"], model: "claude-sonnet-4-20250514" },
      ]);

      // Seed some messages for #general
      store.setMessages("room-general", {
        items: [
          { id: "m1", room_id: "room-general", sender_id: "agent-triage", sender_type: "agent", sender_name: "Triage Agent", sender_avatar: null, content: "Good morning. All systems green. LiveKit server is healthy, 3 agents online.", content_type: "text", thread_id: null, reply_count: 0, edited: false, created_at: new Date(Date.now() - 3600000 * 3).toISOString(), updated_at: new Date(Date.now() - 3600000 * 3).toISOString(), metadata: {} },
          { id: "m2", room_id: "room-general", sender_id: "dev-user-001", sender_type: "human", sender_name: "Aaron Stransky", sender_avatar: null, content: "Perfect. @triage can you check on the commander deployment?", content_type: "text", thread_id: null, reply_count: 1, edited: false, created_at: new Date(Date.now() - 3600000 * 2).toISOString(), updated_at: new Date(Date.now() - 3600000 * 2).toISOString(), metadata: {} },
          { id: "m3", room_id: "room-general", sender_id: "agent-triage", sender_type: "agent", sender_name: "Triage Agent", sender_avatar: null, content: "Commander is up and serving. All 5 subdomains responding. Last deploy was 6 hours ago, no errors in the logs.", content_type: "text", thread_id: null, reply_count: 0, edited: false, created_at: new Date(Date.now() - 3600000 * 2 + 30000).toISOString(), updated_at: new Date(Date.now() - 3600000 * 2 + 30000).toISOString(), metadata: {} },
          { id: "m4", room_id: "room-general", sender_id: "user-jason", sender_type: "human", sender_name: "Nate Ellison", sender_avatar: null, content: "Hey team, the new deploy is live", content_type: "text", thread_id: null, reply_count: 0, edited: false, created_at: now, updated_at: now, metadata: {} },
        ],
        nextCursor: null,
        hasMore: false,
        loading: false,
      });

      // Seed participants for #general
      store.setParticipants("room-general", [
        { user_id: "dev-user-001", username: "aaron", display_name: "Aaron Stransky", avatar_url: null, role: "owner", is_online: true, joined_at: now },
        { user_id: "user-jason", username: "jason", display_name: "Nate Ellison", avatar_url: null, role: "admin", is_online: true, joined_at: now },
        { user_id: "agent-triage", username: "triage", display_name: "Triage Agent", avatar_url: null, role: "member", is_online: true, joined_at: now },
        { user_id: "agent-analyst", username: "analyst", display_name: "Deep Analyst", avatar_url: null, role: "member", is_online: true, joined_at: now },
        { user_id: "agent-coder", username: "coder", display_name: "Coder Agent", avatar_url: null, role: "member", is_online: false, joined_at: now },
      ]);

      // NB: we deliberately do NOT auto-select a room here. The URL (route param)
      // is the single source of truth for the active room (see AppShell). In dev
      // you land on the welcome empty-state; click a seeded channel to open it
      // (which navigates to /c/:roomId). Setting activeRoomId here would just be
      // clobbered by the route->store effect on the "/" route anyway.

      return <>{children}</>;
    }

    if (authFailed) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-slate-900">
          <div className="glass flex max-w-md flex-col items-center gap-4 rounded-2xl p-8 text-center">
            <h1 className="text-xl font-semibold text-slate-50">
              Authentication unavailable
            </h1>
            <p className="text-sm text-slate-400">
              Could not connect to the authentication service. Check your
              configuration and try again.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg bg-stable-purple px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-stable-purple-light"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-900">
        <div className="glass flex max-w-md flex-col items-center gap-6 rounded-2xl p-8 text-center">
          <div className="flex flex-col items-center gap-3">
            <StableMark className="h-14 w-14 drop-shadow-[0_0_24px_rgba(139,92,246,0.45)]" />
            <h1 className="gradient-text font-display text-4xl font-bold tracking-tight">
              Stable
            </h1>
            <p className="text-sm text-slate-400">
              Where your team and your AI agents live
            </p>
          </div>
          <button
            onClick={() => login()}
            className="gradient-bg w-full rounded-lg px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export function App() {
  return (
    // reducedMotion="user": every framer-motion transform/entrance in the tree
    // collapses to opacity-only when the OS asks for reduced motion (the CSS
    // animate-* utilities are neutralized in globals.css).
    <MotionConfig reducedMotion="user">
    <AuthGate>
      <VoiceProvider>
      <Routes>
        {/* Login is vestigial -- auth is a top-level Keycloak redirect, so just
            bounce any stale /login deep-link home. */}
        <Route path="/login" element={<Navigate to="/" replace />} />
        {/* Canonical room route + its empty-state sibling. /c/:roomId is the
            SINGLE source of truth for the active room (see AppShell); the
            ?message= query param rides along for permalink scroll/highlight. */}
        <Route path="/c/:roomId" element={<AppShell />} />
        {/* Agent roster / org-chart view — a top-level page rendered inside
            AppShell (keeps the sidebar + header). */}
        <Route path="/agents" element={<AppShell />} />
        {/* Bridge / Connect page — how to wire an MCP client (Claude etc.) to
            this Stable workspace. Top-level page inside AppShell. */}
        <Route path="/bridge" element={<AppShell />} />
        <Route path="/" element={<AppShell />} />
        {/* Unknown paths fall back home. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </VoiceProvider>
    </AuthGate>
    </MotionConfig>
  );
}
