import { vi } from "vitest";

/**
 * Stand-in for Next's Data Cache: `unstable_cache(fn, keyParts)` memoizes by
 * (keyParts, args) for the life of the store — like the real shared cache, a
 * thrown error is not cached. Tests share one store so they can model several
 * serverless instances reading the same cache.
 */
export const sharedCache = new Map<string, unknown>();

export function mockNextCache() {
  return {
    unstable_cache:
      <A extends unknown[], R>(fn: (...args: A) => Promise<R>, keyParts: string[] = []) =>
      async (...args: A): Promise<R> => {
        const k = JSON.stringify([keyParts, args]);
        if (sharedCache.has(k)) return sharedCache.get(k) as R;
        const v = await fn(...args);
        sharedCache.set(k, v);
        return v;
      },
    revalidateTag: () => {},
  };
}

/**
 * Stand-in for Vercel's Runtime Cache (`getCache()` from @vercel/functions): a
 * plain key-value store with TTLs, shared by every "instance" in a test.
 */
export const runtimeCache = new Map<string, { value: unknown; expires: number }>();

export function mockVercelFunctions() {
  return {
    getCache: (opts?: { namespace?: string }) => {
      const k = (key: string) => `${opts?.namespace ?? ""}$${key}`;
      return {
        get: async (key: string) => {
          const e = runtimeCache.get(k(key));
          if (!e || e.expires <= Date.now()) return null;
          return e.value;
        },
        set: async (key: string, value: unknown, o?: { ttl?: number }) => {
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
