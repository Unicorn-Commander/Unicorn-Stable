import { useAppStore } from "@/stores/appStore";
import { usePresenterStore } from "@/stores/presenterStore";

export const OFFER_TITLE = "Hide other rooms and names while you present?";

/** Offer the local display filter once for the current presentation action. */
export function offerPresenterMode(): void {
  if (usePresenterStore.getState().enabled) return;
  const app = useAppStore.getState();
  if (app.toasts.some((toast) => toast.title === OFFER_TITLE)) return;
  app.pushToast({
    title: OFFER_TITLE,
    action: {
      label: "Turn on",
      onClick: () => usePresenterStore.getState().setEnabled(true),
    },
  });
}
