import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "../models/activity";
import { assessRecipient, isLookalike } from "./assess";

const FRIEND = "AbcdXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXwxyz";
const POISON = "AbcdYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYwxyz";
const STRANGER = "QqqqZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZrrrr";

function entry(overrides: Partial<ActivityEntry>): ActivityEntry {
  return {
    txId: "tx",
    type: "send",
    status: "confirmed",
    address: FRIEND,
    amount: "1",
    tags: [],
    timestamp: 100,
    ...overrides,
  };
}

describe("isLookalike", () => {
  const REAL = "weY8dOVhGi9BhGV3B-pkKVWA1ox_n8gzSKOHOJ14uFk";

  it("matches the same first 4 and last 4 with a different middle", () => {
    expect(isLookalike(POISON, FRIEND)).toBe(true);
  });
  it("is false for the identical address", () => {
    expect(isLookalike(FRIEND, FRIEND)).toBe(false);
  });
  it("matches when only the start matches", () => {
    expect(isLookalike("AbcdYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYzzzz", FRIEND)).toBe(true);
  });
  it("matches when only the end matches", () => {
    expect(isLookalike("ZZZZYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYwxyz", FRIEND)).toBe(true);
  });
  it("matches a one-character change at either end or in the middle", () => {
    expect(isLookalike(`${REAL.slice(0, -1)}d`, REAL)).toBe(true);
    expect(isLookalike(`X${REAL.slice(1)}`, REAL)).toBe(true);
    expect(isLookalike(`${REAL.slice(0, 20)}Q${REAL.slice(21)}`, REAL)).toBe(true);
  });
  it("is false for an unrelated address", () => {
    expect(isLookalike("FTYahWI3m13z-Ms9mStWjDnqUB-d3jHJqMP_bKrKhHs", REAL)).toBe(false);
  });
  it("is case sensitive", () => {
    expect(isLookalike("abcdYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYWXYZ", FRIEND)).toBe(false);
  });
  it("ignores strings too short to have distinct edges", () => {
    expect(isLookalike("abcdwxyz", "abcdQwxyz")).toBe(false);
  });
});

describe("assessRecipient", () => {
  it("flags an address with no history as first time", () => {
    expect(assessRecipient(STRANGER, [], [])).toEqual({ firstTime: true, lookalikeOf: null });
  });

  it("is quiet for an address the wallet has sent to", () => {
    expect(assessRecipient(FRIEND, [entry({})], [])).toEqual({ firstTime: false, lookalikeOf: null });
  });

  it("stays first time for an address the wallet has only received from", () => {
    const history = [entry({ type: "receive" })];
    expect(assessRecipient(FRIEND, history, [])).toEqual({ firstTime: true, lookalikeOf: null });
  });

  it("stays first time for a stranger that dusted the wallet, so one receive cannot vouch for it", () => {
    const history = [entry({ txId: "dust", type: "receive", address: STRANGER, timestamp: 200 })];
    expect(assessRecipient(STRANGER, history, [])).toEqual({ firstTime: true, lookalikeOf: null });
  });

  it("is quiet for a saved contact or own wallet with no history", () => {
    expect(assessRecipient(FRIEND, [], [FRIEND])).toEqual({ firstTime: false, lookalikeOf: null });
  });

  it("flags a lookalike of a past recipient and names it", () => {
    expect(assessRecipient(POISON, [entry({})], [])).toEqual({ firstTime: true, lookalikeOf: FRIEND });
  });

  it("flags a lookalike of a contact", () => {
    expect(assessRecipient(POISON, [], [FRIEND])).toEqual({ firstTime: true, lookalikeOf: FRIEND });
  });

  it("flags a dust sender that resembles a past recipient, and keeps it first time", () => {
    const history = [entry({}), entry({ txId: "dust", type: "receive", address: POISON, timestamp: 200 })];
    expect(assessRecipient(POISON, history, [])).toEqual({ firstTime: true, lookalikeOf: FRIEND });
  });

  it("does not treat a received-only address as a reference", () => {
    const history = [entry({ type: "receive" })];
    expect(assessRecipient(POISON, history, [])).toEqual({ firstTime: true, lookalikeOf: null });
  });

  it("names the most recently sent-to resemblance", () => {
    const older = "AbcdOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOwxyz";
    const history = [
      entry({ txId: "a", address: older, timestamp: 50 }),
      entry({ txId: "b", address: FRIEND, timestamp: 150 }),
    ];
    expect(assessRecipient(POISON, history, []).lookalikeOf).toBe(FRIEND);
  });

  it("stays first time without a lookalike when nothing resembles the recipient", () => {
    expect(assessRecipient(STRANGER, [entry({})], [FRIEND])).toEqual({ firstTime: true, lookalikeOf: null });
  });
});
