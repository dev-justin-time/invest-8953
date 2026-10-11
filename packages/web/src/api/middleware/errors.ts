import { ORPCError } from "@orpc/server";
import { base as coreBase } from "../__core/app";

/**
 * Procedure base that logs unexpected server faults (never inputs, tokens or secrets).
 * Expected business rejections (ORPCError) pass through untouched.
 */
export const base = coreBase.use(async ({ next, path }) => {
  try {
    return await next();
  } catch (error) {
    if (!(error instanceof ORPCError)) {
      const message = error instanceof Error ? error.message : String(error);
      const causes: string[] = [];
      let current: unknown = error instanceof Error ? error.cause : undefined;
      while (current && causes.length < 4) {
        const c = current as { message?: string; code?: string; cause?: unknown };
        causes.push([c.code, c.message].filter(Boolean).join(": ") || String(current));
        current = c.cause;
      }
      console.error(`[api] fault in ${path.join(".")}: ${message.split("\n")[0]}${causes.length ? ` | cause: ${causes.join(" <- ")}` : ""}`);
    }
    throw error;
  }
});
