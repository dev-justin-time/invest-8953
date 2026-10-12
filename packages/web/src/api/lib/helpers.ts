import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { db } from "../database/client";
import * as schema from "../database/schema";
import { RESERVE_RATE } from "./economy";
import { logDecision } from "./log";

export async function getMember(id: number) {
  const [member] = await db.select().from(schema.members).where(eq(schema.members.id, id));
  if (!member) throw new ORPCError("NOT_FOUND", { message: "Member not found" });
  return member;
}

export async function getProject(id: number) {
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
  if (!project) throw new ORPCError("NOT_FOUND", { message: "Project not found" });
  return project;
}

export async function requireAdmin(memberId: number) {
  const member = await getMember(memberId);
  if (member.role !== "admin") {
    logDecision("authorization", "Admin gate rejected", { memberId });
    throw new ORPCError("FORBIDDEN", { message: "House desk only" });
  }
  return member;
}

export type LedgerEntry = {
  kind: string;
  amountCents: number;
  memberId?: number | null;
  projectId?: number | null;
  bucket?: string;
  note?: string;
};

export async function addLedger(entry: LedgerEntry) {
  logDecision("ledger", entry.kind, { cents: entry.amountCents, bucket: entry.bucket, projectId: entry.projectId });
  await db.insert(schema.ledger).values({
    kind: entry.kind,
    amountCents: entry.amountCents,
    memberId: entry.memberId ?? null,
    projectId: entry.projectId ?? null,
    bucket: entry.bucket ?? "house",
    note: entry.note ?? null,
  });
}

/** Records the 10% house take and parks a slice of it in the Mutual Cover Reserve. */
export async function takeHouseFee(args: {
  amountCents: number;
  feeCents: number;
  memberId?: number | null;
  projectId?: number | null;
  note: string;
}) {
  const reserveCut = Math.round(args.feeCents * RESERVE_RATE);
  logDecision("fees", "House fee partitioned", { grossCents: args.amountCents, feeCents: args.feeCents, reserveCents: reserveCut });
  await addLedger({
    kind: "house_fee",
    amountCents: args.feeCents - reserveCut,
    memberId: args.memberId,
    projectId: args.projectId,
    bucket: "house",
    note: args.note,
  });
  if (reserveCut > 0) {
    await addLedger({
      kind: "reserve_contribution",
      amountCents: reserveCut,
      memberId: args.memberId,
      projectId: args.projectId,
      bucket: "reserve",
      note: `Reserve share of ${args.note}`,
    });
  }
  return { houseCents: args.feeCents - reserveCut, reserveCents: reserveCut };
}

export async function debitWallet(memberId: number, amountCents: number, label: string) {
  const member = await getMember(memberId);
  if (member.walletCents < amountCents) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Simulated wallet short by $${((amountCents - member.walletCents) / 100).toFixed(2)} for ${label}`,
    });
  }
  await db
    .update(schema.members)
    .set({ walletCents: member.walletCents - amountCents })
    .where(eq(schema.members.id, memberId));
  return member.walletCents - amountCents;
}

export async function creditWallet(memberId: number, amountCents: number) {
  const member = await getMember(memberId);
  await db
    .update(schema.members)
    .set({ walletCents: member.walletCents + amountCents })
    .where(eq(schema.members.id, memberId));
  return member.walletCents + amountCents;
}

export async function addNotice(notice: {
  memberId: number;
  projectId?: number | null;
  kind: string;
  title: string;
  body: string;
  recoveryPath?: string;
  dueAt?: Date | null;
}) {
  logDecision("notices", notice.kind, { memberId: notice.memberId, projectId: notice.projectId });
  await db.insert(schema.notices).values({
    memberId: notice.memberId,
    projectId: notice.projectId ?? null,
    kind: notice.kind,
    title: notice.title,
    body: notice.body,
    recoveryPath: notice.recoveryPath ?? null,
    dueAt: notice.dueAt ?? null,
  });
}
