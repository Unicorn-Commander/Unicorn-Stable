import { describe, expect, it, vi } from "vitest";
import {
  DEV_BUILD_VERSION,
  SERVICE_WORKER_SCOPE,
  buildVersion,
  registerServiceWorker,
  serviceWorkerUrl,
} from "./serviceWorker";

describe("the service worker's URL", () => {
  it("names the build, so every release is a new cache key at the edge", () => {
    expect(serviceWorkerUrl("56c2450")).toBe("/sw.js?v=56c2450");
    expect(serviceWorkerUrl(" 56c2450 ")).toBe("/sw.js?v=56c2450");
  });

  it("is stable where the build has no sha (the dev server)", () => {
    expect(serviceWorkerUrl(undefined)).toBe(`/sw.js?v=${DEV_BUILD_VERSION}`);
    expect(serviceWorkerUrl("")).toBe("/sw.js?v=dev");
    expect(buildVersion(null)).toBe("dev");
    // The Dockerfile's own default is kept as given: it is still one stable key.
    expect(serviceWorkerUrl("unknown")).toBe("/sw.js?v=unknown");
  });

  it("is safe to put in a query string", () => {
    expect(serviceWorkerUrl("a b&c")).toBe("/sw.js?v=a%20b%26c");
  });
});

describe("registering it", () => {
  it("asks for the versioned URL at the root scope, so the old registration is updated, not doubled", async () => {
    const registration = {} as ServiceWorkerRegistration;
    const register = vi.fn(async () => registration);
    await expect(registerServiceWorker({ register }, "56c2450")).resolves.toBe(registration);
    expect(register).toHaveBeenCalledWith("/sw.js?v=56c2450", { scope: SERVICE_WORKER_SCOPE });
    expect(SERVICE_WORKER_SCOPE).toBe("/");
  });

  it("never throws: a failed registration leaves the app alone", async () => {
    const register = vi.fn(async () => Promise.reject(new DOMException("SecurityError")));
    await expect(registerServiceWorker({ register }, "56c2450")).resolves.toBeNull();
    await expect(registerServiceWorker(undefined, "56c2450")).resolves.toBeNull();
  });
});
