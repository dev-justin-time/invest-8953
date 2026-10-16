import * as schema from "../../database/schema";
import { logDecision } from "../log";
import type { Db } from "./tx";

export async function addNotice(
  tx: Db,
  notice: {
    memberId: number;
    projectId?: number | null;
    kind: string;
    title: string;
    body: string;
    recoveryPath?: string;
    dueAt?: Date | null;
  },
) {
  logDecision("notices", notice.kind, { memberId: notice.memberId, projectId: notice.projectId });
  await tx.insert(schema.notices).values({
    memberId: notice.memberId,
    projectId: notice.projectId ?? null,
    kind: notice.kind,
    title: notice.title,
    body: notice.body,
    recoveryPath: notice.recoveryPath ?? null,
    dueAt: notice.dueAt ?? null,
  });
}
