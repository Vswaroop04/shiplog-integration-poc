import { IntegrationAdapter } from "./base";
import { SyncResult, GitHubRepo, GitHubIssue } from "../types";
import { clearAdapter, insertRepo, insertIssue } from "../db";

// Adapter 4: Composio — built for AI agent tool calls, 250+ tools
// Composio manages auth and exposes GitHub as callable actions.
// Unlike Nango's background syncs, Composio is on-demand — great for agents.
export class ComposioAdapter implements IntegrationAdapter {
  name = "Composio";
  linesOfAdapterCode = 30;

  private baseUrl = "https://backend.composio.dev/api/v1";
  private headers() {
    return {
      "x-api-key": process.env.COMPOSIO_API_KEY!,
      "Content-Type": "application/json",
    };
  }

  async sync(owner: string, repo: string): Promise<SyncResult> {
    clearAdapter(this.name);
    const start = Date.now();
    let timeToFirstRecordMs = 0;
    const repos: GitHubRepo[] = [];
    const issues: GitHubIssue[] = [];

    // Composio executes actions on behalf of the connected user
    const repoRes = await fetch(`${this.baseUrl}/actions/execute`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        action: "GITHUB_GET_A_REPOSITORY",
        input: { owner, repo },
        connectedAccountId: process.env.COMPOSIO_CONNECTED_ACCOUNT_ID,
      }),
    });

    if (!repoRes.ok) throw new Error(`Composio error: ${repoRes.status} ${await repoRes.text()}`);
    const repoData = (await repoRes.json() as any)?.response?.data;

    if (repoData) {
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
    }

    // Fetch issues via Composio action
    const issuesRes = await fetch(`${this.baseUrl}/actions/execute`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        action: "GITHUB_LIST_REPOSITORY_ISSUES",
        input: { owner, repo, state: "all", per_page: 90 },
        connectedAccountId: process.env.COMPOSIO_CONNECTED_ACCOUNT_ID,
      }),
    });

    if (issuesRes.ok) {
      const issuesData = (await issuesRes.json() as any)?.response?.data ?? [];
      for (const i of (Array.isArray(issuesData) ? issuesData : [])) {
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
