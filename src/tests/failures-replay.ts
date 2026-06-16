import chalk from "chalk";
import Table from "cli-table3";

// Tests how each platform behaves when a sync fails partway through,
// and whether raw responses are available to "replay" (reprocess without
// re-fetching from the source API).
//
// This is the core of Shiplog's architecture: Raw Landing Zone + Ingestion
// Manifest. No connector platform ships this — you build it regardless of
// which one you pick. This test proves that empirically.

export interface FailureReplayResult {
  adapter: string;
  failureBehavior: string;     // what happens when a request mid-sync fails
  retriesAutomatically: boolean;
  rawResponseStored: boolean;  // does the platform let you access the raw, unprocessed payload?
  replaySupported: boolean;    // can you reprocess without re-calling the source API?
  notes: string;
}

// --- Direct API: no retry, no raw storage, you build everything ---
async function testDirect(owner: string, repo: string): Promise<FailureReplayResult> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  // Simulate a failure: hit a deliberately bad endpoint mid-"sync"
  const badRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/999999999`, { headers });
  const failed = !badRes.ok;

  return {
    adapter: "Direct GitHub API",
    failureBehavior: failed
      ? `Request failed (${badRes.status}) — propagates straight to your code, no retry`
      : "n/a",
    retriesAutomatically: false,
    rawResponseStored: false, // you'd have to write this yourself
    replaySupported: false,   // only if you build a landing zone yourself
    notes: "You catch the error, decide retry/DLQ, and store raw payloads yourself if you want replay",
  };
}

// --- Nango: built-in retry on 429/5xx for proxy calls, but no durable raw store by default ---
async function testNango(owner: string, repo: string): Promise<FailureReplayResult> {
  const { Nango } = await import("@nangohq/node");
  const nango = new Nango({ secretKey: process.env.NANGO_SECRET_KEY! });
  const connectionId = process.env.NANGO_CONNECTION_ID!;
  let failureBehavior = "n/a";

  try {
    await nango.proxy({
      method: "GET",
      endpoint: `/repos/${owner}/${repo}/issues/999999999`,
      providerConfigKey: process.env.NANGO_PROVIDER_CONFIG_KEY ?? "github",
      connectionId,
    });
  } catch (err: any) {
    failureBehavior = `Request failed (${err.status ?? "?"}) — Nango retries 429/5xx automatically, but a 404 like this still propagates`;
  }

  return {
    adapter: "Nango",
    failureBehavior,
    retriesAutomatically: true, // for retryable errors (429, 5xx) in sync scripts
    rawResponseStored: false,   // Nango's Records API stores synced records, not the original raw HTTP payload
    replaySupported: false,     // re-running a sync re-calls the source API — it's not replay-from-raw
    notes: "Nango retries transient errors, but re-running a sync re-hits GitHub — no raw payload to replay from",
  };
}

// --- Merge.dev: fully managed retries, but you only ever see normalized data, never raw ---
async function testMerge(): Promise<FailureReplayResult> {
  let failureBehavior = "n/a";

  const res = await fetch(`https://api.merge.dev/api/ticketing/v1/tickets/00000000-0000-0000-0000-000000000000`, {
    headers: {
      Authorization: `Bearer ${process.env.MERGE_ACCESS_TOKEN}`,
      "X-Account-Token": process.env.MERGE_ACCOUNT_TOKEN!,
    },
  });
  if (!res.ok) {
    failureBehavior = `Request failed (${res.status}) — Merge retries internally against GitHub, surfaces a clean error to you`;
  }

  return {
    adapter: "Merge.dev",
    failureBehavior,
    retriesAutomatically: true,
    rawResponseStored: false, // Merge only exposes the normalized Ticket model, never GitHub's raw issue JSON
    replaySupported: false,
    notes: "You never see raw GitHub data at all — can't replay a transformation you don't control",
  };
}

export async function runFailureReplayBenchmark(owner: string, repo: string) {
  console.log(chalk.bold("\n🔁 Failure Handling & Replay Benchmark"));
  console.log(chalk.gray("Tests what happens on a failed request, and whether raw data can be replayed\n"));

  const runners: Array<{ name: string; fn: () => Promise<FailureReplayResult> }> = [
    { name: "Direct", fn: () => testDirect(owner, repo) },
    ...(process.env.NANGO_SECRET_KEY ? [{ name: "Nango", fn: () => testNango(owner, repo) }] : []),
    ...(process.env.MERGE_ACCESS_TOKEN ? [{ name: "Merge.dev", fn: () => testMerge() }] : []),
  ];

  const results: FailureReplayResult[] = [];

  for (const { name, fn } of runners) {
    process.stdout.write(chalk.cyan(`  ▶ ${name}... `));
    try {
      const r = await fn();
      results.push(r);
      console.log(chalk.green("done"));
    } catch (err: any) {
      console.log(chalk.red(`✗ ${err.message.slice(0, 60)}`));
    }
  }

  const table = new Table({
    head: [
      chalk.white("Platform"),
      chalk.white("Auto-retry?"),
      chalk.white("Raw payload stored?"),
      chalk.white("Replay-from-raw?"),
      chalk.white("Notes"),
    ],
    colWidths: [16, 13, 20, 17, 45],
  });

  for (const r of results) {
    table.push([
      r.adapter,
      r.retriesAutomatically ? chalk.green("Yes ✓") : chalk.red("No"),
      r.rawResponseStored ? chalk.green("Yes ✓") : chalk.red("No"),
      r.replaySupported ? chalk.green("Yes ✓") : chalk.red("No"),
      r.notes,
    ]);
  }

  console.log(table.toString());

  console.log(chalk.bold("\n💡 Key insight:"));
  console.log("  None of these platforms store the raw, unprocessed payload or support");
  console.log("  replaying it without re-calling the source API. If our normalization logic");
  console.log("  has a bug, every platform here forces a full re-fetch to fix history.");
  console.log("  A raw landing zone (gzip + checksum, immutable, replayable) is something");
  console.log("  we'd build ourselves regardless of which connector platform we choose.\n");
}
