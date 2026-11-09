import type { z } from "zod";
import {
  DEFAULT_BUNDLER_URL,
  POINTS_API_URL,
  REFUSED_PROVIDER_METHODS,
  bytesToBase64,
  missingPermissions,
  HARDWARE_MESSAGE_HASH,
  isHardwareWalletMethod,
  isWatchWalletMethod,
  providerMethodRefusal,
  verifyMessage,
  type Grant,
  type NetworkSettings,
  type ProviderMethod,
  type WalletState,
  type WalletSummary,
  type Winston,
  vaultHasPassword,
  WATCH_ONLY_CONNECT_REFUSAL,
} from "@gleam/core";
import { resolveInitialGatewayUrl } from "@gleam/core/src/arweave/first-run-gateway.ts";
import { estimateFee } from "@gleam/core/src/arweave/transfer.ts";
import { isSecureSigningOrigin } from "@gleam/core/src/policy/index.ts";
import type { ProtocolMap } from "@gleam/messaging/src/protocol.ts";
import type { CallerContext } from "@gleam/messaging/src/caller.ts";
import type { SiteAttestResponse } from "@gleam/messaging/src/site-protocol.ts";
import {
  PROVIDER_EVENT,
  type ConnectEventPayload,
  type DisconnectEventPayload,
  type ProviderEventName,
  type WalletSwitchEventPayload,
} from "@gleam/messaging/src/page-protocol.ts";
import { WalletLifecycleHandler } from "./handlers/wallet-lifecycle";
import { PasskeyHandler } from "./handlers/passkey";
import { ReadsHandler, registerActivityPromotionAlarm } from "./handlers/reads";
import { readAoTransferMessage } from "@gleam/core/src/ao/transfer-message.ts";
import { readL1TokenTransfer } from "@gleam/core/src/ao/l1-transfer.ts";
import { BrowserSitesHandler } from "./handlers/browser-sites";
import { ContactsHandler } from "./handlers/contacts";
import { TransferHandler } from "./handlers/transfer";
import { ApprovalHandler } from "./handlers/approval";
import { AnnouncementsHandler } from "./handlers/announcements";
import { ReviewPromptHandler } from "./handlers/review-prompt";
import { ScansHandler } from "./handlers/scans";
import { SiteWalletHandler } from "./handlers/site-wallet";
import { SecurityPhraseHandler } from "./handlers/security-phrase";
import { PointsHandler, registerPointsHeartbeatAlarm } from "./handlers/points";
import { createKeySession } from "./handlers/key-session";
import {
  decodeProviderParams,
  encodeProviderResult,
  type ProviderDataItem,
  type ProviderTransaction,
} from "./handlers/provider-params";
import {
  BACKGROUND_MESSAGES,
  PAGE_METHODS,
  parseParams,
  type BackgroundMessage,
  type ContentScriptMethodSpec,
  type ExtensionMethodSpec,
  type PageMethodSpec,
  type PageParams,
} from "./dispatch/methods";
import { dispatchSiteMessage } from "./dispatch/site";
import { redeemSiteInvite } from "./points-invite";
import { registerPeerDiscoveryAlarm, saveNetworkSettings } from "./peers";
import { signSiteAttestation, siteAttestStatus } from "./points-attest";
import type { Platform } from "./platform";
import { userErrorMessage } from "@gleam/core/src/models/user-errors.ts";

/**
 * What a shell's transport and lifecycle events reach the wallet through.
 * `dispatch` and `dispatchSite` answer messages; the rest are the shell's
 * events, which it connects to whatever its platform fires.
 */
export interface Runtime {
  /**
   * Runs `type`'s handler if `caller` holds its `BACKGROUND_MESSAGES` tier.
   * Throws (or rejects) with the error the caller is answered with.
   */
  dispatch(type: BackgroundMessage, data: unknown, caller: CallerContext | null): unknown;
  /** Answers a `SITE_MESSAGES` message. Never rejects: every refusal is a reply. */
  dispatchSite(message: unknown, caller: CallerContext | null): Promise<unknown>;
  /** Once per start, after the shell's message listeners are registered. */
  start(): void;
  /** The browser (or app) itself started, not just this background context. */
  onBrowserStartup(): void;
  onTabClosed(tabId: number): void;
  /** The OS idle state, as `"active"`, `"idle"` or `"locked"`. */
  onIdleStateChanged(state: string): void;
  /** The wallet was installed or updated, with the platform's reason, e.g. `"install"` or `"update"`. */
  onInstalled(reason: string): void;
}

type ProtocolData<K extends keyof ProtocolMap> = Parameters<ProtocolMap[K]>[0];
type ProtocolResult<K extends keyof ProtocolMap> = ReturnType<ProtocolMap[K]> | Promise<ReturnType<ProtocolMap[K]>>;

const AUTO_LOCK_ALARM_NAME = "auto-lock";

function requireWebOrigin(origin: unknown): string {
  if (typeof origin === "string") {
    try {
      const url = new URL(origin);
      if ((url.protocol === "https:" || url.protocol === "http:") && url.origin === origin) return origin;
    } catch {
      // Falls through to the error below.
    }
  }
  throw new Error("Expected a web origin such as https://example.com.");
}

/**
 * ArConnect's `getArweaveConfig()` shape, derived from the wallet's own
 * `NetworkSettings.gatewayUrl` rather than a dApp-supplied `connect(...,
 * gateway)` hint — a dApp doesn't get to redirect a connected wallet's
 * reads to a gateway of its choosing.
 */
function arweaveConfigFromGatewayUrl(gatewayUrl: string): { protocol: string; host: string; port: number } {
  const url = new URL(gatewayUrl);
  const protocol = url.protocol.replace(":", "");
  const port = url.port ? Number(url.port) : protocol === "https" ? 443 : 80;
  return { protocol, host: url.hostname, port };
}

/**
 * A hung HyperBEAM peer (or gateway metadata lookup) must not delay opening
 * a `transferAoTokens` approval — the user is waiting on a signing prompt,
 * not a balance read. Races `ReadsHandler.previewWatchedToken` against this
 * timeout, resolving to "unresolved" either way rather than ever rejecting.
 */
