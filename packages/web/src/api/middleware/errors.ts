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
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
      console.error(`[api] fault in ${path.join(".")}: ${message}${cause ? ` (cause: ${cause})` : ""}`);
    }
    throw error;
  }
});
