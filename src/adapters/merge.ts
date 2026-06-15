import { IntegrationAdapter } from "./base";
import { SyncResult, GitHubRepo, GitHubIssue } from "../types";
import { clearAdapter, insertIssue } from "../db";

// Adapter 3: Merge.dev — unified API with a fixed schema
// Merge normalizes GitHub issues into their "Ticket" model automatically.
// You don't write any transformation logic — but you're locked into their schema.
export class MergeAdapter implements IntegrationAdapter {
  name = "Merge.dev";
  linesOfAdapterCode = 35;

  private baseUrl = "https://api.merge.dev/api";
  private headers() {
    return {
      Authorization: `Bearer ${process.env.MERGE_ACCESS_TOKEN}`,
      "X-Account-Token": process.env.MERGE_ACCOUNT_TOKEN!,
      "Content-Type": "application/json",
    };
  }

  async sync(_owner: string, _repo: string): Promise<SyncResult> {
    clearAdapter(this.name);
    const start = Date.now();
    let timeToFirstRecordMs = 0;
    const repos: GitHubRepo[] = [];
    const issues: GitHubIssue[] = [];

    // Merge doesn't have a "repos" endpoint — they normalize into Projects
    // We use their ticketing/issues (Tickets) unified model instead
    const ticketsRes = await fetch(`${this.baseUrl}/ticketing/v1/tickets?page_size=90`, {
      headers: this.headers(),
    });

    if (!ticketsRes.ok) {
      const text = await ticketsRes.text();
      throw new Error(`Merge API error: ${ticketsRes.status} ${text}`);
    }

    const ticketsData = await ticketsRes.json() as any;
    const tickets = ticketsData.results ?? [];

    // Map Merge's unified Ticket model → our GitHubIssue shape
    for (const t of tickets) {
      const issue: GitHubIssue = {
        id: t.id,
        number: t.ticket_url?.split("/").pop() ?? 0,
        title: t.name ?? "",
        state: t.status ?? "unknown",
        created_at: t.created_at ?? "",
        body: t.description?.slice(0, 500) ?? null,
      };
      issues.push(issue);
      insertIssue(this.name, issue);

      if (timeToFirstRecordMs === 0) {
        timeToFirstRecordMs = Date.now() - start;
      }
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
