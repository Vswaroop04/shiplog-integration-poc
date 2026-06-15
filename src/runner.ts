import Table from "cli-table3";
import chalk from "chalk";
import { IntegrationAdapter } from "./adapters/base";
import { SyncResult } from "./types";

export async function runAdapter(
  adapter: IntegrationAdapter,
  owner: string,
  repo: string
): Promise<SyncResult | null> {
  console.log(chalk.cyan(`\n▶ Running: ${adapter.name}`));
  try {
    const result = await adapter.sync(owner, repo);
    console.log(chalk.green(`  ✓ ${result.recordCount} records in ${result.totalSyncMs}ms`));
    return result;
  } catch (err: any) {
    console.log(chalk.red(`  ✗ Failed: ${err.message}`));
    return {
      adapter: adapter.name,
      provider: "github",
      repos: [],
      issues: [],
      timeToFirstRecordMs: -1,
      totalSyncMs: -1,
      recordCount: 0,
      linesOfAdapterCode: adapter.linesOfAdapterCode,
      error: err.message,
    };
  }
}

export function printReport(results: (SyncResult | null)[]) {
  const table = new Table({
    head: [
      chalk.white("Platform"),
      chalk.white("First Record"),
      chalk.white("Total Sync"),
      chalk.white("Records"),
      chalk.white("LOC"),
      chalk.white("Data Stored?"),
      chalk.white("Status"),
    ],
    colWidths: [22, 15, 13, 10, 7, 14, 20],
  });

  // LOC = lines of adapter code. Lower = less work for you.
  const dataStoredMap: Record<string, string> = {
    "Direct GitHub API": "No (you own it)",
    "Nango": "Yes (their infra)",
    "Merge.dev": "Yes (their infra)",
    "Composio": "Yes (their infra)",
    "Truto": chalk.green("No (pass-through)"),
  };

  for (const r of results) {
    if (!r) continue;
    const ok = !r.error;
    table.push([
      r.adapter,
      ok ? `${r.timeToFirstRecordMs}ms` : chalk.red("N/A"),
      ok ? `${r.totalSyncMs}ms` : chalk.red("N/A"),
      ok ? r.recordCount : chalk.red("0"),
      r.linesOfAdapterCode,
      dataStoredMap[r.adapter] ?? "Unknown",
      ok ? chalk.green("✓ Success") : chalk.red(`✗ ${r.error?.slice(0, 30)}`),
    ]);
  }

  console.log("\n");
  console.log(chalk.bold("=== Benchmark Results ==="));
  console.log(table.toString());

  // Summary insights
  const successful = results.filter(r => r && !r.error) as SyncResult[];
  if (successful.length > 1) {
    const fastest = successful.reduce((a, b) => a.totalSyncMs < b.totalSyncMs ? a : b);
    const mostRecords = successful.reduce((a, b) => a.recordCount > b.recordCount ? a : b);
    const leastCode = successful.reduce((a, b) => a.linesOfAdapterCode < b.linesOfAdapterCode ? a : b);

    console.log(chalk.bold("\n💡 Insights:"));
    console.log(`  Fastest sync:     ${chalk.green(fastest.adapter)} (${fastest.totalSyncMs}ms)`);
    console.log(`  Most records:     ${chalk.green(mostRecords.adapter)} (${mostRecords.recordCount})`);
    console.log(`  Least code:       ${chalk.green(leastCode.adapter)} (${leastCode.linesOfAdapterCode} LOC)`);
  }
}