const TOKEN_METADATA_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * Longer than the metadata budget: an L1 send with no quote is refused, and a
 * cold token lookup can spend `core/ao/token-state.ts`'s 8s reading a logo.
 */
const TOKEN_FEE_QUOTE_TIMEOUT_MS = 10_000;

/** What a provider handler gets once the dispatcher has checked the origin's grant. */
interface GrantedCall {
  origin: string;
  grant: Grant;
  state: WalletState;
  /**
   * The wallet the user has switched to. A grant belongs to the origin, not
   * to one wallet: every read and signing request follows the active
   * wallet, the address the `walletSwitch` event already announced.
   * `grant.walletId` only records which wallet approved the connection.
   */
  wallet: WalletState["wallets"][number] | null;
  activeWalletId(): string;
}

type ProviderHandlers = {
  [M in ProviderMethod]: (
    params: PageParams<M>,
    call: (typeof PAGE_METHODS)[M]["grant"] extends true ? GrantedCall : { origin: string },
  ) => Promise<unknown>;
};

const INSECURE_ORIGIN_ERROR = "Gleam only works with secure (https) sites.";

/**
 * `TransferDraft` types `walletId` as optional. Every real
 * caller (`SendView`) always supplies it, but the wire type
 * itself can't promise that — this guard turns a missing field into a
 * named rejection rather than `undefined` silently reaching the
 * key-session lookup as a wallet id. The request carries no signing
 * material — see `key-session.ts`.
 */
function requireWalletId<T extends { walletId?: string }>(draft: T): T & { walletId: string } {
  if (!draft.walletId) {
    throw new Error("This action requires a wallet id.");
  }
  return draft as T & { walletId: string };
}

type ContentScriptCaller = Extract<CallerContext, { tier: "contentScript" }>;

type MessageHandlers = {
  [K in BackgroundMessage]: (typeof BACKGROUND_MESSAGES)[K] extends ContentScriptMethodSpec<infer S>
    ? (data: z.output<S>, caller: ContentScriptCaller) => ProtocolResult<K>
    : (data: ProtocolData<K>) => ProtocolResult<K>;
};

const NETWORK_SETTINGS_KEY = "local:networkSettings";

/**
 * Builds every handler over `platform` and returns the dispatcher in front
 * of them. Call it once per background start, synchronously at the top
 * level: it registers the platform's timer and approval listeners as it
 * runs, and it creates the one key session, whose lock every handler that
 * touches unlocked keys shares.
 *
 * Who may call what is `src/dispatch/methods.ts`: every method's tier,
 * whether it can open an approval window, and the schema its params are
 * parsed with. This holds the handlers behind that table. Every message
 * is checked against the `CallerContext` the shell's transport built,
 * never against anything the message body claims.
 */
