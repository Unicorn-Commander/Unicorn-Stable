/**
 * Web Crypto shim for INSECURE contexts (plain-HTTP LAN self-hosts).
 *
 * Browsers expose `crypto.randomUUID` and `crypto.subtle` only in secure
 * contexts (https:// or localhost). keycloak-js 26 hard-requires both —
 * `randomUUID` for OIDC state/nonce and `subtle.digest("SHA-256")` for the
 * PKCE S256 code challenge — and throws "Web Crypto API is not available."
 * during `init()` otherwise, which surfaced as a permanent "Authentication
 * unavailable" screen on http://<LAN-IP> self-hosted installs.
 *
 * Rather than downgrading to the plain code flow (dropping PKCE), fill in the
 * two missing members so the S256 flow works everywhere:
 *   - randomUUID: RFC 4122 v4 built on `getRandomValues`, which IS available
 *     in insecure contexts and is a real CSPRNG — entropy is not weakened.
 *   - subtle.digest: SHA-256 only, via the pure-JS js-sha256 implementation.
 *     Hashing a public code_verifier is not secret-dependent key material.
 *
 * The shim only defines what is missing and never touches secure contexts,
 * so https deployments keep the native implementations untouched. TLS is
 * still the recommended deployment for anything beyond a trusted LAN — see
 * DEPLOYMENT.md.
 */

import { sha256 } from "js-sha256";

type UuidString = `${string}-${string}-${string}-${string}-${string}`;

interface PatchableCrypto {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
  randomUUID?: () => UuidString;
  subtle?: SubtleCrypto;
}

export function makeRandomUuid(cryptoLike: PatchableCrypto): UuidString {
  const bytes = cryptoLike.getRandomValues(new Uint8Array(16));
  // RFC 4122 §4.4: version 4, variant 10xx.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as UuidString;
}

export function sha256Digest(data: BufferSource): ArrayBuffer {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return sha256.arrayBuffer(bytes);
}

/** Exported seam for tests; `install()` applies it to the real globals. */
export function installOnto(cryptoLike: PatchableCrypto, isSecureContext: boolean): void {
  if (isSecureContext) return; // never shadow native implementations
  if (typeof cryptoLike.randomUUID !== "function") {
    Object.defineProperty(cryptoLike, "randomUUID", {
      value: () => makeRandomUuid(cryptoLike),
      configurable: true,
    });
  }
  if (typeof cryptoLike.subtle === "undefined") {
    const subtle = {
      digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
        const name = typeof algorithm === "string" ? algorithm : algorithm.name;
        if (name !== "SHA-256") {
          return Promise.reject(
            new Error(`insecure-context crypto shim supports SHA-256 only (got ${name})`),
          );
        }
        return Promise.resolve(sha256Digest(data));
      },
    };
    Object.defineProperty(cryptoLike, "subtle", {
      value: subtle as unknown as SubtleCrypto,
      configurable: true,
    });
  }
}

/** Idempotent; call once before any auth code runs (see main.tsx). */
export function installInsecureContextCryptoShim(): void {
  if (typeof window === "undefined" || typeof window.crypto === "undefined") return;
  installOnto(window.crypto as unknown as PatchableCrypto, window.isSecureContext);
}
