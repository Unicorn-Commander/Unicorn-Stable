import { describe, expect, it } from "vitest";
import { parseSearchQuery, removeOperatorToken } from "./searchOperators";

describe("parseSearchQuery", () => {
  it("returns plain text untouched with no operators", () => {
    expect(parseSearchQuery("deploy finished")).toEqual({
      query: "deploy finished",
      operators: {},
    });
  });

  it("extracts every supported operator", () => {
    const { query, operators } = parseSearchQuery(
      "from:@alice in:#general has:file before:2026-08-01 after:2026-07-01 rollout",
    );
    expect(query).toBe("rollout");
    expect(operators).toEqual({
      from: "@alice",
      in: "#general",
      has: "file",
      before: "2026-08-01",
      after: "2026-07-01",
    });
  });

  it("is case-insensitive on the operator key", () => {
    const { operators } = parseSearchQuery("From:Alice BEFORE:2026-01-01");
    expect(operators.from).toBe("Alice");
    expect(operators.before).toBe("2026-01-01");
  });

  it("collapses the hole an extracted operator leaves in the free text", () => {
    // Without normalization this would be "hello  world" (double space) and
    // the backend ILIKE would no longer match "hello world".
    expect(parseSearchQuery("hello from:alice world").query).toBe(
      "hello world",
    );
  });

  it("leaves non-operator colon words alone", () => {
    expect(parseSearchQuery("deploy:prod note:self")).toEqual({
      query: "deploy:prod note:self",
      operators: {},
    });
  });

  it("keeps the last value when an operator repeats", () => {
    const { operators, query } = parseSearchQuery("from:alice from:bob hi");
    expect(operators.from).toBe("bob");
    expect(query).toBe("hi");
  });
});

describe("removeOperatorToken", () => {
  it("removes exactly the named token and tidies whitespace", () => {
    expect(removeOperatorToken("hello from:alice world", "from", "alice")).toBe(
      "hello world",
    );
  });

  it("matches the operator key case-insensitively (chip vs typed casing)", () => {
    expect(removeOperatorToken("From:Alice hi", "from", "Alice")).toBe("hi");
  });

  it("regex-escapes the value — from:j.doe must not eat from:jxdoe", () => {
    expect(removeOperatorToken("from:jxdoe stays", "from", "j.doe")).toBe(
      "from:jxdoe stays",
    );
    expect(removeOperatorToken("from:j.doe goes", "from", "j.doe")).toBe(
      "goes",
    );
  });

  it("only removes whole tokens at whitespace boundaries", () => {
    expect(
      removeOperatorToken("prefrom:alice from:alice", "from", "alice"),
    ).toBe("prefrom:alice");
  });

  it("handles the token at start, middle, and end", () => {
    expect(removeOperatorToken("has:file rest", "has", "file")).toBe("rest");
    expect(removeOperatorToken("a has:file b", "has", "file")).toBe("a b");
    expect(removeOperatorToken("a has:file", "has", "file")).toBe("a");
  });
});
