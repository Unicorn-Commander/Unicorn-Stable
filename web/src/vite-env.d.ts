/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_KEYCLOAK_URL: string;
  readonly VITE_KEYCLOAK_REALM: string;
  readonly VITE_KEYCLOAK_CLIENT_ID: string;
  /** View-based sidebar shell (Slice 2). Default on; set "0"/"false" to disable. */
  readonly VITE_NAV_V1?: string;
  /**
   * One Conversations list (nav v2). Default on; set "0"/"false" to restore
   * the five-view shell. Overridden by localStorage `stable_nav_v2`.
   */
  readonly VITE_NAV_V2?: string;
  /**
   * Talking-face agent avatars on call stage tiles. Default **off** — set "1"
   * to make a whole deploy opt in. Per-user opt-in is
   * `localStorage["stable.talkingFace.v1"] = "1"` or `?talkingFace=1`.
   */
  readonly VITE_TALKING_FACE_V1?: string;
  /** Talking-face debug HUD (fps + which ladder rung rendered). Default off. */
  readonly VITE_TALKING_FACE_DEBUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
