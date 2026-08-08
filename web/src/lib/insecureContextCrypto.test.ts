import { describe, expect, it } from "vitest";
import { installOnto, makeRandomUuid, sha256Digest } from "./insecureContextCrypto";

type UuidString = `${string}-${string}-${string}-${string}-${string}`;
interface TestCrypto {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
  randomUUID?: () => UuidString;
  subtle?: SubtleCrypto;
}

function bareCrypto(): TestCrypto {
  // Simulates an insecure browser context: getRandomValues exists,
  // randomUUID and subtle do not. (vitest's Node environment exposes the
  // real Web Crypto on globalThis.crypto — we borrow only getRandomValues.)
  return {
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      return globalThis.crypto.getRandomValues(array as never) as T;
    },
  };
}

const toHex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

describe("insecureContextCrypto", () => {
  it("produces RFC 4122 v4 UUIDs", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const uuid = makeRandomUuid(bareCrypto());
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      seen.add(uuid);
    }
    expect(seen.size).toBe(200);
  });

  it("digests SHA-256 identically to native Web Crypto", async () => {
    // Known vector: SHA-256("abc")
    const abc = new TextEncoder().encode("abc");
    expect(toHex(sha256Digest(abc))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // And agree with the platform implementation on arbitrary input,
    // including a non-zero-offset view (keycloak-js passes plain encodes,
    // but the shim must honour BufferSource semantics).
    const raw = new TextEncoder().encode("xxstable-code-verifier-123");
    const view = new Uint8Array(raw.buffer, 2, raw.byteLength - 2);
    const native = await globalThis.crypto.subtle.digest("SHA-256", view);
    expect(toHex(sha256Digest(view))).toBe(toHex(native));
  });

  it("fills only the missing members in an insecure context", async () => {
    const c = bareCrypto();
    installOnto(c, false);
    expect(typeof c.randomUUID).toBe("function");
    expect(c.randomUUID!()).toMatch(/^[0-9a-f-]{36}$/);
    const digest = await c.subtle!.digest("SHA-256", new TextEncoder().encode("abc"));
    expect(toHex(digest)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    await expect(c.subtle!.digest("SHA-1", new Uint8Array(1))).rejects.toThrow(
      /SHA-256 only/,
    );
  });

  it("never shadows native implementations in a secure context", () => {
    const marker = (() => "native") as unknown as () => UuidString;
    const c: TestCrypto = { ...bareCrypto(), randomUUID: marker };
    installOnto(c, true);
    expect(c.randomUUID).toBe(marker);
    expect(c.subtle).toBeUndefined();
  });
});
