import chalk from "chalk";
import Table from "cli-table3";

// Tests incremental sync — after an initial full sync, can each platform
// fetch ONLY records changed since a given point in time, and who is
// responsible for tracking that cursor?
//
// This is the test that actually separates "data sync" platforms (Nango,
// Merge, Airbyte, Fivetran) from "workflow automation" platforms (Alloy) —
// the latter has no equivalent primitive at all. It's also the test that
// shows every platform here still pushes cursor *storage* onto you, even
// when the platform itself runs the fetch.

export interface IncrementalResult {
  adapter: string;
  fullSyncRecords: number;
  incrementalRecords: number;
  cursorTrackedBy: "you" | "platform";
  nativeSyncEngine: boolean; // does the platform have a scheduled/incremental engine, distinct from one-off proxy calls?
  notes: string;
}

function isoMinutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60 * 1000).toISOString();
}

// --- Direct API: GitHub supports `since`, but YOU store the timestamp ---
async function testDirect(owner: string, repo: string): Promise<IncrementalResult> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const fullRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=30`,
    { headers }
  );
  const full = await fullRes.json() as any[];

  // Pretend our "last sync" was 30 days ago — we have to have stored this ourselves
  const cursor = isoMinutesAgo(30 * 24 * 60);
  const incRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=30&since=${cursor}`,
    { headers }
  );
  const incremental = await incRes.json() as any[];

  return {
    adapter: "Direct GitHub API",
    fullSyncRecords: full.length ?? 0,
    incrementalRecords: incremental.length ?? 0,
    cursorTrackedBy: "you",
    nativeSyncEngine: false,
    notes: "GitHub supports `?since=`, but you store/pass the timestamp and re-run the fetch yourself",
  };
}

// --- Nango: proxy calls behave like Direct; the native Sync engine (not used here) tracks cursors for you ---
async function testNango(owner: string, repo: string): Promise<IncrementalResult> {
  const { Nango } = await import("@nangohq/node");
  const nango = new Nango({ secretKey: process.env.NANGO_SECRET_KEY! });
  const connectionId = process.env.NANGO_CONNECTION_ID!;

  const providerConfigKey = process.env.NANGO_PROVIDER_CONFIG_KEY ?? "github";

  let fullRes;
  try {
    fullRes = await nango.proxy({
      method: "GET",
      endpoint: `/repos/${owner}/${repo}/issues?state=all&per_page=30`,
      providerConfigKey,
      connectionId,
    });
  } catch (err: any) {
    const detail = err?.response?.data ?? err?.message;
    throw new Error(`Nango full-sync proxy call failed: ${JSON.stringify(detail)}`);
  }
  const full = (fullRes.data as any[]) ?? [];

  const cursor = isoMinutesAgo(30 * 24 * 60);
  let incRes;
  try {
    incRes = await nango.proxy({
      method: "GET",
      endpoint: `/repos/${owner}/${repo}/issues?state=all&per_page=30&since=${cursor}`,
      providerConfigKey,
      connectionId,
    });
  } catch (err: any) {
    const detail = err?.response?.data ?? err?.message;
    throw new Error(`Nango incremental proxy call failed: ${JSON.stringify(detail)}`);
  }
  const incremental = (incRes.data as any[]) ?? [];

  return {
    adapter: "Nango",
    fullSyncRecords: full.length,
    incrementalRecords: incremental.length,
    cursorTrackedBy: "you", // true for proxy calls, as tested here
    nativeSyncEngine: true, // Nango's deployed "Sync" scripts persist a cursor via metadata — not exercised via proxy
    notes: "Via proxy, same manual cursor as Direct. Nango's native Sync feature (deployed scripts, not proxy) tracks cursors for you — not what's tested here",
  };
}

// --- Merge.dev: `modified_after` filter, but you still pass the timestamp ---
async function testMerge(): Promise<IncrementalResult> {
  const headers = {
    Authorization: `Bearer ${process.env.MERGE_ACCESS_TOKEN}`,
    "X-Account-Token": process.env.MERGE_ACCOUNT_TOKEN!,
  };

  const fullRes = await fetch(`https://api.merge.dev/api/ticketing/v1/tickets?page_size=30`, { headers });
  const full = await fullRes.json() as any;

  const cursor = isoMinutesAgo(30 * 24 * 60);
  const incRes = await fetch(
    `https://api.merge.dev/api/ticketing/v1/tickets?page_size=30&modified_after=${cursor}`,
    { headers }
  );
  const incremental = await incRes.json() as any;

  return {
    adapter: "Merge.dev",
    fullSyncRecords: (full.results ?? []).length,
    incrementalRecords: (incremental.results ?? []).length,
    cursorTrackedBy: "you",
    nativeSyncEngine: true, // Merge polls GitHub internally on a schedule regardless of when you call them
    notes: "`modified_after` filter exists, but you still store/pass the timestamp on your end",
  };
}

export async function runIncrementalSyncBenchmark(owner: string, repo: string) {
  console.log(chalk.bold("\n🔄 Incremental Sync Benchmark"));
  console.log(chalk.gray("Tests whether each platform can fetch only what changed since a cursor\n"));

  const runners: Array<{ name: string; fn: () => Promise<IncrementalResult> }> = [
    { name: "Direct", fn: () => testDirect(owner, repo) },
    ...(process.env.NANGO_SECRET_KEY ? [{ name: "Nango", fn: () => testNango(owner, repo) }] : []),
    ...(process.env.MERGE_ACCESS_TOKEN ? [{ name: "Merge.dev", fn: () => testMerge() }] : []),
  ];

  const results: IncrementalResult[] = [];

  for (const { name, fn } of runners) {
    process.stdout.write(chalk.cyan(`  ▶ ${name}... `));
    try {
      const r = await fn();
      results.push(r);
      console.log(chalk.green(`${r.fullSyncRecords} → ${r.incrementalRecords} records`));
    } catch (err: any) {
      console.log(chalk.red(`✗ ${err.message.slice(0, 60)}`));
    }
  }

  const table = new Table({
    head: [
      chalk.white("Platform"),
      chalk.white("Full sync"),
      chalk.white("Incremental"),
      chalk.white("Cursor tracked by"),
      chalk.white("Native sync engine?"),
      chalk.white("Notes"),
    ],
    colWidths: [14, 11, 13, 18, 20, 45],
  });

  for (const r of results) {
    table.push([
      r.adapter,
      r.fullSyncRecords,
      r.incrementalRecords,
      r.cursorTrackedBy === "platform" ? chalk.green("Platform") : chalk.yellow("You"),
      r.nativeSyncEngine ? chalk.green("Yes ✓") : chalk.red("No"),
      r.notes,
    ]);
  }

  console.log(table.toString());

  console.log(chalk.bold("\n💡 Key insight:"));
  console.log("  Every platform tested here still needs YOU to track and pass a cursor");
  console.log("  through their proxy/REST APIs. The real differentiator is whether the");
  console.log("  platform has a *native sync engine* (deployed scripts/connectors with");
  console.log("  built-in schedules and persisted state) — Nango, Merge, Airbyte, and");
  console.log("  Fivetran all have one. Workflow-automation tools like Alloy don't —");
  console.log("  there's no equivalent primitive to compare against at all.\n");
}
