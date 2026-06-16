import "dotenv/config";
import { initDb } from "./db";
import { DirectAdapter } from "./adapters/direct";
import { NangoAdapter } from "./adapters/nango";
import { MergeAdapter } from "./adapters/merge";
import { ComposioAdapter } from "./adapters/composio";
import { TrutoAdapter } from "./adapters/truto";
import { AirbyteAdapter } from "./adapters/airbyte";
import { FivetranAdapter } from "./adapters/fivetran";
import { runAdapter, printReport } from "./runner";
import { runPaginationBenchmark } from "./tests/pagination";
import { runRateLimitBenchmark } from "./tests/rate-limit";
import { runFailureReplayBenchmark } from "./tests/failures-replay";
import { runIncrementalSyncBenchmark } from "./tests/incremental";
import { IntegrationAdapter } from "./adapters/base";
import chalk from "chalk";

// Which repo to benchmark against (public = no token needed for Direct adapter)
const OWNER = process.env.GITHUB_OWNER ?? "torvalds";
const REPO = process.env.GITHUB_REPO ?? "linux";

async function main() {
  initDb();

  console.log(chalk.bold(`\n🔬 Integration Benchmark — github.com/${OWNER}/${REPO}`));
  console.log(chalk.gray("Platforms: Direct API, Nango, Merge.dev, Composio, Truto, Airbyte, Fivetran\n"));

  // Each adapter is only included if its required env vars are present.
  // Run `npm run benchmark` to run all configured platforms.
  const adapters: IntegrationAdapter[] = [
    new DirectAdapter(),
    ...(process.env.NANGO_SECRET_KEY && process.env.NANGO_CONNECTION_ID ? [new NangoAdapter()] : []),
    ...(process.env.MERGE_ACCESS_TOKEN && process.env.MERGE_ACCOUNT_TOKEN ? [new MergeAdapter()] : []),
    ...(process.env.COMPOSIO_API_KEY && process.env.COMPOSIO_CONNECTED_ACCOUNT_ID ? [new ComposioAdapter()] : []),
    ...(process.env.TRUTO_API_TOKEN && process.env.TRUTO_INTEGRATION_ACCOUNT_ID ? [new TrutoAdapter()] : []),
    ...(process.env.AIRBYTE_API_TOKEN && process.env.AIRBYTE_CONNECTION_ID ? [new AirbyteAdapter()] : []),
    ...(process.env.FIVETRAN_API_KEY && process.env.FIVETRAN_CONNECTOR_ID ? [new FivetranAdapter()] : []),
  ];

  const skipped = 7 - adapters.length;
  if (skipped > 0) {
    console.log(chalk.yellow(`⚠ ${skipped} platform(s) skipped — missing env vars (see .env.example)\n`));
  }

  const results = await Promise.allSettled(
    adapters.map(a => runAdapter(a, OWNER, REPO))
  );

  const settled = results.map(r => r.status === "fulfilled" ? r.value : null);
  printReport(settled);

  await runPaginationBenchmark(OWNER, REPO);
  await runRateLimitBenchmark(OWNER, REPO);
  await runFailureReplayBenchmark(OWNER, REPO);
  await runIncrementalSyncBenchmark(OWNER, REPO);
}

main().catch(err => {
  console.error(chalk.red("Fatal:"), err);
  process.exit(1);
});
