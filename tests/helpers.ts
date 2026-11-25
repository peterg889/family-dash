import { vi } from "vitest";

/**
 * Stand-in for Vercel's Runtime Cache (`getCache()` from @vercel/functions): a
 * plain key-value store with TTLs, shared by every "instance" in a test.
 */
export const runtimeCache = new Map<string, { value: unknown; expires: number }>();
/** Set true to make every cache call throw, as if the cache service were down. */
export const runtimeCacheState = { broken: false };

export function mockVercelFunctions() {
  return {
    getCache: (opts?: { namespace?: string }) => {
      const k = (key: string) => `${opts?.namespace ?? ""}$${key}`;
      return {
        get: async (key: string) => {
          if (runtimeCacheState.broken) throw new Error("cache down");
          const e = runtimeCache.get(k(key));
          if (!e || e.expires <= Date.now()) return null;
          return e.value;
        },
        set: async (key: string, value: unknown, o?: { ttl?: number }) => {
          if (runtimeCacheState.broken) throw new Error("cache down");
          runtimeCache.set(k(key), {
            value,
            expires: o?.ttl ? Date.now() + o.ttl * 1000 : Infinity,
          });
        },
        delete: async (key: string) => void runtimeCache.delete(k(key)),
        expireTag: async () => {},
      };
    },
  };
}

export type Call = { url: string; body: string };

/** Install a fake global fetch; `handler` gets (url, bodyText) and returns a Response or throws. */
export function stubFetch(handler: (url: string, body: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ url, body });
      return handler(url, body);
    })
  );
  return calls;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Epoch ms of a New York wall-clock time given as UTC parts + the offset in hours. */
export const utc = (y: number, mo: number, d: number, h: number, mi = 0) =>
  Date.UTC(y, mo - 1, d, h, mi);
