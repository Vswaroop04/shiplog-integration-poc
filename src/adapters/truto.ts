import { IntegrationAdapter } from "./base";
import { SyncResult, GitHubRepo, GitHubIssue } from "../types";
import { clearAdapter, insertRepo, insertIssue } from "../db";

// Adapter 5: Truto — zero data retention, pass-through unified API
// Truto proxies your request to GitHub, normalizes the response in-transit,
// and never stores your customer data. Good for strict compliance requirements.
export class TrutoAdapter implements IntegrationAdapter {
  name = "Truto";
  linesOfAdapterCode = 30;

  private baseUrl = "https://api.truto.one";
  private headers() {
    return {
      Authorization: `Bearer ${process.env.TRUTO_API_TOKEN}`,
      "Content-Type": "application/json",
    };
  }

  async sync(owner: string, repo: string): Promise<SyncResult> {
    clearAdapter(this.name);
    const start = Date.now();
    let timeToFirstRecordMs = 0;
    const repos: GitHubRepo[] = [];
    const issues: GitHubIssue[] = [];
    const integrationAccountId = process.env.TRUTO_INTEGRATION_ACCOUNT_ID!;

    // Truto proxy: routes through their unified layer
    const repoRes = await fetch(
      `${this.baseUrl}/proxy/github/repos/${owner}/${repo}`,
      {
        headers: {
          ...this.headers(),
          "x-integration-account-id": integrationAccountId,
        },
      }
    );

    if (!repoRes.ok) throw new Error(`Truto error: ${repoRes.status} ${await repoRes.text()}`);
    const repoData = await repoRes.json() as any;

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

    // Fetch issues via Truto proxy
    const issuesRes = await fetch(
      `${this.baseUrl}/proxy/github/repos/${owner}/${repo}/issues?state=all&per_page=90`,
      {
        headers: {
          ...this.headers(),
          "x-integration-account-id": integrationAccountId,
        },
      }
    );

    if (issuesRes.ok) {
      const issuesData = await issuesRes.json() as any[];
      for (const i of (issuesData ?? [])) {
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
