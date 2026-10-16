import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { auth } from "../auth";
import { db } from "../database/client";
import * as schema from "../database/schema";
import { logDecision } from "../lib/log";
import { base } from "./errors";

/**
 * Procedure bases, from least to most privileged. Identity always comes from the Better Auth
 * session on the request — never from a member id in the input.
 *
 * - `publicProc`  anyone; `context.user` / `context.member` may be null
 * - `signedIn`    any authenticated account, passport optional (onboarding)
 * - `memberProc`  authenticated account that owns a passport
 * - `adminProc`   passport with role `admin` (granted only by scripts/grant-admin.ts)
 */

export type Member = typeof schema.members.$inferSelect;

async function resolve(headers: Headers) {
  const session = await auth.api.getSession({ headers });
  if (!session) return { user: null, member: null as Member | null };
  const [member] = await db.select().from(schema.members).where(eq(schema.members.authUserId, session.user.id));
  return { user: { id: session.user.id, email: session.user.email, name: session.user.name }, member: member ?? null };
}

export const publicProc = base.use(async ({ context, next }) => {
  const viewer = await resolve(context.headers);
  return next({ context: viewer });
});

export const signedIn = base.use(async ({ context, next, path }) => {
  const viewer = await resolve(context.headers);
  if (!viewer.user) {
    logDecision("authorization", "Unauthenticated call rejected", { path: path.join(".") });
    throw new ORPCError("UNAUTHORIZED", { message: "Sign in to continue" });
  }
  return next({ context: { user: viewer.user, member: viewer.member } });
});

export const memberProc = base.use(async ({ context, next, path }) => {
  const viewer = await resolve(context.headers);
  if (!viewer.user) {
    logDecision("authorization", "Unauthenticated call rejected", { path: path.join(".") });
    throw new ORPCError("UNAUTHORIZED", { message: "Sign in to continue" });
  }
  if (!viewer.member) {
    logDecision("authorization", "Account without passport rejected", { path: path.join(".") });
    throw new ORPCError("PRECONDITION_FAILED", { message: "Finish your passport on /join first" });
  }
  return next({ context: { user: viewer.user, member: viewer.member } });
});

export const adminProc = memberProc.use(async ({ context, next, path }) => {
  if (context.member.role !== "admin") {
    logDecision("authorization", "Admin gate rejected", { memberId: context.member.id, path: path.join(".") });
    throw new ORPCError("FORBIDDEN", { message: "House desk only" });
  }
  return next();
});

/** Audit actor for the current request. */
export const actorOf = (ctx: { user: { id: string } | null; member: Member | null }) => ({
  memberId: ctx.member?.id ?? null,
  userId: ctx.user?.id ?? null,
});
