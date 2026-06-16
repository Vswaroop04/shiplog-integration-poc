import { Nango } from "@nangohq/node";
import { IntegrationAdapter } from "./base";
import { SyncResult, GitHubRepo, GitHubIssue } from "../types";
import { clearAdapter, insertRepo, insertIssue } from "../db";

// Adapter 2: Nango — code-first, handles OAuth + pagination + retries
// Nango runs syncs on their infra. Here we trigger a proxy call via their SDK.
// In production you'd write a sync script that Nango executes on a schedule.
export class NangoAdapter implements IntegrationAdapter {
  name = "Nango";
  linesOfAdapterCode = 55;

  private nango: Nango;

  constructor() {
    this.nango = new Nango({ secretKey: process.env.NANGO_SECRET_KEY! });
  }

  async sync(owner: string, repo: string): Promise<SyncResult> {
    clearAdapter(this.name);
    const start = Date.now();
    let timeToFirstRecordMs = 0;
    const repos: GitHubRepo[] = [];
    const issues: GitHubIssue[] = [];
    const connectionId = process.env.NANGO_CONNECTION_ID!;

    // Nango proxy: authenticated request through Nango's managed OAuth.
    // providerConfigKey must exactly match the Integration ID shown in the
    // Nango dashboard for this GitHub integration - a mismatch here is the
    // most common cause of a 404 from this call.
    const providerConfigKey = process.env.NANGO_PROVIDER_CONFIG_KEY ?? "github";
    let repoRes;
    try {
      repoRes = await this.nango.proxy({
        method: "GET",
        endpoint: `/repos/${owner}/${repo}`,
        providerConfigKey,
        connectionId,
      });
    } catch (err: any) {
      const detail = err?.response?.data ?? err?.message;
      throw new Error(`Nango proxy failed (providerConfigKey="${providerConfigKey}", connectionId="${connectionId}"): ${JSON.stringify(detail)}`);
    }
    const repoData = repoRes.data as any;

    const r: GitHubRepo = {
      id: repoData.id,
      name: repoData.name,
      full_name: repoData.full_name,
      description: repoData.description,
      stars: repoData.stargazers_count,
      language: repoData.language,
      updated_at: repoData.updated_at,
    };
    repos.push(r);
    insertRepo(this.name, r);
    timeToFirstRecordMs = Date.now() - start;

    // Fetch issues via Nango proxy (Nango handles rate limits + retries)
    for (let page = 1; page <= 3; page++) {
      const issuesRes = await this.nango.proxy({
        method: "GET",
        endpoint: `/repos/${owner}/${repo}/issues?state=all&per_page=30&page=${page}`,
        providerConfigKey: "github",
        connectionId,
      });
      const issuesData = issuesRes.data as any[];
      if (!issuesData?.length) break;

      for (const i of issuesData) {
        const issue: GitHubIssue = {
          id: i.id,
          number: i.number,
          title: i.title,
          state: i.state,
          created_at: i.created_at,
          body: i.body?.slice(0, 500) ?? null,
        };
        issues.push(issue);
        insertIssue(this.name, issue);
      }
    }

    return {
      adapter: this.name,
      provider: "github",
      repos,
      issues,
      timeToFirstRecordMs,
      totalSyncMs: Date.now() - start,
      recordCount: repos.length + issues.length,
      linesOfAdapterCode: this.linesOfAdapterCode,
    };
  }
}
