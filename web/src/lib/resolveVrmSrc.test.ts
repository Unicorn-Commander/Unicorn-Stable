import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_VRM_BYTES, resolveVrmSrc } from "./resolveVrmSrc";
import { configureRuntimeHosts } from "@/lib/runtimeHosts";

/* Node environment, like the rest of the repo's tests: this module only reads
 * `window.location.origin` / `.hostname`, so a two-field stub is enough. */
const WEB_ORIGIN = "https://stable.example.com";
const g = globalThis as unknown as {
  window?: { location: { origin: string; hostname: string } };
};

beforeAll(() => {
  g.window = {
    location: { origin: WEB_ORIGIN, hostname: "stable.example.com" },
  };
});

beforeEach(() => {
  configureRuntimeHosts([
    {
      webOrigin: "https://stable.example.com",
      trustedOrigins: ["https://cdn.example.com", "*.assets.example.com"],
    },
  ]);
});
afterAll(() => {
  delete g.window;
});

describe("resolveVrmSrc", () => {
  it("resolves a bundle path against the WEB origin, not the API origin", () => {
    // The bug this exists to prevent: toAvatarSrc() rewrites "/x" onto the API
    // base (:8400), where web/public assets do not exist, so every model 404s.
    const out = resolveVrmSrc("/agent-vrm/majik-v1.vrm");
    expect(out).toBe(`${WEB_ORIGIN}/agent-vrm/majik-v1.vrm`);
    expect(out).not.toContain(":8400");
  });

  it("accepts https on our own hosts", () => {
    expect(resolveVrmSrc("https://brigade.assets.example.com/vrm/majik.vrm")).toBe(
      "https://brigade.assets.example.com/vrm/majik.vrm",
    );
    expect(resolveVrmSrc("https://cdn.example.com/a.vrm")).toBe(
      "https://cdn.example.com/a.vrm",
    );
    expect(resolveVrmSrc("https://x.assets.example.com/a.vrm")).toBe(
      "https://x.assets.example.com/a.vrm",
    );
  });

  it("rejects a lookalike host", () => {
    // Suffix matching must be on the parsed hostname with a dot boundary.
    expect(resolveVrmSrc("https://assets.example.com.evil.com/a.vrm")).toBeNull();
    expect(resolveVrmSrc("https://notassets.example.com/a.vrm")).toBeNull();
    expect(resolveVrmSrc("https://evil.com/assets.example.com/a.vrm")).toBeNull();
  });

  it("rejects non-https and pseudo schemes", () => {
    expect(resolveVrmSrc("http://cdn.example.com/a.vrm")).toBeNull();
    expect(resolveVrmSrc("javascript:alert(1)")).toBeNull();
    expect(resolveVrmSrc("data:application/octet-stream;base64,AAAA")).toBeNull();
    expect(resolveVrmSrc("blob:https://cdn.example.com/abc")).toBeNull();
  });

  it("rejects protocol-relative URLs", () => {
    // "//evil.com/x.vrm" is absolute wearing a relative costume, so it has to
    // be checked BEFORE the leading-slash shortcut.
    expect(resolveVrmSrc("//evil.com/x.vrm")).toBeNull();
  });

  it("is safe on missing or malformed input", () => {
    expect(resolveVrmSrc(null)).toBeNull();
    expect(resolveVrmSrc(undefined)).toBeNull();
    expect(resolveVrmSrc("")).toBeNull();
    expect(resolveVrmSrc("   ")).toBeNull();
    expect(resolveVrmSrc("not a url")).toBeNull();
  });

  it("caps a model at 6 MB", () => {
    expect(MAX_VRM_BYTES).toBe(6 * 1024 * 1024);
  });
});
