import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("isAllowedBrowserOrigin", () => {
  it("allows the configured frontend origin and private LAN Vite origins in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("FRONTEND_ORIGIN", "http://localhost:5173");
    const { isAllowedBrowserOrigin } = await import("./config.js");
    expect(isAllowedBrowserOrigin(undefined)).toBe(true);
    expect(isAllowedBrowserOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedBrowserOrigin("http://192.168.1.7:5173")).toBe(true);
    expect(isAllowedBrowserOrigin("http://10.0.0.12:4173")).toBe(true);
    expect(isAllowedBrowserOrigin("http://172.16.4.2:5173")).toBe(true);
    expect(isAllowedBrowserOrigin("http://203.0.113.10:5173")).toBe(false);
    expect(isAllowedBrowserOrigin("http://192.168.1.7:4000")).toBe(false);
  });

  it("rejects LAN origins in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FRONTEND_ORIGIN", "https://creationsbysneha.in");
    const { isAllowedBrowserOrigin } = await import("./config.js");
    expect(isAllowedBrowserOrigin("https://creationsbysneha.in")).toBe(true);
    expect(isAllowedBrowserOrigin("http://192.168.1.7:5173")).toBe(false);
  });
});

