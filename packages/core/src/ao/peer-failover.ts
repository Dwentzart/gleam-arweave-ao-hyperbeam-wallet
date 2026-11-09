import type { NetworkSettings } from "../models/network";

/** Caps how many peers one read tries, so a dead network costs a few timeouts, not one per listed node. */
const MAX_FAILOVER_ATTEMPTS = 3;

/**
 * The peers to read from, in order: the active peer, then every other
 * enabled peer. Empty when no peer is active, which callers treat as "no
 * peer configured" as before.
 */
export function peerFailoverOrder(settings: Pick<NetworkSettings, "peers" | "activePeerUrl">): string[] {
  if (settings.activePeerUrl === null) return [];
  const enabled = settings.peers.filter((peer) => peer.enabled).map((peer) => peer.url);
  return [...new Set([settings.activePeerUrl, ...enabled])];
}

/**
 * A thrown error that another peer could answer differently: a network
 * failure, a timeout or a 5xx. A peer's definitive answer, such as a
 * balance or a 404 read as zero, comes back as a value and never fails over.
 */
export function isPeerUnavailableError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 5\d\d|answered 5\d\d|\(5\d\d\)|timed? ?out|abort|network|failed to fetch|unreadable answer/i.test(message);
}

/**
 * Runs `read` against each peer in `peerUrls` until one answers. Only a
 * peer-unavailable error moves on to the next peer; any other error, or
 * the last peer's error, is thrown.
 */
export async function withPeerFailover<T>(
  peerUrls: readonly string[],
  read: (peerUrl: string) => Promise<T>,
  options: { maxAttempts?: number; shouldFailover?: (error: unknown) => boolean } = {},
): Promise<T> {
  const attempts = peerUrls.slice(0, options.maxAttempts ?? MAX_FAILOVER_ATTEMPTS);
  const shouldFailover = options.shouldFailover ?? isPeerUnavailableError;
  let lastError: unknown = new Error("No HyperBEAM peer to read from.");
  for (const [index, peerUrl] of attempts.entries()) {
    try {
      return await read(peerUrl);
    } catch (error) {
      lastError = error;
      if (index === attempts.length - 1 || !shouldFailover(error)) break;
    }
  }
  throw lastError;
}
