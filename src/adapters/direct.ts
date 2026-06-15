import { IntegrationAdapter } from "./base";
import { SyncResult, GitHubRepo, GitHubIssue } from "../types";
import { clearAdapter, insertRepo, insertIssue } from "../db";

// Adapter 1: Raw GitHub API — no platform, just fetch()
// This is the baseline that shows what the platforms are abstracting away.
export class DirectAdapter implements IntegrationAdapter {
  name = "Direct GitHub API";
  linesOfAdapterCode = 40;

  private headers() {
    const token = process.env.GITHUB_TOKEN;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async sync(owner: string, repo: string): Promise<SyncResult> {
    clearAdapter(this.name);
    const start = Date.now();
    let timeToFirstRecordMs = 0;
    const repos: GitHubRepo[] = [];
    const issues: GitHubIssue[] = [];

    // Fetch repo info
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: this.headers() });
    if (!repoRes.ok) throw new Error(`GitHub API error: ${repoRes.status} ${await repoRes.text()}`);
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

    // Fetch issues (up to 3 pages of 30)
    for (let page = 1; page <= 3; page++) {
      const issuesRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=30&page=${page}`,
        { headers: this.headers() }
      );
      if (!issuesRes.ok) break;
      const issuesData = await issuesRes.json() as any[];
      if (!issuesData.length) break;

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
