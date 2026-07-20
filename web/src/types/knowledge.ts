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

/**
 * One indexed chunk of a document's extracted text (the unit that gets
 * embedded + retrieved). `chunk_idx` is the document-order position.
 */
export interface DocumentChunk {
  chunk_idx: number;
  text: string;
}

/**
 * A document's human-readable extracted content — the chunks it was split into.
 * Fetched on demand when a user opens a document to read it. `chunks` is empty
 * when nothing is indexed (e.g. a `failed` doc or one still `indexing`).
 */
export interface DocumentContent {
  document_id: string;
  filename: string;
  status: KbDocumentStatus;
  chunk_count: number;
  chunks: DocumentChunk[];
}

/**
 * One ranked search hit — the SAME excerpts the room's agent retrieves. Returned
 * by the room-scoped knowledge search (searches every attached collection).
 */
export interface KnowledgeSearchHit {
  text: string;
  filename: string;
  score: number;
  /**
   * The locator. `collection_id` + `document_id` are what make a hit
   * clickable through to its source document (see `knowledgeStore.revealSource`
   * and the chat-citation path in `MessageBubble`). Null when retrieval could
   * not attribute the excerpt — such a hit renders as plain text, never as a
   * link that goes nowhere.
   */
  collection_id: string | null;
  document_id: string | null;
  chunk_idx: number | null;
}

/**
 * A room that would lose a knowledge base if it were deleted. Only rooms the
 * caller is a member of are named; the rest are counted in
 * {@link CollectionUsage.hidden_room_count}.
 */
export interface UsageRoom {
  id: string;
  display_name: string;
}

/**
 * What deleting a collection would take with it. Fetched when the user opens
 * the delete confirmation so the dialog can state WHAT breaks rather than
 * asking for a blind "are you sure?".
 */
export interface CollectionUsage {
  collection_id: string;
  document_count: number;
  room_count: number;
  rooms: UsageRoom[];
  hidden_room_count: number;
}

/* ----------------------------- request bodies ---------------------------- */

export interface CreateCollectionRequest {
  name: string;
  description?: string;
}
