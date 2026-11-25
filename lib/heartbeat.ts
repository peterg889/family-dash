/**
 * "Is the sign still checking in?" — the E-Ink device adds `?device=eink` to
 * its requests; each one stamps the time here, and the API reports the last
 * stamp so the hourly health check can notice a sign that has gone quiet.
 * Stored in Vercel's Runtime Cache (shared across instances and deployments).
 */
import { getCache } from "@vercel/functions";

const KEEP_S = 30 * 24 * 3600;
const store = () => getCache({ namespace: "device" });

/** A device id from the query string, or null if absent / not a plain token. */
export function deviceId(raw: string | null): string | null {
  return raw && /^[a-z0-9-]{1,24}$/.test(raw) ? raw : null;
}

export async function recordHeartbeat(id: string): Promise<void> {
  try {
    await store().set(`seen:${id}`, Date.now(), { ttl: KEEP_S, name: `device:${id}` });
  } catch {
    // never let bookkeeping break the board
  }
}

/** Epoch ms of the device's last request, or null if never seen / unknown. */
export async function lastSeen(id: string): Promise<number | null> {
  try {
    const v = await store().get(`seen:${id}`);
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}
