export interface HyperBeamPeer {
  url: string;
  enabled: boolean;
}

/** The configured Arweave gateway and list of AO-Core/HyperBEAM peer URLs. */
export interface NetworkSettings {
  gatewayUrl: string;
  peers: HyperBeamPeer[];
  /** URL of the currently active peer, or `null` if none is selected. */
  activePeerUrl: string | null;
}

/**
 * HyperBEAM peers shipped with the wallet so AO balance reads work out of
 * the box, with no user setup. Granted statically in the extension's
 * `host_permissions` (apps/extension/wxt.config.ts must list the same
 * origins — build config can't import this package, so keep the two in
 * sync by hand) rather than through the runtime `chrome.permissions.request`
 * flow a user-added peer goes through.
 *
 * These peers must never be removable from Network & peers settings, only
 * disabled — see NetworkPeersView's use of this constant — or a user could
 * end up back at the "no peer configured" state this default exists to
 * prevent.
 */
export const DEFAULT_HYPERBEAM_PEER_URLS: readonly string[] = ["https://state.forward.computer"];

/**
 * Public HyperBEAM nodes merged into the peer list on every settings read
 * (runtime `peers.ts`), which AO reads fail over to when the active peer
 * is down. Taken from on-chain location records (`Type: Location |
 * Scheduler-Location`, `type: location`). Each answers `Access-Control-Allow-Origin: *`, so unlike
 * DEFAULT_HYPERBEAM_PEER_URLS they stay out of `host_permissions`: a new
 * host permission there disables the extension on update.
 */
export const COMMUNITY_HYPERBEAM_PEER_URLS: readonly string[] = [
  "https://alpha.neo.zephyrdev.xyz",
  "https://charlie.neo2.zephyrdev.xyz",
  "https://hb.randao.net",
  "https://hb.paralithmarkets.com",
  "https://hyperbeam.tylerw.ai",
  "https://hb.apus.network",
  "https://hb.karakutu.xyz",
  "https://mail.mystical.computer",
  "https://tunnel.mystical.computer",
  "https://market-1.mystical.computer",
  "https://market-2.mystical.computer",
  "https://market-3.mystical.computer",
  "https://iloveao.online",
];

/**
 * HyperBEAM nodes that compute `arweave-scheduler@1.0` processes. A
 * gateway's own answer for these processes comes and goes: arweave.net
 * has been seen flipping between a balance and an HTML 404 for the same
 * URL within minutes. They answer `Access-Control-Allow-Origin: *`, so
 * these public reads need no host permission.
 */
export const L1_TOKEN_NODE_URLS: readonly string[] = [
  "https://alpha.neo.zephyrdev.xyz",
  "https://charlie.neo2.zephyrdev.xyz",
];

/**
 * ANS-104 bundler that bundled `dispatch` items are posted to.
 * Also listed in apps/extension/wxt.config.ts's `host_permissions`.
 */
export const DEFAULT_BUNDLER_URL = "https://up.arweave.net";

/**
 * lunar.arweave.net's block explorer, used everywhere a tx id or address
 * needs an external link: activity rows and send success.
 * Centralized so both build the same URL.
 */
const EXPLORER_BASE_URL = "https://lunar.arweave.net/#/explorer";

/** Builds a lunar.arweave.net explorer URL for a tx id or wallet address. */
export function explorerUrlFor(idOrAddress: string): string {
  return `${EXPLORER_BASE_URL}/${idOrAddress}`;
}

/**
 * Gleam Points API (apps/points-api). Deliberately absent from the
 * extension's `host_permissions`: the API answers the extension's origin
 * with CORS headers instead, so adding Points didn't raise a new
 * permission warning that would disable Gleam on update.
 */
export const POINTS_API_URL = "https://api.gleamwallet.app";
