import Database from "better-sqlite3";
import path from "path";
import { GitHubRepo, GitHubIssue } from "./types";

const db = new Database(path.join(__dirname, "../benchmark.db"));

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY,
      adapter TEXT NOT NULL,
      name TEXT,
      full_name TEXT,
      description TEXT,
      stars INTEGER,
      language TEXT,
      updated_at TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY,
      adapter TEXT NOT NULL,
      number INTEGER,
      title TEXT,
      state TEXT,
      created_at TEXT,
      body TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

export function clearAdapter(adapter: string) {
  db.prepare("DELETE FROM repos WHERE adapter = ?").run(adapter);
  db.prepare("DELETE FROM issues WHERE adapter = ?").run(adapter);
}

export function insertRepo(adapter: string, repo: GitHubRepo) {
  db.prepare(`
    INSERT OR REPLACE INTO repos (id, adapter, name, full_name, description, stars, language, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(repo.id, adapter, repo.name, repo.full_name, repo.description, repo.stars, repo.language, repo.updated_at);
}

export function insertIssue(adapter: string, issue: GitHubIssue) {
  db.prepare(`
    INSERT OR REPLACE INTO issues (id, adapter, number, title, state, created_at, body)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(issue.id, adapter, issue.number, issue.title, issue.state, issue.created_at, issue.body);
}

export function countRecords(adapter: string): number {
  const r = db.prepare("SELECT COUNT(*) as c FROM repos WHERE adapter = ?").get(adapter) as { c: number };
  const i = db.prepare("SELECT COUNT(*) as c FROM issues WHERE adapter = ?").get(adapter) as { c: number };
  return r.c + i.c;
}

export default db;
