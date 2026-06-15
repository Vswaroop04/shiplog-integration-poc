import chalk from "chalk";
import Table from "cli-table3";

// Tests how each platform handles pagination.
// GitHub uses Link headers — the "next" URL is in the response header, not the body.
// Every provider does this differently. This test shows how much of that
// complexity each platform hides from you.

export interface PaginationResult {
  adapter: string;
  pagesNeeded: number;
  totalRecords: number;
  totalMs: number;
  handledAutomatically: boolean; // did the platform abstract pagination away?
  codeRequired: string;          // what you had to write
}

function parseLinkHeader(header: string): { next?: string; last?: string } {
  const links: Record<string, string> = {};
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

// --- Direct API: you handle Link headers yourself ---
async function testDirect(owner: string, repo: string): Promise<PaginationResult> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const start = Date.now();
  let page = 1;
  let totalRecords = 0;
  let pagesNeeded = 0;
  let nextUrl: string | undefined = `https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=30`;

  // You have to write this loop yourself, parse Link headers, stop when no "next"
  while (nextUrl) {
    const res = await fetch(nextUrl, { headers });
    const data = await res.json() as any[];
    totalRecords += data.length;
    pagesNeeded++;

    const linkHeader = res.headers.get("link") ?? "";
    const { next } = parseLinkHeader(linkHeader);
    nextUrl = next;

    if (page++ >= 3) break; // cap at 3 pages for benchmark speed
  }

  return {
    adapter: "Direct GitHub API",
    pagesNeeded,
    totalRecords,
    totalMs: Date.now() - start,
    handledAutomatically: false,
    codeRequired: "Parse Link header, build loop, track nextUrl manually",
  };
}

// --- Nango: you still write pagination in your sync script, but Nango runs it ---
async function testNango(owner: string, repo: string): Promise<PaginationResult> {
  const { Nango } = await import("@nangohq/node");
  const nango = new Nango({ secretKey: process.env.NANGO_SECRET_KEY! });
  const connectionId = process.env.NANGO_CONNECTION_ID!;
  const start = Date.now();
  let totalRecords = 0;
  let pagesNeeded = 0;

  // In a real Nango sync script you'd call nango.paginate() which handles Link headers.
  // Here we simulate what that script does via the proxy.
  for (let page = 1; page <= 3; page++) {
    const res = await nango.proxy({
      method: "GET",
      endpoint: `/repos/${owner}/${repo}/issues?state=all&per_page=30&page=${page}`,
      providerConfigKey: "github",
      connectionId,
    });
    const data = res.data as any[];
    if (!data?.length) break;
    totalRecords += data.length;
    pagesNeeded++;
  }

  return {
    adapter: "Nango",
    pagesNeeded,
    totalRecords,
    totalMs: Date.now() - start,
    handledAutomatically: false,
    codeRequired: "Use nango.paginate() in sync script — Nango runs it, but you write the loop",
  };
}

// --- Merge.dev: pagination fully abstracted, you just call /tickets and follow cursor ---
async function testMerge(): Promise<PaginationResult> {
  const start = Date.now();
  let totalRecords = 0;
  let pagesNeeded = 0;
  let nextCursor: string | undefined = undefined;

  // Merge returns a cursor you just pass back — no Link headers to parse
  do {
    const url = `https://api.merge.dev/api/ticketing/v1/tickets?page_size=30${nextCursor ? `&cursor=${nextCursor}` : ""}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.MERGE_ACCESS_TOKEN}`,
        "X-Account-Token": process.env.MERGE_ACCOUNT_TOKEN!,
      },
    });
    if (!res.ok) break;
    const data = await res.json() as any;
    totalRecords += (data.results ?? []).length;
    nextCursor = data.next ? new URL(data.next).searchParams.get("cursor") ?? undefined : undefined;
    pagesNeeded++;
    if (pagesNeeded >= 3) break;
  } while (nextCursor);

  return {
    adapter: "Merge.dev",
    pagesNeeded,
    totalRecords,
    totalMs: Date.now() - start,
    handledAutomatically: true,
    codeRequired: "Just follow data.next cursor — no Link headers",
  };
}

// --- Truto: pass-through proxy, GitHub Link headers come through as-is ---
async function testTruto(owner: string, repo: string): Promise<PaginationResult> {
  const start = Date.now();
  let totalRecords = 0;
  let pagesNeeded = 0;
  let nextUrl: string | undefined =
    `https://api.truto.one/proxy/github/repos/${owner}/${repo}/issues?state=all&per_page=30`;

  // Truto passes GitHub's Link headers straight through — same problem as direct
  while (nextUrl && pagesNeeded < 3) {
    const res = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${process.env.TRUTO_API_TOKEN}`,
        "x-integration-account-id": process.env.TRUTO_INTEGRATION_ACCOUNT_ID!,
      },
    });
    if (!res.ok) break;
    const data = await res.json() as any[];
    totalRecords += data.length;
    pagesNeeded++;

    const linkHeader = res.headers.get("link") ?? "";
    const { next } = parseLinkHeader(linkHeader);
    nextUrl = next;
  }

  return {
    adapter: "Truto",
    pagesNeeded,
    totalRecords,
    totalMs: Date.now() - start,
    handledAutomatically: false,
    codeRequired: "Same as direct — Link headers pass through, you parse them",
  };
}

export async function runPaginationBenchmark(owner: string, repo: string) {
  console.log(chalk.bold("\n📄 Pagination Benchmark"));
  console.log(chalk.gray("Tests how much pagination complexity each platform hides from you\n"));

  const runners: Array<{ name: string; fn: () => Promise<PaginationResult> }> = [
    { name: "Direct", fn: () => testDirect(owner, repo) },
    ...(process.env.NANGO_SECRET_KEY ? [{ name: "Nango", fn: () => testNango(owner, repo) }] : []),
    ...(process.env.MERGE_ACCESS_TOKEN ? [{ name: "Merge.dev", fn: () => testMerge() }] : []),
    ...(process.env.TRUTO_API_TOKEN ? [{ name: "Truto", fn: () => testTruto(owner, repo) }] : []),
  ];

  const results: PaginationResult[] = [];

  for (const { name, fn } of runners) {
    process.stdout.write(chalk.cyan(`  ▶ ${name}... `));
    try {
      const r = await fn();
      results.push(r);
      console.log(chalk.green(`${r.totalRecords} records in ${r.totalMs}ms`));
    } catch (err: any) {
      console.log(chalk.red(`✗ ${err.message.slice(0, 60)}`));
    }
  }

  const table = new Table({
    head: [
      chalk.white("Platform"),
      chalk.white("Pages"),
      chalk.white("Records"),
      chalk.white("Time"),
      chalk.white("Auto pagination?"),
      chalk.white("What you write"),
    ],
    colWidths: [20, 8, 10, 8, 17, 45],
  });

  for (const r of results) {
    table.push([
      r.adapter,
      r.pagesNeeded,
      r.totalRecords,
      `${r.totalMs}ms`,
      r.handledAutomatically ? chalk.green("Yes ✓") : chalk.yellow("No — manual"),
      r.codeRequired,
    ]);
  }

  console.log(table.toString());
}
