/**
 * Drive time from home to a destination, using the Google Routes API
 * (traffic-aware). Returns seconds, or null when no API key is configured or
 * the request fails — callers should treat null as "drive time unavailable".
 *
 * Set GOOGLE_MAPS_API_KEY (a Google Cloud key with the Routes API enabled).
 * HOME_ADDRESS overrides the default origin.
 */

export const HOME_ADDRESS =
  process.env.HOME_ADDRESS ?? "47 Corey Lane, Mendham, NJ 07945";

// Drive times between fixed points barely move minute-to-minute, so cache per
// destination to keep Google calls cheap under the 30s client refresh.
const TTL_MS = 5 * 60_000;
const cache = new Map<string, { sec: number; at: number }>();

type LatLon = { lat: number; lon: number };

/** A Google Routes "waypoint" destination — a coordinate or an address. */
type Destination = { location: { latLng: { latitude: number; longitude: number } } } | { address: string };

async function driveSeconds(
  key: string,
  destination: Destination,
  now: number
): Promise<number | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.sec;

  try {
    const res = await fetch(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "routes.duration",
        },
        body: JSON.stringify({
          origin: { address: HOME_ADDRESS },
          destination,
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_AWARE",
        }),
        // Don't let a slow routing call hang the whole board.
        signal: AbortSignal.timeout(4000),
      }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const dur: string | undefined = json?.routes?.[0]?.duration; // e.g. "934s"
    if (!dur) return null;
    const sec = parseInt(dur, 10);
    if (!Number.isFinite(sec)) return null;
    cache.set(key, { sec, at: now });
    return sec;
  } catch {
    return null;
  }
}

/** Drive time home -> a lat/lon point (e.g. a train station). */
export function driveSecondsTo(
  key: string,
  dest: LatLon,
  now: number = Date.now()
): Promise<number | null> {
  if (!dest) return Promise.resolve(null);
  return driveSeconds(
    key,
    { location: { latLng: { latitude: dest.lat, longitude: dest.lon } } },
    now
  );
}

/** Drive time home -> an address string (Google geocodes it). */
export function driveSecondsToAddress(
  key: string,
  address: string,
  now: number = Date.now()
): Promise<number | null> {
  return driveSeconds(key, { address }, now);
}
