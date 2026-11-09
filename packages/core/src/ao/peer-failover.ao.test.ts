import { describe, expect, it, vi } from "vitest";
import { isPeerUnavailableError, peerFailoverOrder, withPeerFailover } from "./peer-failover";

describe("peerFailoverOrder", () => {
  it("puts the active peer first, then the other enabled peers, without duplicates", () => {
    expect(
      peerFailoverOrder({
        activePeerUrl: "https://b.test",
        peers: [
          { url: "https://a.test", enabled: true },
          { url: "https://b.test", enabled: true },
          { url: "https://c.test", enabled: false },
          { url: "https://d.test", enabled: true },
        ],
      }),
    ).toEqual(["https://b.test", "https://a.test", "https://d.test"]);
  });

  it("is empty when no peer is active", () => {
    expect(peerFailoverOrder({ activePeerUrl: null, peers: [{ url: "https://a.test", enabled: true }] })).toEqual([]);
  });
});

describe("withPeerFailover", () => {
  it("moves to the next peer on a network error", async () => {
    const read = vi.fn(async (peer: string) => {
      if (peer === "https://a.test") throw new TypeError("Failed to fetch");
      return `from ${peer}`;
    });
    await expect(withPeerFailover(["https://a.test", "https://b.test"], read)).resolves.toBe("from https://b.test");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("stops on an error another peer wouldn't change", async () => {
    const read = vi.fn(async () => {
      throw new Error("Invalid process id");
    });
    await expect(withPeerFailover(["https://a.test", "https://b.test"], read)).rejects.toThrow("Invalid process id");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("tries at most three peers and throws the last error", async () => {
    const read = vi.fn(async (peer: string) => {
      throw new Error(`HTTP 502 from ${peer}`);
    });
    await expect(withPeerFailover(["https://1.test", "https://2.test", "https://3.test", "https://4.test"], read)).rejects.toThrow(
      "HTTP 502 from https://3.test",
    );
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe("isPeerUnavailableError", () => {
  it("treats timeouts and 5xx as unavailable, other errors as answers", () => {
    expect(isPeerUnavailableError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe(true);
    expect(isPeerUnavailableError(new Error("HTTP 503"))).toBe(true);
    expect(isPeerUnavailableError(new Error("HTTP 404"))).toBe(false);
  });
});
