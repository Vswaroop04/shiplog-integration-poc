import { Client } from "pg";
import { IntegrationAdapter } from "./base";
import { SyncResult, GitHubRepo, GitHubIssue } from "../types";
import { clearAdapter, insertIssue } from "../db";

// Adapter 6: Airbyte — ELT, not request/response.
// Unlike every other adapter here, Airbyte doesn't hand you records directly.
// You trigger a sync job, Airbyte pulls from GitHub on its own schedule/pace,
// and writes normalized rows into a destination YOU configure (here: Postgres).
// Your code then reads from that destination, not from Airbyte's API.
//
// This is the fundamental architectural difference vs Nango/Merge/Truto:
// those are "pull on demand" platforms. Airbyte/Fivetran are "push to warehouse."
export class AirbyteAdapter implements IntegrationAdapter {
  name = "Airbyte";
  linesOfAdapterCode = 65;

  private apiBase = "https://api.airbyte.com/v1";
  private headers() {
    return {
      Authorization: `Bearer ${process.env.AIRBYTE_API_TOKEN}`,
      "Content-Type": "application/json",
    };
  }

  async sync(_owner: string, _repo: string): Promise<SyncResult> {
    clearAdapter(this.name);
    const start = Date.now();
    let timeToFirstRecordMs = 0;
    const repos: GitHubRepo[] = [];
    const issues: GitHubIssue[] = [];

    const connectionId = process.env.AIRBYTE_CONNECTION_ID!;

    // Trigger a sync job — Airbyte fetches from GitHub asynchronously
    const jobRes = await fetch(`${this.apiBase}/jobs`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jobType: "sync", connectionId }),
    });
    if (!jobRes.ok) throw new Error(`Airbyte job trigger failed: ${jobRes.status} ${await jobRes.text()}`);
    const job = await jobRes.json() as any;

    // Poll until the job finishes — you don't get records, you get a job status
    let status = job.status;
    let attempts = 0;
    while (status !== "succeeded" && status !== "failed" && attempts < 30) {
      await new Promise(r => setTimeout(r, 5000));
      const pollRes = await fetch(`${this.apiBase}/jobs/${job.jobId}`, { headers: this.headers() });
      const polled = await pollRes.json() as any;
      status = polled.status;
      attempts++;
    }
    if (status !== "succeeded") throw new Error(`Airbyte sync did not succeed (status: ${status})`);
    timeToFirstRecordMs = Date.now() - start; // best we can measure — no per-record timing exposed

    // Now read the data Airbyte landed in the destination Postgres table
    const pg = new Client({ connectionString: process.env.AIRBYTE_DESTINATION_DATABASE_URL });
    await pg.connect();
    try {
      const table = process.env.AIRBYTE_DESTINATION_TABLE ?? "issues";
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
