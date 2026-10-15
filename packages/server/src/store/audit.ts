import { AuditEvent } from "@repowiki/hosted";
import type { Queryable } from "../db/db.ts";
import { asJson, parsedBody } from "./rows.ts";

export async function appendAudit(tx: Queryable, event: AuditEvent): Promise<void> {
  const body = parsedBody(AuditEvent, event, "audit event");
  await tx.query("INSERT INTO audit_events (id, created_at, body) VALUES ($1, $2, $3::jsonb)", [
    body.id,
    body.createdAt,
    asJson(body),
  ]);
}
