import http from "http";
import { IntegrationAdapter } from "./base";
import { SyncResult, GitHubRepo, GitHubIssue } from "../types";
import { clearAdapter, insertIssue } from "../db";

// Adapter 8: Ampersand — claims to ship the orchestration layer Nango leaves
// to you (retries, rate-limit backoff, backfills) built in. Worth testing
// because it directly challenges the "Nango + Inngest" conclusion from the
// rest of this benchmark.
//
// Architecturally it's push-based, not pull: you POST a "trigger read" call,
// Ampersand fetches from the provider on your behalf, then delivers records
// to a webhook destination configured ahead of time in your amp.yaml
// manifest (via their dashboard) — not returned from the trigger call
// itself. So this adapter spins up a local HTTP listener; for it to
// actually receive anything, that listener's public URL (e.g. via ngrok)
// has to already be registered as the destination in your Ampersand
// project. Same category of setup cost as Airbyte/Fivetran's destination
// requirement.
export class AmpersandAdapter implements IntegrationAdapter {
  name = "Ampersand";
  linesOfAdapterCode = 75;

  private apiKey = process.env.AMPERSAND_API_KEY!;
  private projectId = process.env.AMPERSAND_PROJECT_ID!;
  private integrationId = process.env.AMPERSAND_INTEGRATION_ID!;
  private groupRef = process.env.AMPERSAND_GROUP_REF!;
  private webhookPort = Number(process.env.AMPERSAND_WEBHOOK_PORT ?? 4242);

  async sync(_owner: string, _repo: string): Promise<SyncResult> {
    clearAdapter(this.name);
    const start = Date.now();
    let timeToFirstRecordMs = 0;
    const repos: GitHubRepo[] = [];
    const issues: GitHubIssue[] = [];
    const received: any[] = [];

    // Local webhook receiver — must be tunneled (ngrok) and registered as
    // the destination in the Ampersand dashboard before this will work.
    let firstRecordSeen: () => void;
    const firstRecord = new Promise<void>(resolve => { firstRecordSeen = resolve; });
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", () => {
        try {
          const payload = JSON.parse(body);
          const records = payload.records ?? payload.data ?? [];
          received.push(...records);
          if (timeToFirstRecordMs === 0 && records.length) {
            timeToFirstRecordMs = Date.now() - start;
            firstRecordSeen();
          }
        } catch {
          // ignore malformed/unrelated payloads
        }
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise<void>(resolve => server.listen(this.webhookPort, resolve));

    try {
      // Trigger the read — async, no records in this response
      const triggerRes = await fetch(
        `https://read.withampersand.com/v1/projects/${this.projectId}/integrations/${this.integrationId}/objects/issues`,
        {
          method: "POST",
          headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ groupRef: this.groupRef, mode: "async" }),
        }
      );
      if (!triggerRes.ok) {
        throw new Error(`Ampersand trigger-read failed: ${triggerRes.status} ${await triggerRes.text()}`);
      }
      const { operationId } = await triggerRes.json() as any;

      // Poll operation status — separate from the webhook delivery itself
      let status = "in_progress";
      let attempts = 0;
      while (status === "in_progress" && attempts < 30) {
        await new Promise(r => setTimeout(r, 3000));
        const opRes = await fetch(
          `https://api.withampersand.com/v1/projects/${this.projectId}/operations/${operationId}`,
          { headers: { "X-Api-Key": this.apiKey } }
        );
        const op = await opRes.json() as any;
        status = op.status;
        attempts++;
      }
      if (status !== "success") {
        throw new Error(`Ampersand read did not complete successfully (status: ${status})`);
      }

      // Give the webhook a few seconds to actually arrive after "success"
      await Promise.race([firstRecord, new Promise(r => setTimeout(r, 8000))]);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }

    for (const r of received) {
      const issue: GitHubIssue = {
        id: r.id,
        number: r.number ?? 0,
        title: r.title ?? "",
        state: r.state ?? "unknown",
        created_at: r.created_at ?? "",
        body: r.body?.slice?.(0, 500) ?? null,
      };
      issues.push(issue);
      insertIssue(this.name, issue);
    }

    return {
      adapter: this.name,
      provider: "github",
      repos,
      issues,
      timeToFirstRecordMs,
      totalSyncMs: Date.now() - start,
      recordCount: issues.length,
      linesOfAdapterCode: this.linesOfAdapterCode,
    };
  }
}
