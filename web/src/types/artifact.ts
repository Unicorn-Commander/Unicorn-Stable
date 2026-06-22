/**
 * Canvas / Artifacts — shared TypeScript types mirroring the backend API
 * contract (FastAPI). These shapes are the wire format for the artifact
 * endpoints and the LiveKit data-channel broadcasts; keep them in lock-step
 * with the server. See {@link ../services/api.ts} for the calls and
 * {@link ../lib/roomDataProtocol.ts} for the broadcast envelope.
 */

/** The kinds of artifact the canvas can hold + render. */
export type ArtifactKind =
  | "markdown"
  | "code"
  | "html"
  | "svg"
  | "mermaid"
  | "react"
  | "sheet";

/** Who authored a version — a human via the UI, or an agent (Majik). */
export type ArtifactAuthorKind = "human" | "agent";

/**
 * An artifact as returned by the create / list / get endpoints. `content` and
 * `current_seq` are only populated by the single-artifact GET (and create);
 * the room LIST endpoint may return them null (metadata-only listing).
 */
export interface ArtifactResponse {
  id: string;
  room_id: string;
  org_id: string | null;
  title: string;
  kind: ArtifactKind;
  language: string | null;
  current_version_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Full text of the current version. Null in metadata-only listings. */
  content: string | null;
  /** Seq number of the current version. Null in metadata-only listings. */
  current_seq: number | null;
}

/**
 * One immutable version of an artifact. `seq` increases monotonically from 1;
 * `edit_op` records the diff/rewrite that produced this version (null for the
 * initial content).
 */
export interface VersionResponse {
  id: string;
  artifact_id: string;
  seq: number;
  content: string;
  parent_version_id: string | null;
  author_kind: ArtifactAuthorKind;
  author_id: string | null;
  edit_op: Record<string, unknown> | null;
  created_at: string;
}

/* ----------------------------- request bodies ---------------------------- */

export interface CreateArtifactRequest {
  title: string;
  kind?: ArtifactKind;
  content?: string;
  language?: string;
}

export interface RewriteArtifactRequest {
  content: string;
  summary?: string;
}

/** One search/replace block for the agent-style {@link EditArtifactRequest}. */
export interface ArtifactEditBlock {
  search: string;
  replace: string;
  replace_all?: boolean;
}

export interface EditArtifactRequest {
  edits: ArtifactEditBlock[];
  summary?: string;
}

export interface RestoreArtifactRequest {
  version_id: string;
}

/**
 * Per-block error body returned with HTTP 422 from the `/edit` endpoint when
 * one or more search blocks don't match. The exact server shape isn't fully
 * pinned, so this is intentionally permissive — surface whatever detail is
 * present rather than crash. `api.ts` raises an {@link ApiError}; this type
 * documents the `detail` payload we try to read off it.
 */
export interface ArtifactEditError {
  /** Indices of the edit blocks that failed to match, if the server lists them. */
  failed_blocks?: number[];
  /** Human-readable per-block messages, if present. */
  errors?: Array<{ index?: number; search?: string; message?: string }>;
  /** Fallback message. */
  message?: string;
}
