export interface DiscoverHyperBeamPeersOptions {
  gatewayUrl: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Pages (100 each) read per tag query. */
  maxPages?: number;
  /** Candidate nodes probed, newest first. */
  maxProbes?: number;
  concurrency?: number;
  /** Per-request timeout for each GraphQL page and probe. */
  timeoutMs?: number;
}

interface LocationNode {
  id: string;
  owner?: { address?: string } | null;
  block?: { timestamp?: number } | null;
  tags?: { name: string; value: string }[] | null;
}

interface LocationPage {
  data?: {
    transactions?: {
      pageInfo?: { hasNextPage?: boolean };
      edges?: { cursor: string; node: LocationNode }[];
    };
  };
}

const LOCATION_TAG_FILTERS = [
  [{ name: "Type", values: ["Location", "Scheduler-Location"] }],
  [{ name: "type", values: ["location"] }],
] as const;

const QUERY = `query($tags: [TagFilter!], $after: String) {
  transactions(tags: $tags, first: 100, after: $after, sort: HEIGHT_DESC) {
    pageInfo { hasNextPage }
    edges { cursor node { id owner { address } block { timestamp } tags { name value } } }
  }
}`;

// Hosts that only make sense on the publisher's own machine or network, or
// that are throwaway tunnels which rotate before anyone else could use them.
const BLOCKED_HOST_SUFFIXES = [
  ".local",
  ".internal",
  ".localhost",
  ".example",
  ".ngrok.io",
  ".ngrok-free.app",
  ".ngrok.app",
  ".ngrok.dev",
  ".loca.lt",
  ".sslip.io",
];

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return false;
  const [a, b] = parts.map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** `url` without trailing slashes. A loop, not a regex, since record URLs are untrusted. */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}

/** The bare https origin a location record's `Url` names, or null if it isn't a usable public node. */
export function normalizePeerUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(stripTrailingSlashes(raw.trim()));
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.startsWith("[")) return null;
  if (isPrivateIpv4(host)) return null;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1))) return null;
  if (host.startsWith("uri-did-ar-")) return null;
  return url.origin;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readLocationRecords(
  gatewayUrl: string,
  tags: (typeof LOCATION_TAG_FILTERS)[number],
  fetchImpl: typeof fetch,
  maxPages: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<LocationNode[]> {
  const nodes: LocationNode[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    try {
      const response = await fetchImpl(`${stripTrailingSlashes(gatewayUrl)}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { tags, after } }),
        signal: withTimeout(signal, timeoutMs),
      });
      if (!response.ok) break;
      const body = (await response.json()) as LocationPage;
      const edges = body.data?.transactions?.edges ?? [];
      for (const edge of edges) nodes.push(edge.node);
      if (!body.data?.transactions?.pageInfo?.hasNextPage || edges.length === 0) break;
      after = edges[edges.length - 1]!.cursor;
    } catch {
      break;
    }
  }
  return nodes;
}

async function answersAsNode(
  origin: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${origin}/~meta@1.0/info/address`, {
      signal: withTimeout(signal, timeoutMs),
    });
    if (response.status !== 200) return false;
    return (await response.text()).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Public HyperBEAM nodes announced on-chain through location records
 * (`Type: Location | Scheduler-Location`, `type: location`), keeping each
 * owner's newest announcement and only nodes that answer
 * `/~meta@1.0/info/address`. Newest first. Never throws: any failure yields
 * fewer (or no) nodes.
 */
export async function discoverHyperBeamPeers({
  gatewayUrl,
  fetchImpl = fetch,
  signal,
  maxPages = 3,
  maxProbes = 40,
  concurrency = 6,
  timeoutMs = 8000,
}: DiscoverHyperBeamPeersOptions): Promise<string[]> {
  try {
    const pages = await Promise.all(
      LOCATION_TAG_FILTERS.map((tags) => readLocationRecords(gatewayUrl, tags, fetchImpl, maxPages, timeoutMs, signal)),
    );

    // An owner may re-announce many times; only its latest address counts.
    // Unconfirmed records have no block yet and are the newest of all.
    const newestByOwner = new Map<string, { url: string; at: number }>();
    for (const node of pages.flat()) {
      const raw = node.tags?.find((tag) => tag.name === "Url" || tag.name === "url")?.value;
      if (!raw) continue;
      const url = normalizePeerUrl(raw);
      if (!url) continue;
      const owner = node.owner?.address ?? node.id;
      const at = node.block?.timestamp ?? Number.MAX_SAFE_INTEGER;
      const current = newestByOwner.get(owner);
      if (!current || at > current.at) newestByOwner.set(owner, { url, at });
    }

    const candidates: string[] = [];
    for (const { url } of [...newestByOwner.values()].sort((a, b) => b.at - a.at)) {
      if (!candidates.includes(url)) candidates.push(url);
      if (candidates.length >= maxProbes) break;
    }

    const alive = new Array<boolean>(candidates.length).fill(false);
    let next = 0;
    const worker = async () => {
      while (next < candidates.length) {
        if (signal?.aborted) return;
        const index = next++;
        alive[index] = await answersAsNode(candidates[index]!, fetchImpl, timeoutMs, signal);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    return candidates.filter((_, index) => alive[index]);
  } catch {
    return [];
  }
}
