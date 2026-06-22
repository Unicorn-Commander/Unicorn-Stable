/**
 * Knowledge Bases — shared TypeScript types mirroring the backend API contract
 * (FastAPI). A "collection" is a named bucket of uploaded documents that gets
 * chunked + embedded; a room can have collections ATTACHED to it, and the room's
 * resident agent (Majik) searches those attached collections for context.
 *
 * Keep these shapes in lock-step with the server. See {@link ../services/api.ts}
 * for the calls. Field names match the contract exactly (the backend agent is
 * building to the same contract).
 */

/**
 * A knowledge collection (a bucket of documents). Returned by the create / list
 * / get collection endpoints and by the room-attachment listing.
 */
export interface Collection {
  id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Indexing lifecycle of an uploaded document. */
export type KbDocumentStatus = "indexing" | "ready" | "failed";

/**
 * A document uploaded into a collection. `status` reflects the async indexing
 * pipeline (chunk + embed); `chunk_count` is populated once `ready`.
 */
export interface KbDocument {
  id: string;
  filename: string;
  content_type: string;
  status: KbDocumentStatus;
  chunk_count: number;
  created_at: string;
}

/* ----------------------------- request bodies ---------------------------- */

export interface CreateCollectionRequest {
  name: string;
  description?: string;
}
