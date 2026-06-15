export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  stars: number;
  language: string | null;
  updated_at: string;
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  state: string;
  created_at: string;
  body: string | null;
}

export interface SyncResult {
  adapter: string;
  provider: string;
  repos: GitHubRepo[];
  issues: GitHubIssue[];
  timeToFirstRecordMs: number;
  totalSyncMs: number;
  recordCount: number;
  linesOfAdapterCode: number;
  error?: string;
}

export interface BenchmarkReport {
  adapter: string;
  firstRecord: string;
  totalSync: string;
  records: number;
  loc: number;
  status: string;
}
