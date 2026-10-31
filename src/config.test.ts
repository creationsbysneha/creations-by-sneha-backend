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

  it("still allows a phone on Wi-Fi to open the Vite app against the live API", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FRONTEND_ORIGIN", "https://creationsbysneha.in");
    const { isAllowedBrowserOrigin } = await import("./config.js");
    expect(isAllowedBrowserOrigin("https://creationsbysneha.in")).toBe(true);
    expect(isAllowedBrowserOrigin("http://192.168.1.7:5173")).toBe(true);
    expect(isAllowedBrowserOrigin("http://192.168.1.7:4000")).toBe(false);
    expect(isAllowedBrowserOrigin("https://creations-by-sneha-frontend.vercel.app")).toBe(true);
    expect(isAllowedBrowserOrigin("https://creations-by-sneha-frontend-git-main-team.vercel.app")).toBe(true);
    expect(isAllowedBrowserOrigin("https://evil.vercel.app")).toBe(false);
    expect(isAllowedBrowserOrigin("https://evil.example")).toBe(false);
  });
});

describe("trust proxy and session cookies", () => {
  it("trusts the proxy in production unless TRUST_PROXY is false", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY", "");
    expect((await import("./config.js")).config.trustProxy).toBe(true);
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY", "false");
    expect((await import("./config.js")).config.trustProxy).toBe(false);
  });

  it("uses SameSite=None on a different site so the browser will send the session", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { sessionCookieOptions } = await import("./config.js");
    const cross = sessionCookieOptions("http://localhost:5173", "creations-by-sneha-backend.onrender.com");
    expect(cross).toMatchObject({ sameSite: "none", secure: true, partitioned: true, httpOnly: true });
    const same = sessionCookieOptions("https://creationsbysneha.in", "api.creationsbysneha.in");
    expect(same).toMatchObject({ sameSite: "lax", secure: true });
    expect(same).not.toHaveProperty("partitioned");
  });

  it("keeps a plain Lax cookie for a phone on Wi-Fi using the Vite proxy in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { sessionCookieOptions } = await import("./config.js");
    const phone = sessionCookieOptions("http://192.168.1.7:5173", "127.0.0.1");
    expect(phone).toMatchObject({ sameSite: "lax", secure: false });
    expect(phone).not.toHaveProperty("partitioned");
  });
});