export function createRuntime(platform: Platform): Runtime {
  const { storage, tabs } = platform;
  // The one session lock: every handler that touches unlocked keys gets this instance.
  const keySession = createKeySession({ sessionKeys: platform.sessionKeys, storage });
  const { clearKeyCache, enforceAutoLock, getSigner, getStoredWallet, getWalletMethod, reconcileKeyring, withSessionLock } =
    keySession;

  const lifecycle = new WalletLifecycleHandler(storage, keySession, { downloads: platform.downloads });
  const passkey = new PasskeyHandler(storage, lifecycle);
  const reads = new ReadsHandler(storage);
  // `approval` is declared below; hardware sends reach it only at call time.
  const transfer: TransferHandler = new TransferHandler(storage, keySession, {
    requestTransfer: async (req): Promise<{ txId: string }> => {
      const metadata = req.token === null ? {} : await resolveTokenDenominationAndTicker(await walletAddress(req.walletId), req.token);
      return approval.requestWalletTransfer({ ...req, ...metadata });
    },
  }, reads, reads);
  const contacts = new ContactsHandler(storage);
  const browserSites = new BrowserSitesHandler(storage);
  const approval: ApprovalHandler = new ApprovalHandler(
    storage,
    keySession,
    platform.approvalPresenter,
    transfer,
    DEFAULT_BUNDLER_URL,
    async () => (await lifecycle.getState()).activeWalletId,
    reads,
    // `points` is declared below; attestations reach it only at call time.
    {
      attest: (req) => points.attest(req),
      submitAttestation: (attestation, proof) => points.submitAttestation(attestation, proof),
      check: (attestation, address) => points.checkAttestation(attestation, address),
    },
  );

  // Advances locally-pending activity entries to confirmed on a background
  // interval, independent of any popup being open — see reads.ts's own
  // doc comment on registerActivityPromotionAlarm.
  registerActivityPromotionAlarm(reads, platform.timer);
  registerPeerDiscoveryAlarm(storage, platform.timer, async () => (await reads.getNetworkSettings()).gatewayUrl);

  const points = new PointsHandler({
    storage,
    deviceKey: platform.deviceKey,
    apiUrl: POINTS_API_URL,
    signer: getSigner,
    walletMethod: getWalletMethod,
    deviceProof: async ({ walletId, message }) => {
      const wallet = await getStoredWallet(walletId);
      if (!wallet) throw new Error(userErrorMessage("walletNotFound", { wallet: walletId }));
      const text = message(wallet.address);
      return { ...(await approval.requestPointsProof({ walletId, message: text })), message: text };
    },
    badge: platform.badge,
  });
  registerPointsHeartbeatAlarm(points, platform.timer);

  const announcements = new AnnouncementsHandler({ storage, target: () => ({ shell: platform.shell, version: platform.version() }) });
  const reviewPrompt = new ReviewPromptHandler({ storage });
  const scans = new ScansHandler({ apiUrl: POINTS_API_URL, version: () => platform.version() });
  const securityPhrase = new SecurityPhraseHandler(storage);
  const siteWallet = new SiteWalletHandler({ storage, findActiveGrant: (origin) => approval.findActiveGrant(origin) });

  // Auto-lock is otherwise only checked when something reads the session;
  // this tick drops the keys once the timeout passes even if nothing does.
  platform.timer.every(AUTO_LOCK_ALARM_NAME, 1, () => {
    enforceAutoLock().catch((error: unknown) => console.error("Auto-lock failed.", error));
  });

  /**
   * Finds every open tab whose URL origin matches `origin` exactly, since
   * nothing about `providerEvent`'s wire shape itself carries an origin
   * check. A tab query can't express "exact origin, any path" directly, so
   * this filters every web tab down to an exact
   * `new URL(tab.url).origin === origin` match by hand.
   */
  async function findTabsForOrigin(origin: string): Promise<number[]> {
    const ids: number[] = [];
    for (const tab of await tabs.webTabs()) {
      if (typeof tab.id !== "number" || !tab.url) continue;
      try {
        if (new URL(tab.url).origin === origin) ids.push(tab.id);
      } catch {
        // Not a parseable URL — never a candidate.
      }
    }
    return ids;
  }

  /** The favicon of an open tab on `origin`, to keep on its grant. */
  async function favIconFor(origin: string): Promise<string | null> {
    try {
      for (const tab of await tabs.webTabs()) {
        if (!tab.url || !tab.favIconUrl) continue;
        try {
          if (new URL(tab.url).origin === origin) return tab.favIconUrl;
        } catch {
          // Not a parseable URL — never a candidate.
        }
      }
    } catch {
      // A missing icon only means the letter fallback.
    }
    return null;
  }

  /**
   * Sends a `providerEvent` push to every tab currently showing `origin` —
   * never a broadcast to every open tab. Each send targets one `tabId`; a
   * tab with no content script listening (e.g. mid-navigation) simply
   * rejects that one send, which is swallowed here rather than failing the
   * caller — a missed push is not itself an error the connect/disconnect/
   * switchWallet flow should surface.
   */
  async function emitProviderEventToOrigin<TName extends ProviderEventName>(
    origin: string,
    event: TName,
    data: TName extends typeof PROVIDER_EVENT.CONNECT
      ? ConnectEventPayload
      : TName extends typeof PROVIDER_EVENT.DISCONNECT
        ? DisconnectEventPayload
        : WalletSwitchEventPayload,
  ): Promise<void> {
    const tabIds = await findTabsForOrigin(origin);
    await Promise.all(
      tabIds.map((tabId) =>
        tabs.send(tabId, "providerEvent", { event, data }).catch(() => undefined),
      ),
    );
  }

  /**
   * For when the user ends a site's access from Gleam: the dApp hears
   * `disconnect`, and when another wallet is installed the page's
   * `window.arweaveWallet` goes back to forwarding to it. A dApp's own
   * `disconnect()` only does the first part.
   */
  async function announceAccessEnded(origin: string): Promise<void> {
    await siteWallet.setUseGleam(origin, false);
    await emitProviderEventToOrigin(origin, PROVIDER_EVENT.DISCONNECT, {});
    await pushSiteWalletMode(origin, false);
  }

  /**
   * For when the last wallet goes. Sites with a grant hear `disconnect` as
   * well; the rest were chosen in the popup and only switch back.
   */
  async function announceGleamSitesForgotten(revoked: string[]): Promise<void> {
    const forgotten = await siteWallet.forgetGleamSites();
    for (const origin of revoked) void announceAccessEnded(origin);
    for (const origin of forgotten) {
      if (!revoked.includes(origin)) void pushSiteWalletMode(origin, false);
    }
  }

  async function pushSiteWalletMode(origin: string, useGleam: boolean): Promise<void> {
    const tabIds = await findTabsForOrigin(origin);
    await Promise.all(
      tabIds.map((tabId) => tabs.send(tabId, "siteWalletMode", { useGleam }).catch(() => undefined)),
    );
  }

  /** Reloads the active tab when it shows `origin`, so the dApp starts over with the wallet just chosen. */
  async function reloadActiveTabFor(origin: string): Promise<void> {
    const tab = await tabs.activeTab();
    if (typeof tab?.id !== "number" || !tab.url) return;
    try {
      if (new URL(tab.url).origin !== origin) return;
    } catch {
      return;
    }
    await tabs.reload(tab.id).catch(() => undefined);
  }

  /**
   * The active address `origin` could read through `getActiveAddress`, or
   * `null`. Pushed events carry an address only through this, so a page
   * never hears one the pull path would refuse it.
   */
  async function readableActiveAddress(origin: string): Promise<string | null> {
    if (!isSecureSigningOrigin(origin)) return null;
    const grant = await approval.findActiveGrant(origin);
    if (!grant || missingPermissions("getActiveAddress", grant.permissions).length > 0) return null;
    const state = await lifecycle.getState();
    const wallet = state.wallets.find((candidate) => candidate.id === state.activeWalletId);
    if (!wallet || isWatchWalletMethod(wallet.method)) return null;
    return wallet.address;
  }

  /**
   * `walletSwitch` for an active-account change. A switch affects the whole
   * extension, so every origin with a grant is considered, never every
   * open tab, and each hears only the address it could read.
   */
  async function broadcastWalletSwitch(): Promise<void> {
    const grants = await approval.getConnectedApps();
    const origins = [...new Set(grants.map((grant) => grant.origin))];
    await Promise.all(
      origins.map(async (origin) => {
        const address = await readableActiveAddress(origin);
        if (address) await emitProviderEventToOrigin(origin, PROVIDER_EVENT.WALLET_SWITCH, { address });
      }),
    );
  }

  async function walletAddress(walletId: string): Promise<string> {
    const wallet = (await lifecycle.getState()).wallets.find((candidate) => candidate.id === walletId);
    if (!wallet) throw new Error(userErrorMessage("noStoredWallet", { wallet: walletId }));
    return wallet.address;
  }

  async function resolveTokenDenominationAndTicker(
    address: string,
    processId: string,
  ): Promise<{ tokenDenomination: number | null; tokenTicker: string | null }> {
    const UNRESOLVED = { tokenDenomination: null, tokenTicker: null };
    const lookup = reads
      .previewWatchedToken({ address, processId })
      .then((balance) => (balance.available === false ? UNRESOLVED : { tokenDenomination: balance.denomination, tokenTicker: balance.ticker }))
      .catch(() => UNRESOLVED);
    const timeout = new Promise<typeof UNRESOLVED>((resolve) =>
      setTimeout(() => resolve(UNRESOLVED), TOKEN_METADATA_LOOKUP_TIMEOUT_MS),
    );
    return Promise.race([lookup, timeout]);
  }

  /**
   * The AR reward a dApp's token transfer pays, for the preview: `null` for
   * a token on the MU, which has none. A lookup that fails or hangs also
   * gives `null`, and an L1 send then refuses for want of an approved fee.
   */
  async function quoteTokenTransferFee(processId: string): Promise<Winston | null> {
    const lookup = (async () => {
      if ((await reads.tokenTransport({ processId })) !== "l1") return null;
      const { gatewayUrl } = await reads.getNetworkSettings();
      return (await estimateFee(gatewayUrl, processId)).fee;
    })().catch(() => null);
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), TOKEN_FEE_QUOTE_TIMEOUT_MS));
    return Promise.race([lookup, timeout]);
  }

  /**
   * The work behind each `PAGE_METHODS` entry. Params arrive parsed, and
   * for every method but `connect`/`disconnect` the origin's active grant
   * and permissions have been checked, so no handler here exposes an
   * address to an origin without a grant.
   */
  const PROVIDER_HANDLERS: ProviderHandlers = {
    async connect({ permissions: wanted, appInfo }, { origin }) {
      const state = await lifecycle.getState();
      const active = state.wallets.find((candidate) => candidate.id === state.activeWalletId);
      if (active && isWatchWalletMethod(active.method)) throw new Error(WATCH_ONLY_CONNECT_REFUSAL);

      // Many dApps call connect() on every page load. An origin whose grant
      // already covers the request resolves without a prompt; otherwise only
      // the missing permissions are asked for, and approval merges them in.
      // Without a wallet there is nothing to connect to, so a leftover grant
      // never short-circuits onboarding.
      const existing = state.activeWalletId ? await approval.findActiveGrant(origin) : null;
      const newPermissions = existing
        ? wanted.filter((permission) => !existing.permissions.includes(permission))
        : wanted;
      if (existing && newPermissions.length === 0) {
        return { granted: existing.permissions };
      }

      // With no wallet yet, the approval window runs onboarding before it
      // shows the request, and the grant goes to the wallet created there.
      // A locked wallet is unlocked in that window the same way.
      const result = await approval.requestApproval({
        kind: "connect",
        origin,
        walletId: state.activeWalletId,
        requestedPermissions: newPermissions,
        appInfo,
        favIconUrl: await favIconFor(origin),
      });

      // Reached only once the user approved: a rejected or timed-out request
      // throws. ArConnect fires `connect` once connect() resolves.
      const activeAddress = await readableActiveAddress(origin);
      if (activeAddress) void emitProviderEventToOrigin(origin, PROVIDER_EVENT.CONNECT, { activeAddress });
      // A site that connected through `window.gleam` chose Gleam, so its
      // `window.arweaveWallet` stops forwarding to another installed wallet.
      await siteWallet.setUseGleam(origin, true);
      void pushSiteWalletMode(origin, true);

      return result;
    },

    async disconnect(_params, { origin }) {
      await approval.revokeGrant({ origin });
      void emitProviderEventToOrigin(origin, PROVIDER_EVENT.DISCONNECT, {});
      return undefined;
    },

    async getPermissions(_params, { grant }) {
      return grant.permissions;
    },
    async getActiveAddress(_params, { wallet }) {
      return wallet?.address ?? null;
    },
    async getAllAddresses(_params, { state }) {
      return state.wallets.map((candidate) => candidate.address);
    },
    async getActivePublicKey(_params, { wallet }) {
      return wallet?.publicKey ?? null;
    },
    async getWalletNames(_params, { state }) {
      return Object.fromEntries(state.wallets.map((candidate) => [candidate.address, candidate.name]));
    },
    async getArweaveConfig() {
      const { gatewayUrl } = await reads.getNetworkSettings();
      return arweaveConfigFromGatewayUrl(gatewayUrl);
    },
    async getBalances(_params, { wallet }) {
      if (!wallet) throw new Error(userErrorMessage("noActiveWalletBalances"));
      return { ar: await reads.getBalance({ address: wallet.address }) };
    },

    sign: ({ transaction }, call) => requestTransactionApproval("sign", transaction, call),
    dispatch: ({ transaction }, call) => requestTransactionApproval("dispatch", transaction, call),

    signDataItem: ({ dataItem }, call) => requestDataItemApproval("signDataItem", [dataItem], call),
    batchSignDataItem: ({ dataItems }, call) => requestDataItemApproval("batchSignDataItem", dataItems, call),

    async encrypt({ data, options }, { origin, activeWalletId }) {
      return approval.requestApproval({ kind: "encrypt", origin, walletId: activeWalletId(), payload: data, encryptAlgorithm: options });
    },
    async decrypt({ data, options }, { origin, activeWalletId }) {
      return approval.requestApproval({ kind: "decrypt", origin, walletId: activeWalletId(), payload: data, encryptAlgorithm: options });
    },

    async transferAoTokens({ token, recipient, amount }, { origin, wallet, activeWalletId }) {
      if (!wallet) throw new Error(userErrorMessage("noActiveWalletSign"));

      // Best-effort: the same denomination/ticker read the token list uses
      // for balances, so the approval amount can render scaled with its
      // ticker instead of as a raw atomic integer. A failed, unresolvable,
      // or hanging lookup (unconfigured peer, unreachable HyperBEAM node)
      // must never block or delay showing the approval — raced against
      // `TOKEN_METADATA_LOOKUP_TIMEOUT_MS` so a hung peer can't stall the
      // window open. `formatAmount`/`formatAmountUnit` fall back to the raw
      // amount and a "smallest units" label when either comes back `null`.
      const [{ tokenDenomination, tokenTicker }, fee] = await Promise.all([
        resolveTokenDenominationAndTicker(wallet.address, token),
        quoteTokenTransferFee(token),
      ]);

      return approval.requestApproval({
        kind: "transferAoTokens",
        origin,
        walletId: activeWalletId(),
        recipient,
        amount,
        fee,
        token,
        tokenDenomination,
        tokenTicker,
        payload: new Uint8Array(),
        tags: [],
      });
    },

    async signMessage({ data, options: hashAlgorithm }, { origin, wallet, activeWalletId }) {
      if (
        wallet &&
        isHardwareWalletMethod(wallet.method) &&
        (hashAlgorithm ?? HARDWARE_MESSAGE_HASH) !== HARDWARE_MESSAGE_HASH
      ) {
        throw new Error(`A hardware wallet signs messages with ${HARDWARE_MESSAGE_HASH} only, not ${hashAlgorithm}.`);
      }
      return approval.requestApproval({ kind: "signMessage", origin, walletId: activeWalletId(), payload: data, hashAlgorithm });
    },

    async verifyMessage({ data, signature, publicKey: givenKey, options: hashAlgorithm }, { wallet }) {
      // Verification uses only public material, so it needs no approval.
      const publicKey = givenKey ?? wallet?.publicKey;
      if (typeof publicKey !== "string" || publicKey.length === 0) {
        throw new Error("verifyMessage needs a publicKey when no wallet is active.");
      }
      return verifyMessage(publicKey, data.buffer, signature.buffer, hashAlgorithm);
    },

    async tokenBalance({ id }, { wallet }) {
      if (!wallet) throw new Error(userErrorMessage("noActiveWalletTokenBalance"));
      return reads.tokenBalance({ address: wallet.address, id });
    },

    async userTokens({ options }, { wallet }) {
      if (!wallet) throw new Error(userErrorMessage("noActiveWalletTokens"));
      return reads.userTokens({ address: wallet.address, options });
    },

    async isTokenAdded({ id: processId }, { wallet }) {
      if (!wallet) throw new Error(userErrorMessage("noActiveWalletCheckTokens"));
      return reads.isTokenAdded({ address: wallet.address, processId });
    },

    async addToken({ id: processId }, { origin, wallet }) {
      if (!wallet) throw new Error(userErrorMessage("noActiveWalletAddToken"));
      // Already listed: nothing to ask the user.
      if (await reads.isTokenAdded({ address: wallet.address, processId })) return undefined;
      // Resolving first proves the id answers as a token, and gives the
      // prompt a ticker and name to show instead of only the id.
      const token = await reads.previewWatchedToken({ address: wallet.address, processId });
      return approval.requestApproval({
        kind: "addToken",
        origin,
        walletId: wallet.id,
        address: wallet.address,
        processId,
        // `getTokenBalance` echoes the process id when it finds no ticker.
        ticker: token.ticker === processId ? null : token.ticker,
        name: token.name,
      });
    },
  };

  async function requestTransactionApproval(
    kind: "sign" | "dispatch",
    transaction: ProviderTransaction,
    { origin, wallet, activeWalletId }: GrantedCall,
  ): Promise<unknown> {
    const { gatewayUrl } = await reads.getNetworkSettings();
    // A token transfer to an arweave-scheduler process moves no AR, so it
    // shows as the token it sends, read from the transaction's own tags.
    // One that can't be read cleanly shows as the plain transaction, warned.
    const reading = transaction.target
      ? readL1TokenTransfer({
          target: transaction.target,
          quantity: transaction.quantity ?? "0",
          data_size: String(transaction.data.byteLength),
          tags: transaction.tags,
        })
      : null;
    const tokenTransfer = reading?.kind === "transfer" ? reading : null;
    const tokenMetadata =
      tokenTransfer && wallet ? await resolveTokenDenominationAndTicker(wallet.address, tokenTransfer.processId) : null;
    // The dApp's reward is the fee actually charged. Without one, the quote
    // the preview shows becomes the reward, so a gateway can't charge more
    // than the user approved. A bundled dispatch carries no reward at all.
    const fee =
      transaction.reward ?? (await estimateFee(gatewayUrl, transaction.target, transaction.data.byteLength)).fee;
    return approval.requestApproval({
      kind,
      origin,
      walletId: activeWalletId(),
      ...(tokenTransfer
        ? {
            recipient: tokenTransfer.recipient,
            amount: tokenTransfer.quantity,
            token: tokenTransfer.processId,
            tokenDenomination: tokenMetadata?.tokenDenomination ?? null,
            tokenTicker: tokenMetadata?.tokenTicker ?? null,
          }
        : {
            recipient: transaction.target ?? null,
            amount: transaction.target ? (transaction.quantity ?? "0") : null,
            ...(reading ? { unreadableTokenTransfer: true } : {}),
          }),
      fee,
      payload: transaction.data,
      tags: transaction.tags,
      gatewayUrl,
      target: transaction.target,
      quantity: transaction.quantity,
      reward: fee,
      last_tx: transaction.last_tx,
    });
  }

  async function requestDataItemApproval(
    kind: "signDataItem" | "batchSignDataItem",
    items: ProviderDataItem[],
    { origin, wallet, activeWalletId }: GrantedCall,
  ): Promise<unknown> {
    const [first] = items;
    const signed = kind === "signDataItem" ? items.slice(0, 1) : items;
    // Scale and ticker for each AO transfer, so it shows like a
    // `transferAoTokens` request. Unresolved metadata shows raw units.
    const itemTokenMetadata = await Promise.all(
      signed.map((item) => {
        const transfer = readAoTransferMessage({ target: item.target, tags: item.tags });
        return transfer?.kind === "transfer" && wallet ? resolveTokenDenominationAndTicker(wallet.address, transfer.processId) : null;
      }),
    );
    return approval.requestApproval({
      kind,
      origin,
      walletId: activeWalletId(),
      payload: first!.data,
      tags: first!.tags,
      dataItems: items.map((item) => ({
        data: bytesToBase64(item.data),
        tags: item.tags,
        target: item.target,
        anchor: item.anchor,
      })),
      itemTokenMetadata,
    });
  }

  /**
   * Routes one `window.arweaveWallet` call by its `PAGE_METHODS` entry. The
   * refusals that don't depend on the origin's grant throw synchronously,
   * so every site gets the same answer and no window opens.
   */
  function dispatchProviderCall(origin: string, method: string, rawParams: unknown): Promise<unknown> {
    if (Object.hasOwn(REFUSED_PROVIDER_METHODS, method)) {
      throw new Error(REFUSED_PROVIDER_METHODS[method as keyof typeof REFUSED_PROVIDER_METHODS]);
    }
    if (!Object.hasOwn(PAGE_METHODS, method)) {
      throw new Error(`Provider method "${method}" is not reachable from a web page.`);
    }
    const providerMethod = method as ProviderMethod;
    // Checked on every call, not only at connect, so a plain-http origin
    // still holding an older grant can neither sign nor read addresses.
    // `disconnect` only drops the grant, so such a site may still clear it.
    if (providerMethod !== "disconnect" && !isSecureSigningOrigin(origin)) {
      throw new Error(INSECURE_ORIGIN_ERROR);
    }
    return runProviderMethod(origin, providerMethod, rawParams);
  }

  async function runProviderMethod(origin: string, method: ProviderMethod, rawParams: unknown): Promise<unknown> {
    const spec: PageMethodSpec = PAGE_METHODS[method];
    const handle = PROVIDER_HANDLERS[method] as (params: unknown, call: GrantedCall | { origin: string }) => Promise<unknown>;
    const decoded = decodeProviderParams(rawParams);
    if (!spec.grant) return handle(parseParams(spec.params, decoded), { origin });

    const grant = await approval.findActiveGrant(origin);
    if (!grant) {
      throw new Error(`"${origin}" is not connected. Call connect() first.`);
    }
    const missing = missingPermissions(method, grant.permissions);
    if (missing.length > 0) {
      throw new Error(`Missing permission(s) for "${method}": ${missing.join(", ")}`);
    }

    const state = await lifecycle.getState();
    const wallet = state.wallets.find((candidate) => candidate.id === state.activeWalletId) ?? null;
    // Grants follow the active wallet, so a site connected earlier must not
    // reach a watch wallet's address or sign requests through its grant.
    if (wallet && isWatchWalletMethod(wallet.method)) throw new Error(WATCH_ONLY_CONNECT_REFUSAL);
    // Refuse what the active wallet can't do before any approval window
    // opens, rather than after the user has approved it.
    const refusal = wallet ? providerMethodRefusal(wallet.method, method) : null;
    if (refusal) throw new Error(refusal);

    const params = parseParams(spec.params, decoded);
    return handle(params, {
      origin,
      grant,
      state,
      wallet,
      activeWalletId: () => {
        if (!wallet) throw new Error(userErrorMessage("noActiveWalletSign"));
        return wallet.id;
      },
    });
  }

  async function lockVault(): Promise<void> {
    await lifecycle.lockWallet();
    // A vault of only hardware wallets has no password and stays unlocked.
    if (vaultHasPassword((await lifecycle.getState()).wallets)) void platform.lockIndicator.setLocked(true);
  }

  /**
   * Locks when the computer's screen locks, unless auto-lock is "never".
   * Only `"locked"` counts: the auto-lock timeout already runs from the last
   * use of the wallet, which is stricter than the OS's idle state.
   */
  async function lockOnScreenLock(state: string): Promise<void> {
    if (state !== "locked") return;
    if ((await lifecycle.getLockSettings()).autoLockTimeout === "never") return;
    await lockVault();
  }

  // A new wallet becomes the active one. Connected dApps follow the active
  // wallet, so they hear about it; with no earlier wallet there is nothing
  // connected to tell.
  async function addWallet(add: () => Promise<WalletSummary>): Promise<WalletSummary> {
    const before = await lifecycle.getState();
    const summary = await add();
    void points.markUnlockedForVault().catch(() => {});
    if (before.activeWalletId !== null) await activeWalletChanged(summary.id);
    return summary;
  }

  // A site's pending signing request stays bound to the wallet it was made
  // for, so it can't outlive that wallet being active.
  async function activeWalletChanged(walletId: string): Promise<void> {
    try {
      await approval.rejectSwitchedApprovals(walletId);
    } finally {
      void broadcastWalletSwitch();
    }
  }

  /** The work behind each `BACKGROUND_MESSAGES` entry, run once its sender has been checked. */
  const MESSAGE_HANDLERS: MessageHandlers = {
    // wallet lifecycle
    createWallet: (data) => addWallet(() => lifecycle.createWallet(data)),
    importWallet: (data) => addWallet(() => lifecycle.importWallet(data)),
    addHardwareWallet: (data) => addWallet(() => lifecycle.addHardwareWallet(data)),
    addWatchWallet: (data) => addWallet(() => lifecycle.addWatchWallet(data)),
    deleteWallet: async (data) => {
      const { walletId } = data;
      const before = await lifecycle.getState();
      const isLastWallet = before.wallets.every((candidate) => candidate.id === walletId);

      // Grants follow the active wallet, so they only go when no wallet is left
      // to follow, as on reset.
      let revoked: string[] = [];
      if (isLastWallet) {
        revoked = await approval.revokeAllAccess("The wallet was removed.");
      } else {
        await approval.rejectWalletApprovals(walletId);
      }
      await lifecycle.deleteWallet(data);
      if (isLastWallet) await announceGleamSitesForgotten(revoked);

      const after = await lifecycle.getState();
      if (after.activeWalletId !== null && after.activeWalletId !== before.activeWalletId) {
        await activeWalletChanged(after.activeWalletId);
      }
    },
    renameWallet: (data) => lifecycle.renameWallet(data),
    switchWallet: async (data) => {
      await lifecycle.switchWallet(data);
      await activeWalletChanged(data.walletId);
    },
    downloadKeyfile: (data) => lifecycle.downloadKeyfile(data),
    cancelKeyfileDownload: (data) => lifecycle.cancelKeyfileDownload(data),
    lockWallet: () => lockVault(),
    unlockWallet: async (data) => {
      const result = await lifecycle.unlockWallet(data);
      void platform.lockIndicator.setLocked(false);
      return result;
    },
    getPasskeyStatus: () => passkey.getPasskeyStatus(),
    checkVaultPassword: (data) => lifecycle.checkVaultPassword(data),
    probeVaultPassword: (data) => lifecycle.probeVaultPassword(data),
    enrollPasskey: (data) => passkey.enrollPasskey(data),
    unlockWithPasskey: async (data) => {
      const result = await passkey.unlockWithPasskey(data);
      void platform.lockIndicator.setLocked(false);
      return result;
    },
    removePasskey: () => passkey.removePasskey(),
    resetAllWallets: async () => {
      // Grants go first, here and when deleteWallet removes the last wallet: a
      // removal that fails part-way must not leave a dApp connected to nothing.
      const revoked = await approval.revokeAllAccess();
      await passkey.removePasskey();
      await lifecycle.resetAllWallets();
      await announceGleamSitesForgotten(revoked);
    },

    // reads
    // Extension-tier only, so this is the user looking at a Gleam page.
    getState: (data) => lifecycle.getState({ recordActivity: data?.recordActivity !== false }),
    getBalance: (data) => reads.getBalance(data),
    getArFee: () => transfer.getArFee(),
    getTokenBalances: (data) => reads.getTokenBalances(data),
    getPendingTransfers: (data) => reads.getPendingTransfers(data),
    getCollectibles: (data) => reads.getCollectibles(data),
    getWatchedTokens: (data) => reads.getWatchedTokens(data),
    previewWatchedToken: (data) => reads.previewWatchedToken(data),
    addWatchedToken: (data) => reads.addWatchedToken(data),
    removeWatchedToken: (data) => reads.removeWatchedToken(data),
    getActivity: (data) => reads.getActivity(data),
    getPortfolioHistory: (data) => reads.getPortfolioHistory(data),
    getTokenPrices: (data) => reads.getTokenPrices(data),
    getConnectedApps: () => approval.getConnectedApps(),
    listContacts: () => contacts.listContacts(),
    listBrowserSites: () => browserSites.listBrowserSites(),

    // actions
    estimateTransfer: (data) => transfer.estimateTransfer(requireWalletId(data)),
    assessRecipient: (data) => transfer.assessRecipient(data),
    submitTransfer: (data) => transfer.submitTransfer(requireWalletId(data)),
    estimateCollectibleSend: (data) => transfer.estimateCollectibleSend(requireWalletId(data)),
    sendCollectible: (data) => transfer.sendCollectible(requireWalletId(data)),

    // approvals
    getApproval: (data) => approval.getApproval(data),
    // The approval window's load doesn't count as activity, since a site
    // opens it; the user's answer in it does.
    resolveApproval: async (data) => {
      await lifecycle.getState({ recordActivity: true });
      return approval.resolveApproval(data);
    },
    submitDeviceSignature: async (data) => {
      await lifecycle.getState({ recordActivity: true });
      return approval.submitDeviceSignature(data);
    },
    checkScanAttestation: (data) => approval.checkScanAttestation(data),
    deviceActivity: (data) => approval.deviceActivity(data),

    // settings
    getNetworkSettings: () => reads.getNetworkSettings(),
    setNetworkSettings: (data) => saveNetworkSettings(storage, data),
    getLockSettings: () => lifecycle.getLockSettings(),
    setLockSettings: (data) => lifecycle.setLockSettings(data),
    getThemePreference: () => lifecycle.getThemePreference(),
    setThemePreference: (data) => lifecycle.setThemePreference(data),
    getDisplaySettings: () => lifecycle.getDisplaySettings(),
    setDisplaySettings: (data) => lifecycle.setDisplaySettings(data),
    getSecurityPhrase: () => securityPhrase.get(),
    setSecurityPhrase: (data) => securityPhrase.set(data),
    revokeGrant: async (data) => {
      await approval.revokeGrant(data);
      void announceAccessEnded(data.origin);
    },
    getActiveSite: async () => siteWallet.activeSite(await tabs.activeTab()),
    useGleamOnSite: async (data) => {
      const origin = requireWebOrigin(data.origin);
      await approval.grantSite({ origin, permissions: data.permissions, favIconUrl: await favIconFor(origin) });
      await siteWallet.setUseGleam(origin, true);
      await pushSiteWalletMode(origin, true);
      await reloadActiveTabFor(origin);
    },
    stopGleamOnSite: async (data) => {
      const origin = requireWebOrigin(data.origin);
      await approval.revokeGrant({ origin });
      await announceAccessEnded(origin);
      await reloadActiveTabFor(origin);
    },
    dismissSiteSuggestion: (data) => siteWallet.dismiss(requireWebOrigin(data.origin)),
    saveContact: (data) => contacts.saveContact(data),
    deleteContact: (data) => contacts.deleteContact(data),
    saveBrowserSite: (data) => browserSites.saveBrowserSite(data),
    removeBrowserSite: (data) => browserSites.removeBrowserSite(data),
    recordRecentSite: (data) => browserSites.recordRecentSite(data),
    clearRecentSites: () => browserSites.clearRecentSites(),

    // Gleam Points
    joinPoints: (data) => points.join(data),
    leavePoints: (data) => points.leave(data),
    getPointsMemberships: () => points.getMemberships(),
    getPointsScores: () => points.scores(),
    getPointsInviteUnlock: () => points.getInviteUnlock(),
    redeemPointsInvite: (data) => points.redeemInvite(data.code),
    getPointsPendingInvite: () => points.pendingInvite(),
    getPointsRevealSeen: () => points.getRevealSeen(),
    markPointsRevealSeen: (data) => points.markRevealSeen(data),
    getPointsClaimPending: () => points.getClaimPending(),
    setPointsClaimPending: (data) => points.setClaimPending(data),
    getPointsShareSeen: () => points.getShareSeen(),
    markPointsShareSeen: (data) => points.markShareSeen(data),
    getPointsSeatsSeen: () => points.getSeatsSeen(),
    markPointsSeatsSeen: (data) => points.markSeatsSeen(data),
    getAnnouncements: () => announcements.fetchAnnouncements(),
    getScanStats: () => scans.stats(),
    getDismissedAnnouncements: () => announcements.getDismissed(),
    dismissAnnouncement: (data) => announcements.dismiss(data),
    getReviewPrompt: (data) => reviewPrompt.get(data),
    finishReviewPrompt: () => reviewPrompt.finish(),

    // content script
    getSiteWalletMode: (_data, { origin }) => siteWallet.mode(origin),
    reportOtherWallet: (data, { origin, tabId }) => {
      if (typeof tabId !== "number") {
        throw new Error("reportOtherWallet is only accepted from a web page's content script.");
      }
      return siteWallet.report(tabId, origin, data);
    },
    // The only path a web page has into the wallet. Not `async`: the
    // grant-independent refusals throw before anything is awaited.
    providerCall: ({ method, params }, { origin }) =>
      dispatchProviderCall(origin, method, params).then(encodeProviderResult),
  };

  /**
   * Runs `type`'s handler if `caller` holds its `BACKGROUND_MESSAGES` tier,
   * checked before its params are parsed or its handler runs. A content
   * script shares the extension's messaging channel, so without this a
   * compromised page's content script could export keys or approve its own
   * requests. A null `caller` matches no tier.
   */
  function dispatch(type: BackgroundMessage, data: unknown, caller: CallerContext | null): unknown {
    const spec: ExtensionMethodSpec | ContentScriptMethodSpec = BACKGROUND_MESSAGES[type];
    const handle = MESSAGE_HANDLERS[type] as (data: unknown, caller?: ContentScriptCaller) => unknown;
    if (spec.tier === "extension") {
      if (caller?.tier !== "extension") {
        throw new Error(`"${type}" can only be called from the Gleam extension.`);
      }
      return handle(data);
    }
    if (caller?.tier !== "contentScript") throw new Error(`${type} is only accepted from a web page's content script.`);
    return handle(parseParams(spec.params, data), caller);
  }

  /**
   * First-run gateway fallback: if `local:networkSettings` has never been
   * written, checks whether `arweave.net` actually answers as a gateway
   * and, if not, tries `FALLBACK_GATEWAY_URLS` in order
   * (`resolveInitialGatewayUrl` — pure, given `fetch`). Only ever writes
   * `NETWORK_SETTINGS_KEY` when it was previously empty, so a user's own
   * gateway choice is never touched. Errors are swallowed: this must never
   * block startup, and `reads.ts`'s own `DEFAULT_NETWORK_SETTINGS` fallback
   * already covers "nothing was ever written" for every other read path.
   */
  async function initializeNetworkSettingsIfMissing(): Promise<void> {
    try {
      const existing = await storage.get<NetworkSettings>(NETWORK_SETTINGS_KEY);
      if (existing !== null) return;

      const gatewayUrl = await resolveInitialGatewayUrl();
      const settings = await reads.getNetworkSettings();
      await storage.set(NETWORK_SETTINGS_KEY, { ...settings, gatewayUrl });
    } catch {
      // Never block startup over a first-run gateway probe.
    }
  }

  async function activeWallet() {
    const state = await lifecycle.getState();
    return state.wallets.find((wallet) => wallet.id === state.activeWalletId) ?? null;
  }

  function dispatchSite(message: unknown, caller: CallerContext | null): Promise<unknown> {
    return dispatchSiteMessage(message, caller, {
      "gleam-points:invite": (invite) => redeemSiteInvite(invite, storage, points).catch(() => ({ ok: false })),
      "gleam-points:attest": (request) =>
        signSiteAttestation(request, {
          activeWallet,
          requestScanAttestation: (req) => approval.requestScanAttestation(req),
        }).catch((error: unknown): SiteAttestResponse => {
          console.error("Couldn't handle a scan attestation from the site.", error);
          return { ok: false, code: "signing_failed", error: "Gleam couldn't open the attestation. Open the link again." };
        }),
      "gleam-points:attest-status": () =>
        siteAttestStatus({
          activeWallet,
          isMember: async (walletId) => (await points.getMemberships())[walletId] !== undefined,
          // The check only labels the page's button; Sign still runs the real one and says what failed.
        }).catch(() => ({ ok: true })),
    }, platform.dev);
  }

  return {
    dispatch,
    dispatchSite,
    start() {
      // Takes the session lock before any event this start delivers.
      reconcileKeyring().catch((error: unknown) => console.error("Couldn't reconcile the keyring.", error));

      // Installs that had a vault before the gate existed (and every start
      // after) are marked unlocked, so a reset never locks them out.
      void lifecycle
        .getState()
        .then((state) => (state.wallets.length > 0 ? points.markUnlockedForVault() : undefined))
        .catch(() => {});
    },
    onBrowserStartup() {
      withSessionLock(clearKeyCache).catch((error: unknown) =>
        console.error("Couldn't clear session keys at startup.", error),
      );
    },
    onTabClosed(tabId) {
      void siteWallet.forgetTab(tabId).catch(() => undefined);
    },
    onIdleStateChanged(state) {
      lockOnScreenLock(state).catch((error: unknown) => console.error("Couldn't lock on screen lock.", error));
    },
    onInstalled(reason) {
      // Only an install finds `local:networkSettings` empty; after that a
      // written NetworkSettings (default or user-edited) short-circuits it.
      void initializeNetworkSettingsIfMissing();
      if (reason === "update") {
        lifecycle.keepLockTimeoutOnUpdate().catch((error: unknown) => console.error("Couldn't keep the lock timeout.", error));
      }
    },
  };
}
