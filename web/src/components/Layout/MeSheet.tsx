import { Activity, Bookmark, LogOut, Search, Settings, UserRound, X } from "lucide-react";
import { Identity, PhotoNudge, useSelfFace, useShowPhotoNudge } from "@/components/ui/Identity";
import { useModalA11y } from "@/hooks/useModalA11y";
import { identityFor } from "@/lib/identity";
import { requestOpenActivity } from "@/lib/shellEvents";
import { logout } from "@/services/auth";
import { useAppStore } from "@/stores/appStore";
import { useConversationUi } from "@/stores/conversationUiStore";

/**
 * The phone's Me tab (Nav v3 §2.6): the account actions that used to sit at
 * the foot of the drawer — and ate half of the Crew and Chats tabs — as a
 * bottom sheet: profile, People, Activity Center, Saved messages, Settings,
 * Sign out, plus the quick switcher the drawer strip carried.
 */
export function MeSheet() {
  const open = useConversationUi((s) => s.meSheetOpen);
  const close = useConversationUi((s) => s.closeMeSheet);
  const panelRef = useModalA11y(open, close);
  const currentUser = useAppStore((s) => s.currentUser);
  const setPeopleDrawerOpen = useAppStore((s) => s.setPeopleDrawerOpen);
  const setSavedOpen = useAppStore((s) => s.setSavedOpen);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const openSettings = useAppStore((s) => s.openSettings);
  const selfFace = useSelfFace();
  const showPhotoNudge = useShowPhotoNudge();
  const userIdent = identityFor(currentUser?.id, currentUser?.displayName);

  if (!open) return null;

  function run(fn: () => void) {
    close();
    fn();
  }

  const item =
    "focus-ring flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-white/[0.05]";

  return (
    <div
      className="fixed inset-0 z-[55] flex items-end justify-center bg-slate-950/70 backdrop-blur-sm md:hidden"
      onClick={close}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Me"
        data-testid="me-sheet"
        className="glass-heavy flex w-full flex-col rounded-t-2xl pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 pb-2 pt-4">
          <span
            className="inline-flex shrink-0 rounded-full"
            style={{ boxShadow: `0 0 0 2px ${userIdent.ring}` }}
          >
            <Identity {...selfFace} presence={null} size={40} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-100">{currentUser?.displayName}</p>
            <p className="truncate text-xs text-slate-400">{currentUser?.email}</p>
          </div>
          <button
            type="button"
            onClick={close}
            className="focus-ring rounded-md p-2 text-slate-400 hover:bg-white/[0.06] hover:text-slate-100"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {showPhotoNudge && (
          <div className="px-4 pb-2">
            <PhotoNudge onAdd={() => run(() => openSettings("appearance"))} />
          </div>
        )}
        <nav className="px-2 pb-1" aria-label="Account">
          <button type="button" className={item} onClick={() => run(() => setPeopleDrawerOpen(true))} data-testid="me-people">
            <UserRound className="h-4 w-4 text-slate-400" /> People
          </button>
          <button type="button" className={item} onClick={() => run(requestOpenActivity)} data-testid="me-activity">
            <Activity className="h-4 w-4 text-slate-400" /> Activity Center
          </button>
          <button type="button" className={item} onClick={() => run(() => setSavedOpen(true))} data-testid="me-saved">
            <Bookmark className="h-4 w-4 text-slate-400" /> Saved messages
          </button>
          <button
            type="button"
            className={item}
            onClick={() => run(() => useConversationUi.getState().requestQuickSwitcher())}
            data-testid="me-search"
          >
            <Search className="h-4 w-4 text-slate-400" /> Search everything
          </button>
          <button type="button" className={item} onClick={() => run(toggleSettings)} data-testid="open-settings">
            <Settings className="h-4 w-4 text-slate-400" /> Settings
          </button>
          <button
            type="button"
            className="focus-ring flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-rose-400 transition-colors hover:bg-rose-500/10"
            onClick={() => run(() => logout())}
            data-testid="me-sign-out"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </nav>
      </div>
    </div>
  );
}
