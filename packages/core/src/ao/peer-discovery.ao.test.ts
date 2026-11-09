import { describe, expect, it, vi } from "vitest";
import { discoverHyperBeamPeers, normalizePeerUrl } from "./peer-discovery";

function record(url: string, owner: string, timestamp: number) {
  return { cursor: `${owner}-${timestamp}`, node: { id: `${owner}-${timestamp}`, owner: { address: owner }, block: { timestamp }, tags: [{ name: "Url", value: url }] } };
}

function stubFetch(edges: ReturnType<typeof record>[], alive: Set<string>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/graphql")) {
      return new Response(JSON.stringify({ data: { transactions: { pageInfo: { hasNextPage: false }, edges } } }));
    }
    const origin = new URL(url).origin;
    return alive.has(origin) ? new Response("operator-address") : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("normalizePeerUrl", () => {
  it("keeps a public https origin", () => {
    expect(normalizePeerUrl("https://hb.node.test/")).toBe("https://hb.node.test");
  });

  it.each([
    "http://hb.node.test",
    "https://localhost:9000",
    "https://10.0.0.5",
    "https://abc.ngrok-free.app",
    "https://hb.1.2.3.4.sslip.io",
    "https://uri-did-ar-abc.smoke.test",
    "https://hb.node.test/path",
    "https://user:pw@hb.node.test",
    "not a url",
  ])("drops %s", (raw) => {
    expect(normalizePeerUrl(raw)).toBeNull();
  });
});

describe("discoverHyperBeamPeers", () => {
  it("returns live nodes, newest announcement per owner, newest first", async () => {
    const fetchImpl = stubFetch(
      [
        record("https://old.test", "owner-a", 100),
        record("https://new.test", "owner-a", 200),
        record("https://other.test", "owner-b", 150),
        record("https://dead.test", "owner-c", 300),
        record("https://localhost", "owner-d", 400),
      ],
      new Set(["https://new.test", "https://other.test", "https://old.test"]),
    );
    await expect(discoverHyperBeamPeers({ gatewayUrl: "https://gw.test", fetchImpl })).resolves.toEqual([
      "https://new.test",
      "https://other.test",
    ]);
  });

  it("returns an empty list when the gateway fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(discoverHyperBeamPeers({ gatewayUrl: "https://gw.test", fetchImpl })).resolves.toEqual([]);
  });
});
