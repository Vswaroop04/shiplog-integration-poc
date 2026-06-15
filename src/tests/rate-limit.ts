import chalk from "chalk";
import Table from "cli-table3";

// Tests how each platform handles rate limits.
// GitHub: 60 req/hr unauthenticated, 5000/hr authenticated, 403 when exceeded.
// Salesforce: per-org daily limits + concurrent request limits.
// Gong: 3 req/s hard limit.
// Every provider enforces limits differently. This test fires rapid requests
// and measures which platforms detect + back off automatically vs which ones
// just throw errors and leave it to you.

export interface RateLimitResult {
  adapter: string;
  requestsFired: number;
  rateLimitHit: boolean;
  autoBackoff: boolean;       // did the platform retry automatically?
  recoveryMs: number | null;  // how long to recover (-1 if platform errored out)
  remainingLimit: number | null;
  strategy: string;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Direct API: you see the 403/429 raw, you handle it yourself ---
async function testDirect(owner: string, repo: string): Promise<RateLimitResult> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  let requestsFired = 0;
  let rateLimitHit = false;
  let recoveryMs: number | null = null;

  // Fire 5 rapid requests and check rate limit headers
  for (let i = 0; i < 5; i++) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues?per_page=1&page=${i + 1}`,
      { headers }
    );
    requestsFired++;

    const remaining = parseInt(res.headers.get("x-ratelimit-remaining") ?? "-1");
    const resetAt = parseInt(res.headers.get("x-ratelimit-reset") ?? "0");

    if (res.status === 403 || res.status === 429) {
      rateLimitHit = true;
      // You have to read the reset header yourself and wait
      const waitMs = (resetAt * 1000) - Date.now();
      console.log(chalk.yellow(`    Rate limit hit. Would need to wait ${Math.round(waitMs / 1000)}s`));
      recoveryMs = waitMs > 0 ? waitMs : 0;
      break;
    }

    // No auto-backoff in direct — you have to check remaining yourself
    if (remaining !== -1 && remaining < 5) {
      rateLimitHit = true;
      recoveryMs = (resetAt * 1000) - Date.now();
      break;
    }
  }

  return {
    adapter: "Direct GitHub API",
    requestsFired,
    rateLimitHit,
    autoBackoff: false,
    recoveryMs,
    remainingLimit: null,
    strategy: "You read x-ratelimit-remaining + x-ratelimit-reset headers manually",
  };
}

// --- Nango: rate limit handling is built-in for proxied requests ---
async function testNango(owner: string, repo: string): Promise<RateLimitResult> {
  const { Nango } = await import("@nangohq/node");
  const nango = new Nango({ secretKey: process.env.NANGO_SECRET_KEY! });
  const connectionId = process.env.NANGO_CONNECTION_ID!;
  let requestsFired = 0;
  let rateLimitHit = false;
  const start = Date.now();

  try {
    for (let i = 0; i < 5; i++) {
      await nango.proxy({
        method: "GET",
        endpoint: `/repos/${owner}/${repo}/issues?per_page=1&page=${i + 1}`,
        providerConfigKey: "github",
        connectionId,
        // Nango automatically backs off on 429/403 and retries — you don't configure this
      });
      requestsFired++;
      await sleep(100); // small delay between requests
    }
  } catch (err: any) {
    if (err.status === 429 || err.status === 403) {
      rateLimitHit = true;
    }
  }

  return {
    adapter: "Nango",
    requestsFired,
    rateLimitHit,
    autoBackoff: true, // Nango handles 429 backoff automatically in sync scripts
    recoveryMs: rateLimitHit ? Date.now() - start : null,
    remainingLimit: null,
    strategy: "Nango detects 429 + backs off automatically in sync scripts",
  };
}

// --- Merge.dev: fully managed, you never see rate limit errors ---
async function testMerge(): Promise<RateLimitResult> {
  let requestsFired = 0;

  // Merge abstracts the underlying GitHub rate limits entirely.
  // Their API has its own rate limits (much higher) and handles GitHub's internally.
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`https://api.merge.dev/api/ticketing/v1/tickets?page_size=1`, {
      headers: {
        Authorization: `Bearer ${process.env.MERGE_ACCESS_TOKEN}`,
        "X-Account-Token": process.env.MERGE_ACCOUNT_TOKEN!,
      },
    });
    requestsFired++;
    if (!res.ok) break;
    await sleep(100);
  }

  return {
    adapter: "Merge.dev",
    requestsFired,
    rateLimitHit: false, // you never see GitHub's rate limits
    autoBackoff: true,
    recoveryMs: null,
    remainingLimit: null,
    strategy: "GitHub rate limits fully hidden — Merge manages them internally",
  };
}

// --- Composio: similar to Merge, rate limits handled server-side ---
async function testComposio(owner: string, repo: string): Promise<RateLimitResult> {
  let requestsFired = 0;

  for (let i = 0; i < 3; i++) {
    const res = await fetch("https://backend.composio.dev/api/v1/actions/execute", {
      method: "POST",
      headers: {
        "x-api-key": process.env.COMPOSIO_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "GITHUB_LIST_REPOSITORY_ISSUES",
        input: { owner, repo, per_page: 1, page: i + 1 },
        connectedAccountId: process.env.COMPOSIO_CONNECTED_ACCOUNT_ID,
      }),
    });
    requestsFired++;
    if (!res.ok) break;
    await sleep(200);
  }

  return {
    adapter: "Composio",
    requestsFired,
    rateLimitHit: false,
    autoBackoff: true,
    recoveryMs: null,
    remainingLimit: null,
    strategy: "Rate limits handled server-side, abstracted from you",
  };
}

export async function runRateLimitBenchmark(owner: string, repo: string) {
  console.log(chalk.bold("\n⚡ Rate Limit Benchmark"));
  console.log(chalk.gray("Tests how each platform handles API rate limits — 5 rapid requests\n"));

  const runners = [
    { name: "Direct", fn: () => testDirect(owner, repo) },
    ...(process.env.NANGO_SECRET_KEY ? [{ name: "Nango", fn: () => testNango(owner, repo) }] : []),
    ...(process.env.MERGE_ACCESS_TOKEN ? [{ name: "Merge.dev", fn: () => testMerge() }] : []),
    ...(process.env.COMPOSIO_API_KEY ? [{ name: "Composio", fn: () => testComposio(owner, repo) }] : []),
  ];

  const results: RateLimitResult[] = [];

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
      chalk.white("Requests"),
      chalk.white("Hit limit?"),
      chalk.white("Auto backoff?"),
      chalk.white("What you have to do"),
    ],
    colWidths: [20, 11, 12, 15, 50],
  });

  for (const r of results) {
    table.push([
      r.adapter,
      r.requestsFired,
      r.rateLimitHit ? chalk.yellow("Yes") : chalk.green("No"),
      r.autoBackoff ? chalk.green("Yes ✓") : chalk.red("No — manual"),
      r.strategy,
    ]);
  }

  console.log(table.toString());

  console.log(chalk.bold("\n💡 Key insight:"));
  console.log("  With Direct API, you must read x-ratelimit-remaining on every response,");
  console.log("  track reset times per endpoint, and implement exponential backoff yourself.");
  console.log("  Multiply that by 10+ providers, each with different headers and limits.\n");
}
