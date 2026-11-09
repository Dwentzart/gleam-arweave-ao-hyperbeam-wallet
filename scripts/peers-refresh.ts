/**
 * Compares COMMUNITY_HYPERBEAM_PEER_URLS with the nodes announced on-chain,
 * using the same discovery the extension runs daily. Prints the nodes to
 * add, the listed nodes that didn't answer, and a list to paste.
 *
 *   pnpm peers:refresh [gatewayUrl]
 *
 * A node that didn't answer may only be down for now, so the pasted list
 * keeps it; remove it by hand once it has failed on more than one run.
 */
import { discoverHyperBeamPeers } from "../packages/core/src/ao/peer-discovery";
import { COMMUNITY_HYPERBEAM_PEER_URLS, DEFAULT_HYPERBEAM_PEER_URLS } from "../packages/core/src/models/network";

const gatewayUrl = process.argv[2] ?? "https://arweave.net";

async function answers(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/~meta@1.0/info/address`, { signal: AbortSignal.timeout(10_000) });
    return response.status === 200 && (await response.text()).trim().length > 0;
  } catch {
    return false;
  }
}

const listed = new Set([...DEFAULT_HYPERBEAM_PEER_URLS, ...COMMUNITY_HYPERBEAM_PEER_URLS]);
const discovered = await discoverHyperBeamPeers({ gatewayUrl, maxPages: 5, maxProbes: 100, timeoutMs: 10_000 });
const added = discovered.filter((url) => !listed.has(url));
const silent: string[] = [];
for (const url of COMMUNITY_HYPERBEAM_PEER_URLS) {
  if (!discovered.includes(url) && !(await answers(url))) silent.push(url);
}

console.log(`Discovered ${discovered.length} live nodes via ${gatewayUrl}.\n`);
console.log(added.length ? `New:\n${added.map((url) => `  + ${url}`).join("\n")}\n` : "No new nodes.\n");
console.log(silent.length ? `Listed but not answering:\n${silent.map((url) => `  ? ${url}`).join("\n")}\n` : "Every listed node answered.\n");
if (added.length > 0) {
  const next = [...COMMUNITY_HYPERBEAM_PEER_URLS, ...added];
  console.log(`Paste into packages/core/src/models/network.ts:\n[\n${next.map((url) => `  "${url}",`).join("\n")}\n]`);
}
