import { describe, expect, it, vi } from "vitest";
import { COMMUNITY_HYPERBEAM_PEER_URLS, type NetworkSettings, type StoragePort } from "@gleam/core";
import { DISCOVERED_PEERS_KEY, DISMISSED_PEERS_KEY, mergeDiscoveredPeers, refreshDiscoveredPeersIfDue, saveNetworkSettings } from "./peers";

function createFakeStorage(): StoragePort & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async get<T>(key: string) {
      return store.has(key) ? (store.get(key) as T) : null;
    },
    async set<T>(key: string, value: T) {
      store.set(key, value);
    },
    async setMany(entries: Record<string, unknown>) {
      for (const [key, value] of Object.entries(entries)) store.set(key, value);
    },
    async remove(key: string) {
      store.delete(key);
    },
  } as StoragePort & { store: Map<string, unknown> };
}

const SETTINGS: NetworkSettings = {
  gatewayUrl: "https://arweave.net",
  peers: [{ url: "https://mine.test", enabled: false }],
  activePeerUrl: "https://mine.test",
};

function graphqlFetch(urls: string[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/graphql")) {
      const edges = urls.map((peer, index) => ({
        cursor: String(index),
        node: { id: String(index), owner: { address: `owner-${index}` }, block: { timestamp: index }, tags: [{ name: "Url", value: peer }] },
      }));
      return new Response(JSON.stringify({ data: { transactions: { pageInfo: { hasNextPage: false }, edges } } }));
    }
    return new Response("operator-address");
  }) as unknown as typeof fetch;
}

describe("mergeDiscoveredPeers", () => {
  it("appends new peers after the user's own and skips known or dismissed ones", () => {
    const merged = mergeDiscoveredPeers(SETTINGS, ["https://mine.test", "https://new.test", "https://gone.test"], ["https://gone.test"]);
    expect(merged.peers).toEqual([
      { url: "https://mine.test", enabled: false },
      { url: "https://new.test", enabled: true },
    ]);
    expect(merged.activePeerUrl).toBe("https://mine.test");
  });
});

describe("saveNetworkSettings", () => {
  it("remembers a community or discovered peer the user removed", async () => {
    const storage = createFakeStorage();
    await storage.set(DISCOVERED_PEERS_KEY, { at: 1, urls: ["https://kept.test", "https://removed.test"] });
    const [removedCommunity, ...keptCommunity] = COMMUNITY_HYPERBEAM_PEER_URLS;

    await saveNetworkSettings(storage, {
      ...SETTINGS,
      peers: [...SETTINGS.peers, ...[...keptCommunity, "https://kept.test"].map((url) => ({ url, enabled: true }))],
    });

    expect(storage.store.get(DISMISSED_PEERS_KEY)).toEqual([removedCommunity, "https://removed.test"]);
    expect(storage.store.get("local:networkSettings")).toMatchObject({ activePeerUrl: "https://mine.test" });
  });
});

describe("refreshDiscoveredPeersIfDue", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("skips discovery while the stored result is under a day old", async () => {
    const storage = createFakeStorage();
    await storage.set(DISCOVERED_PEERS_KEY, { at: 1000, urls: ["https://a.test"] });
    const fetchImpl = graphqlFetch(["https://b.test"]);

    await refreshDiscoveredPeersIfDue(storage, async () => "https://gw.test", fetchImpl, () => 1000 + DAY - 1);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stores a fresh result once the old one is due", async () => {
    const storage = createFakeStorage();
    await storage.set(DISCOVERED_PEERS_KEY, { at: 0, urls: ["https://a.test"] });

    await refreshDiscoveredPeersIfDue(storage, async () => "https://gw.test", graphqlFetch(["https://b.test"]), () => DAY + 1);

    expect(storage.store.get(DISCOVERED_PEERS_KEY)).toEqual({ at: DAY + 1, urls: ["https://b.test"] });
  });

  it("keeps the old list when discovery finds nothing", async () => {
    const storage = createFakeStorage();
    await storage.set(DISCOVERED_PEERS_KEY, { at: 0, urls: ["https://a.test"] });

    await refreshDiscoveredPeersIfDue(storage, async () => "https://gw.test", graphqlFetch([]), () => DAY + 1);

    expect(storage.store.get(DISCOVERED_PEERS_KEY)).toEqual({ at: 0, urls: ["https://a.test"] });
  });
});
