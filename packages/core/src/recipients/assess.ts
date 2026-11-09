import type { ActivityEntry } from "../models/activity";

export interface RecipientAssessment {
  /** No prior activity with this address, and it is not a saved contact or one of your wallets. */
  firstTime: boolean;
  /** A trusted address this one closely resembles but isn't: a spoof or a one-character slip. */
  lookalikeOf: string | null;
}

/** Characters compared at each end; wallets and block explorers truncate to about this many. */
export const LOOKALIKE_EDGE_LENGTH = 4;

/**
 * Characters in the same position that make two equal-length addresses
 * "close". Unrelated base64url addresses share a position about once in
 * 64, so 8 of 43 by chance is around one in a hundred million, while a
 * one-character edit keeps 42.
 */
const SHARED_POSITIONS_FOR_LOOKALIKE = 8;

/**
 * Whether `recipient` closely resembles `known` without being it. An
 * attacker grinds a vanity address to match the edges of a victim's past
 * counterparty and sends dust so it shows up in the history the victim
 * copies from; matching either edge is far cheaper to grind than both, so
 * either counts. A near-copy with a character changed anywhere, a typo or
 * a tampered paste, counts too.
 */
export function isLookalike(recipient: string, known: string): boolean {
  if (recipient === known) return false;
  const minLength = LOOKALIKE_EDGE_LENGTH * 2 + 1;
  if (recipient.length < minLength || known.length < minLength) return false;
  if (recipient.startsWith(known.slice(0, LOOKALIKE_EDGE_LENGTH))) return true;
  if (recipient.endsWith(known.slice(-LOOKALIKE_EDGE_LENGTH))) return true;
  if (recipient.length !== known.length) return false;
  let shared = 0;
  for (let i = 0; i < recipient.length; i++) if (recipient[i] === known[i]) shared++;
  return shared >= SHARED_POSITIONS_FOR_LOOKALIKE;
}

/**
 * `history` is every activity entry available (local log plus gateway
 * results); `entry.address` is the counterparty. `knownAddresses` are
 * trusted without history: saved contacts and the user's own wallets.
 *
 * Only known addresses and addresses the user has sent to count as
 * references for the lookalike check. The poisoner's dust arrives as a
 * receive, so a received-only address can itself be the fake: it shows up in
 * history, which is why `lookalikeOf` is checked even when the address has
 * been seen. When several references resemble the recipient, the most
 * recently sent-to one wins.
 */
export function assessRecipient(
  recipient: string,
  history: ActivityEntry[],
  knownAddresses: string[] = [],
): RecipientAssessment {
  const sentTo = history
    .filter((entry) => entry.type === "send")
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((entry) => entry.address);
  const references = [...knownAddresses, ...sentTo];

  if (references.includes(recipient)) {
    return { firstTime: false, lookalikeOf: null };
  }

  const lookalikeOf = references.find((address) => isLookalike(recipient, address)) ?? null;
  // Anything left is not a contact, not one of the user's wallets and was never
  // sent to, so it stays first time even when the history holds it: any site can
  // dust the wallet a minute before it asks for a payment, and the receive would
  // otherwise silence the warning for a brand-new, unremarkable address.
  return { firstTime: true, lookalikeOf };
}
