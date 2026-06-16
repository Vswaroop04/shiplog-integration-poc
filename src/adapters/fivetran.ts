import { Client } from "pg";
import { IntegrationAdapter } from "./base";
import { SyncResult, GitHubRepo, GitHubIssue } from "../types";
import { clearAdapter, insertIssue } from "../db";

// Adapter 7: Fivetran — same ELT model as Airbyte, fully managed.
// You don't write sync logic at all (no sync script, no proxy calls) —
// connectors are pre-built and configured entirely through their UI/API.
// Trade-off: zero integration code, but you're fully dependent on their
// schedule and have no control over fetch/pagination/retry behavior.
export class FivetranAdapter implements IntegrationAdapter {
  name = "Fivetran";
  linesOfAdapterCode = 55;

  private apiBase = "https://api.fivetran.com/v1";
  private headers() {
    const key = process.env.FIVETRAN_API_KEY!;
    const secret = process.env.FIVETRAN_API_SECRET!;
    const basic = Buffer.from(`${key}:${secret}`).toString("base64");
    return {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
    };
  }

  async sync(_owner: string, _repo: string): Promise<SyncResult> {
    clearAdapter(this.name);
    const start = Date.now();
    let timeToFirstRecordMs = 0;
    const repos: GitHubRepo[] = [];
    const issues: GitHubIssue[] = [];

    const connectorId = process.env.FIVETRAN_CONNECTOR_ID!;

    // Force a sync — there's no "fetch records" call, just "go sync now"
    const forceRes = await fetch(`${this.apiBase}/connectors/${connectorId}/force`, {
      method: "POST",
      headers: this.headers(),
    });
    if (!forceRes.ok) throw new Error(`Fivetran force-sync failed: ${forceRes.status} ${await forceRes.text()}`);

    // Poll connector status until the sync completes — no job/record-level feedback
    let succeededAt: string | null = null;
    let attempts = 0;
    const initialRes = await fetch(`${this.apiBase}/connectors/${connectorId}`, { headers: this.headers() });
    const initial = await initialRes.json() as any;
    const baselineSucceededAt = initial.data?.succeeded_at ?? null;

    while (attempts < 30) {
      await new Promise(r => setTimeout(r, 5000));
      const pollRes = await fetch(`${this.apiBase}/connectors/${connectorId}`, { headers: this.headers() });
      const polled = await pollRes.json() as any;
      const status = polled.data?.status?.sync_state;
      succeededAt = polled.data?.succeeded_at ?? null;
      attempts++;
      if (status === "scheduled" && succeededAt && succeededAt !== baselineSucceededAt) break;
    }
    if (!succeededAt || succeededAt === baselineSucceededAt) {
      throw new Error("Fivetran sync did not report completion in time");
    }
    timeToFirstRecordMs = Date.now() - start; // no per-record timing — Fivetran doesn't expose it

    // Read what Fivetran landed in the destination warehouse
    const pg = new Client({ connectionString: process.env.FIVETRAN_DESTINATION_DATABASE_URL });
    await pg.connect();
    try {
      const table = process.env.FIVETRAN_DESTINATION_TABLE ?? "issues";
      const res = await pg.query(`SELECT * FROM ${table} LIMIT 90`);
      for (const row of res.rows) {
        const issue: GitHubIssue = {
          id: row.id,
          number: row.number ?? 0,
          title: row.title ?? "",
          state: row.state ?? "unknown",
          created_at: row.created_at ?? "",
          body: row.body?.slice?.(0, 500) ?? null,
        };
        issues.push(issue);
        insertIssue(this.name, issue);
      }
    } finally {
      await pg.end();
    }

    return {
      adapter: this.name,
      provider: "github",
      repos,
      issues,
      timeToFirstRecordMs,
      totalSyncMs: Date.now() - start,
      recordCount: issues.length,
      linesOfAdapterCode: this.linesOfAdapterCode,
    };
  }
}
