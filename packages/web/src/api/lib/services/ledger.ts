import * as schema from "../../database/schema";
import { HOUSE_RATE, RESERVE_RATE } from "../economy";
import { logDecision } from "../log";
import type { Db } from "./tx";
import { debit } from "./wallet";

/**
 * Ledger rules (no double counting):
 * - A service charge (pitch, level, unlock, IP desk) is house revenue in full. It is booked once:
 *   house (F − reserve) + reserve. The reserve slice is 25% of the 10% house take on F.
 * - A trade fee is 10% of the gross; the reserve gets 25% of that fee, the house keeps the rest.
 * The member-side movement lives in wallet_entries; the ledger only records where the money landed.
 */

export type LedgerEntry = {
  kind: string;
  amountCents: number;
  memberId?: number | null;
  projectId?: number | null;
  bucket?: string;
  note?: string;
};

export async function addLedger(tx: Db, entry: LedgerEntry) {
  logDecision("ledger", entry.kind, { cents: entry.amountCents, bucket: entry.bucket ?? "house", projectId: entry.projectId });
  await tx.insert(schema.ledger).values({
    kind: entry.kind,
    amountCents: entry.amountCents,
    memberId: entry.memberId ?? null,
    projectId: entry.projectId ?? null,
    bucket: entry.bucket ?? "house",
    note: entry.note ?? null,
  });
}

export function feeSplit(feeCents: number) {
  const reserveCents = Math.round(feeCents * RESERVE_RATE);
  return { feeCents, reserveCents, houseCents: feeCents - reserveCents };
}

export function tradeFee(grossCents: number) {
  return feeSplit(Math.round(grossCents * HOUSE_RATE));
}

/** Books a fee that has already left a wallet: house share + reserve share, each once. */
export async function bookFee(tx: Db, args: { kind: string; feeCents: number; memberId?: number | null; projectId?: number | null; note: string }) {
  const split = feeSplit(args.feeCents);
  if (split.houseCents > 0) {
    await addLedger(tx, { kind: args.kind, amountCents: split.houseCents, memberId: args.memberId, projectId: args.projectId, bucket: "house", note: args.note });
  }
  if (split.reserveCents > 0) {
    await addLedger(tx, { kind: "reserve_contribution", amountCents: split.reserveCents, memberId: args.memberId, projectId: args.projectId, bucket: "reserve", note: `Reserve share of ${args.note}` });
  }
  logDecision("fees", "Fee partitioned", split);
  return split;
}

/**
 * A flat service charge: the member pays F, the house keeps F minus a reserve slice equal to
 * 25% of the 10% house take on F.
 */
export async function chargeService(tx: Db, args: { kind: string; amountCents: number; memberId: number; projectId?: number | null; note: string }) {
  await debit(tx, args.memberId, args.amountCents, args.note, args.projectId);
  const reserveCents = Math.round(args.amountCents * HOUSE_RATE * RESERVE_RATE);
  const houseCents = args.amountCents - reserveCents;
  await addLedger(tx, { kind: args.kind, amountCents: houseCents, memberId: args.memberId, projectId: args.projectId, bucket: "house", note: args.note });
  if (reserveCents > 0) {
    await addLedger(tx, { kind: "reserve_contribution", amountCents: reserveCents, memberId: args.memberId, projectId: args.projectId, bucket: "reserve", note: `Reserve share of ${args.note}` });
  }
  logDecision("fees", "Service charge booked", { kind: args.kind, amountCents: args.amountCents, houseCents, reserveCents });
  return { houseCents, reserveCents };
}
