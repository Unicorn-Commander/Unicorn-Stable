---
id: knowledge
title: Knowledge and documents
section: Agents
order: 230
summary: Collections of documents an agent can search and answer from.
keywords: knowledge, kb, collection, document, upload, rag, attach, index, pdf, search
---

A **knowledge base** is a collection of documents. Attach one to a room and the
agents in that room can search it when they answer.

Open the **Knowledge** drawer from the room header.

## Build a collection

1. Create a collection — a name and an optional description.
2. Upload documents into it. Each document shows its indexing status; a
   document is only searchable once indexing finishes.
3. Search the collection directly from the drawer to check it found what you
   expect.

## Attach a collection to a room

Attach and detach from the same drawer. A collection can be attached to more
than one room; detaching from a room does not delete it.

## Documents you drop in the chat

A document attached to a message can also be indexed for that room, so you can
paste a file and immediately ask about it — no collection required.

This is best-effort by design: if indexing fails, your message still sends and
the agent still answers, just without the document as context.

## Limits

Uploads count against a per-user quota — a cap on total documents and total
bytes across all your collections. Embedding runs on a shared GPU, so upload
and create are rate limited.
