import { describe, expect, it } from "vitest";
import type { SendMessageRequest } from "@/services/api";
import {
  buildSendRequest,
  CLIENT_CONTENT_TYPES,
  contentTypeForRequest,
  droppedMetadataKeys,
  SERVER_KEPT_METADATA_KEYS,
  type OutgoingSendRequest,
} from "@/lib/sendPipeline";
import { applySlashCommand } from "./MessageInput";

/** Every composer command that attaches metadata to the message it sends. */
const COMMANDS = [
  "/research how do runners discover rooms",
  "/facilitate who should take the kitchen panel",
  "/team who should take the kitchen panel",
  "/council is the cap right",
  '/poll "Ship today?" yes no',
];
const IMAGE = { url: "/files/a.png", filename: "a.png", content_type: "image/png", size: 10 };
const PDF = { url: "/files/a.pdf", filename: "a.pdf", content_type: "application/pdf", size: 10 };

function body(request: OutgoingSendRequest, model?: string | null) {
  return buildSendRequest({ clientMsgId: "cid-1", request }, model);
}

describe("what the web sends on message create", () => {
  it("carries only metadata keys the server keeps", () => {
    const keys = new Set<string>();
    for (const command of COMMANDS) {
      const composed = applySlashCommand(command);
      expect(composed.text).toBeTruthy();
      expect(Object.keys(composed.metadata ?? {})).not.toHaveLength(0);
      const sent = body({ content: composed.text!, attachments: [IMAGE], extraMetadata: composed.metadata });
      expect(droppedMetadataKeys(sent.metadata)).toEqual([]);
      for (const key of Object.keys(sent.metadata ?? {})) keys.add(key);
    }
    expect([...keys].sort()).toEqual(["attachments", "council", "facilitate", "poll", "research"]);
    for (const key of keys) expect(SERVER_KEPT_METADATA_KEYS).toContain(key);
  });

  it("sends plain text with no metadata at all, and the ACK id at the top level", () => {
    expect(applySlashCommand("hello there").metadata).toBeUndefined();
    expect(body({ content: "hello there" })).toEqual({
      content: "hello there",
      content_type: "text",
      client_msg_id: "cid-1",
    });
  });

  it("keeps the thread and the model override out of metadata", () => {
    const sent = body({ content: "hi", thread_id: "m-parent" }, "fable-5-1");
    expect(sent).toEqual({
      content: "hi",
      content_type: "text",
      client_msg_id: "cid-1",
      thread_id: "m-parent",
      model: "fable-5-1",
    });
    expect(body({ content: "hi" }, null).model).toBeUndefined();
  });

  it("never says content_type system (a 422 on the server)", () => {
    expect(CLIENT_CONTENT_TYPES).toEqual(["text", "action", "image", "file"]);
    expect(contentTypeForRequest({ content: "x" })).toBe("text");
    expect(contentTypeForRequest({ content: "", attachments: [IMAGE] })).toBe("image");
    expect(contentTypeForRequest({ content: "", attachments: [PDF] })).toBe("file");
    expect(contentTypeForRequest({ content: "x", content_type: "action" })).toBe("action");
    // A replayed snapshot is data from storage, not a typed value: a type a
    // client may not say is derived again instead of posted.
    const stale = { content: "x", content_type: "system" } as unknown as OutgoingSendRequest;
    expect(contentTypeForRequest(stale)).toBe("text");
    expect(body(stale).content_type).toBe("text");
    // And the request type has no such value.
    // @ts-expect-error "system" is the server's content type
    const typed: SendMessageRequest = { content: "x", content_type: "system" };
    expect(typed.content).toBe("x");
  });

  it("names the keys the server would drop", () => {
    expect(
      droppedMetadataKeys({ poll: {}, agent_id: "x", on_behalf_of: "y", gateway: true, via: "voice", client_msg_id: "c" }),
    ).toEqual(["agent_id", "on_behalf_of", "gateway", "via"]);
    expect(droppedMetadataKeys(null)).toEqual([]);
    expect(droppedMetadataKeys(undefined)).toEqual([]);
    expect(SERVER_KEPT_METADATA_KEYS).toEqual(["attachments", "research", "facilitate", "council", "poll", "client_msg_id"]);
  });
});
