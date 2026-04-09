import { useEffect, useState, type ReactNode } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { initAuth, isAuthenticated, login, getUserProfile } from "@/services/auth";
import { ws } from "@/services/websocket";
import { useAppStore } from "@/stores/appStore";
import { AppShell } from "@/components/Layout/AppShell";

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
          <p className="text-sm text-slate-400">Connecting to Stable...</p>
        </div>
      </div>
    );
  }

  if (authFailed) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-900">
        <div className="glass flex max-w-md flex-col items-center gap-4 rounded-2xl p-8 text-center">
          <h1 className="text-xl font-semibold text-slate-50">
            Authentication Unavailable
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

  if (!isAuthenticated()) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-900">
        <div className="glass flex max-w-md flex-col items-center gap-6 rounded-2xl p-8 text-center">
          <div className="flex flex-col items-center gap-2">
            <h1 className="gradient-text text-3xl font-bold">Stable</h1>
            <p className="text-sm text-slate-400">
              Where humans and AI meet
            </p>
          </div>
          <button
            onClick={() => login()}
            className="gradient-bg w-full rounded-lg px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Sign In
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          isAuthenticated() ? (
            <Navigate to="/" replace />
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route
        path="/*"
        element={
          <AuthGate>
            <AppShell />
          </AuthGate>
        }
      />
    </Routes>
  );
}
