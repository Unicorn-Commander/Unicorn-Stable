import { describe, expect, it } from "vitest";
import { stripMarkdown } from "./messagePreview";

describe("stripMarkdown", () => {
  it("leaves plain text alone", () => {
    expect(stripMarkdown("just a normal sentence.")).toBe(
      "just a normal sentence.",
    );
  });

  it("unwraps bold, italic, and strikethrough", () => {
    expect(stripMarkdown("**Done** — _mostly_ and ~~cancelled~~")).toBe(
      "Done — mostly and cancelled",
    );
    expect(stripMarkdown("__strong__ and *soft*")).toBe("strong and soft");
  });

  it("fully unwraps nested emphasis", () => {
    expect(stripMarkdown("***very important***")).toBe("very important");
  });

  it("keeps link text and image alt, drops the urls", () => {
    expect(stripMarkdown("see [the report](https://x.test/r) now")).toBe(
      "see the report now",
    );
    expect(stripMarkdown("shot: ![dashboard](https://x.test/a.png)")).toBe(
      "shot: dashboard",
    );
  });

  it("keeps code, drops backticks and fences", () => {
    expect(stripMarkdown("run `npm test` first")).toBe("run npm test first");
    expect(stripMarkdown("```bash\nnpm run build\n```")).toBe(
      "\nnpm run build\n",
    );
  });

  it("drops line-leading structure markers", () => {
    expect(stripMarkdown("## Status\n- one\n- two\n> quoted\n1. first")).toBe(
      "Status\none\ntwo\nquoted\nfirst",
    );
  });

  it("does not eat asterisks or underscores mid-word", () => {
    expect(stripMarkdown("2*3*4 and snake_case_name")).toBe(
      "2*3*4 and snake_case_name",
    );
  });
});
