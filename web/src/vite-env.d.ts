/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_KEYCLOAK_URL: string;
  readonly VITE_KEYCLOAK_REALM: string;
  readonly VITE_KEYCLOAK_CLIENT_ID: string;
  /** View-based sidebar shell (Slice 2). Default on; set "0"/"false" to disable. */
  readonly VITE_NAV_V1?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
