import { COMMUNITY_HYPERBEAM_PEER_URLS, type NetworkSettings, type StoragePort, type TimerPort } from "@gleam/core";
import { discoverHyperBeamPeers, stripTrailingSlashes } from "@gleam/core/src/ao/peer-discovery.ts";

export const DISCOVERED_PEERS_KEY = "local:discoveredPeers";
/** Community or discovered peers the user removed in Network & peers; merging skips them. */
export const DISMISSED_PEERS_KEY = "local:dismissedPeers";
const NETWORK_SETTINGS_KEY = "local:networkSettings";
export const PEER_DISCOVERY_ALARM_NAME = "gleam-peer-discovery";

const DISCOVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface DiscoveredPeers {
  at: number;
  urls: string[];
}

/**
 * `settings` with each discovered node the user doesn't already list, and
 * hasn't removed, appended as enabled. The user's own list keeps its order
 * and its enabled flags, so a peer they turned off stays off.
 */
export function mergeDiscoveredPeers(
  settings: NetworkSettings,
  discovered: DiscoveredPeers | string[] | null,
  dismissed: readonly string[] = [],
): NetworkSettings {
  const urls = Array.isArray(discovered) ? discovered : (discovered?.urls ?? []);
  const known = new Set([...settings.peers.map((peer) => stripTrailingSlashes(peer.url)), ...dismissed]);
  const added = urls.filter((url) => !known.has(url) && (known.add(url), true));
  if (added.length === 0) return settings;
  return { ...settings, peers: [...settings.peers, ...added.map((url) => ({ url, enabled: true }))] };
}

/** The peers merged into every settings read: the shipped community list, then the last discovery result. */
export async function readExtraPeerUrls(storage: StoragePort): Promise<string[]> {
  const discovered = await readDiscoveredPeers(storage);
  return [...COMMUNITY_HYPERBEAM_PEER_URLS, ...(discovered?.urls ?? [])];
}

/** Community or discovered peers the user has removed. */
export async function readDismissedPeers(storage: StoragePort): Promise<string[]> {
  try {
    const raw = await storage.get<unknown>(DISMISSED_PEERS_KEY);
    return Array.isArray(raw) ? raw.filter((url): url is string => typeof url === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Saves the settings Network & peers sends back. That screen shows the
 * community and discovered peers merged in, so one missing from `next` was
 * removed by the user and is remembered as dismissed, or the merge would
 * add it back.
 */
export async function saveNetworkSettings(storage: StoragePort, next: NetworkSettings): Promise<void> {
  const kept = new Set(next.peers.map((peer) => stripTrailingSlashes(peer.url)));
  const removed = (await readExtraPeerUrls(storage)).filter((url) => !kept.has(url));
  if (removed.length > 0) {
    const dismissed = await readDismissedPeers(storage);
    await storage.set(DISMISSED_PEERS_KEY, [...new Set([...dismissed, ...removed])]);
  }
  await storage.set(NETWORK_SETTINGS_KEY, next);
}

/** Reads the last discovery result, if any. */
export async function readDiscoveredPeers(storage: StoragePort): Promise<DiscoveredPeers | null> {
  try {
    return await storage.get<DiscoveredPeers>(DISCOVERED_PEERS_KEY);
  } catch {
    return null;
  }
}

/**
 * Re-runs discovery when the stored result is over a day old. An empty
 * result never overwrites a non-empty one, so a gateway outage doesn't
 * wipe the list.
 */
export async function refreshDiscoveredPeersIfDue(
  storage: StoragePort,
  gatewayUrl: () => Promise<string>,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<void> {
  try {
    const existing = await readDiscoveredPeers(storage);
    if (existing && now() - existing.at < DISCOVERY_INTERVAL_MS) return;
    const urls = await discoverHyperBeamPeers({ gatewayUrl: await gatewayUrl(), fetchImpl });
    if (urls.length === 0 && existing && existing.urls.length > 0) return;
    await storage.set<DiscoveredPeers>(DISCOVERED_PEERS_KEY, { at: now(), urls });
  } catch (error) {
    console.error("HyperBEAM peer discovery failed:", error);
  }
}

/** Checks hourly and on start; `refreshDiscoveredPeersIfDue` limits real runs to once a day. */
export function registerPeerDiscoveryAlarm(storage: StoragePort, timer: TimerPort, gatewayUrl: () => Promise<string>): void {
  timer.every(PEER_DISCOVERY_ALARM_NAME, 60, () => {
    void refreshDiscoveredPeersIfDue(storage, gatewayUrl);
  });
  void refreshDiscoveredPeersIfDue(storage, gatewayUrl);
}
