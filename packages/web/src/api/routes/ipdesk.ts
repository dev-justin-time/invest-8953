import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { logDecision } from "../lib/log";
import { base } from "../middleware/errors";
import { db } from "../database/client";
import * as schema from "../database/schema";
import { TEMPLATES, renderDocument, templateFor } from "../lib/ip-templates";
import { addLedger, debitWallet, getMember, takeHouseFee } from "../lib/helpers";

const kindEnum = z.enum([
  "provisional_patent",
  "copyright_registration",
  "trademark_intent",
  "nda",
  "work_for_hire",
  "ip_assignment",
]);

/** Desk fee for document preparation. Government filing fees are never ours. */
const DESK_FEE_CENTS: Record<string, number> = {
  provisional_patent: 4900,
  copyright_registration: 2900,
  trademark_intent: 3900,
  nda: 0,
  work_for_hire: 900,
  ip_assignment: 1900,
};

export const ipdesk = {
  templates: base.handler(() =>
    TEMPLATES.map((t) => ({ ...t, deskFeeCents: DESK_FEE_CENTS[t.kind] ?? 0 })),
  ),

  template: base.input(z.object({ kind: kindEnum })).handler(({ input }) => {
    const t = templateFor(input.kind);
    if (!t) throw new ORPCError("NOT_FOUND", { message: "No such template" });
    return { ...t, deskFeeCents: DESK_FEE_CENTS[t.kind] ?? 0 };
  }),

  /** Renders the document without charging — the member reads it before paying. */
  preview: base
    .input(z.object({ kind: kindEnum, formData: z.record(z.string(), z.string()) }))
    .handler(({ input }) => ({
      documentText: renderDocument(input.kind, input.formData),
      deskFeeCents: DESK_FEE_CENTS[input.kind] ?? 0,
    })),

  generate: base
    .input(
      z.object({
        memberId: z.number(),
        projectId: z.number().optional(),
        kind: kindEnum,
        title: z.string().min(2).max(140),
        formData: z.record(z.string(), z.string()),
      }),
    )
    .handler(async ({ input }) => {
      const spec = templateFor(input.kind);
      if (!spec) throw new ORPCError("NOT_FOUND", { message: "No such template" });
      const missing = spec.fields
        .filter((f) => f.required && !input.formData[f.name]?.trim())
        .map((f) => f.label);
      if (missing.length) {
        throw new ORPCError("BAD_REQUEST", { message: `Still needed: ${missing.join(", ")}` });
      }

      const member = await getMember(input.memberId);
      const fee = DESK_FEE_CENTS[input.kind] ?? 0;
      if (fee > 0) {
        await debitWallet(member.id, fee, `${spec.title} preparation`);
        await addLedger({
          kind: "pitch_fee",
          amountCents: fee,
          memberId: member.id,
          projectId: input.projectId ?? null,
          bucket: "house",
          note: `IP Desk: ${spec.title}`,
        });
        await takeHouseFee({
          amountCents: fee,
          feeCents: Math.round(fee * 0.1),
          memberId: member.id,
          projectId: input.projectId ?? null,
          note: `IP Desk ${spec.title}`,
        });
      }

      logDecision("ipdesk", "Draft preparation, no government filing", { memberId: member.id, kind: input.kind, deskCents: fee });
      const documentText = renderDocument(input.kind, input.formData);
      const [filing] = await db
        .insert(schema.ipFilings)
        .values({
          memberId: member.id,
          projectId: input.projectId ?? null,
          kind: input.kind,
          title: input.title,
          formData: JSON.stringify(input.formData),
          documentText,
          status: "generated",
        })
        .returning();

      await db
        .update(schema.members)
        .set({ clout: member.clout + 5 })
        .where(eq(schema.members.id, member.id));

      return filing;
    }),

  mine: base.input(z.object({ memberId: z.number() })).handler(({ input }) =>
    db
      .select()
      .from(schema.ipFilings)
      .where(eq(schema.ipFilings.memberId, input.memberId))
      .orderBy(desc(schema.ipFilings.createdAt)),
  ),

  get: base.input(z.object({ filingId: z.number(), memberId: z.number() })).handler(async ({ input }) => {
    const [filing] = await db
      .select()
      .from(schema.ipFilings)
      .where(eq(schema.ipFilings.id, input.filingId));
    if (!filing || filing.memberId !== input.memberId) {
      throw new ORPCError("NOT_FOUND", { message: "Filing not found" });
    }
    return filing;
  }),

  requestAttorneyReview: base
    .input(z.object({ memberId: z.number(), filingId: z.number() }))
    .handler(async ({ input }) => {
      const [filing] = await db
        .select()
        .from(schema.ipFilings)
        .where(eq(schema.ipFilings.id, input.filingId));
      if (!filing || filing.memberId !== input.memberId) {
        throw new ORPCError("NOT_FOUND", { message: "Filing not found" });
      }
      await db
        .update(schema.ipFilings)
        .set({ status: "attorney_review" })
        .where(eq(schema.ipFilings.id, filing.id));
      return {
        ok: true,
        message:
          "Queued for the reviewing attorney panel. In production this routes to a licensed practitioner in the relevant jurisdiction at a flat fee; the Desk never files on your behalf without that sign-off.",
      };
    }),
};
