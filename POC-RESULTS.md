# POC Results - Nango vs Ampersand vs alternatives

Quick summary of the actual work, for sharing with the team. Full detail
is in README.md (research notes), CONCEPTS.md (fundamentals), and
ARCHITECTURE.md (per-platform diagrams + the full Ampersand incident
writeup).

## Scope

Started from the assumption we're already on Nango + Inngest, and checked
whether anything else in the integration platform space would actually be
a better fit - not just compared on paper, but built a working POC and
tested the most promising alternative hands-on.

## Candidates checked

| Platform | Verdict | Why |
|---|---|---|
| **Nango** | Baseline (already in production) | - |
| Merge.dev | Ruled out | Normalizes within categories only, never exposes raw provider data, less control |
| Truto | Ruled out | No self-serve signup - sales contact required just to get an account |
| Composio | Ruled out | Built for single-action agent lookups, not bulk historical sync |
| Airbyte / Fivetran | Ruled out | Analytics ELT tools - wrong abstraction for an operational product, adds a warehouse hop |
| Alloy | Ruled out for this problem | Right tool for our existing event-driven Kuehne+Nagel integration, but no incremental-sync primitive - wrong tool for continuous sync |
| **Ampersand** | Tested hands-on | Fundamentally different pitch - bundles sync/retries/backfill instead of giving you building blocks |

## What got built

- Working adapters for Direct API, Nango, Merge.dev, Composio, Airbyte,
  Fivetran, and Ampersand, all running the same GitHub sync
- Cross-platform tests: pagination, rate limits, failure handling +
  replay, incremental sync
- A dedicated claims-verification test specifically for Ampersand's
  marketing claims (sub-second webhooks, auto-retries, backfill)
- Full setup tooling for Ampersand: OAuth connect script, installation
  script, webhook listener, standalone trigger script for latency
  measurement

Repo: github.com/Vswaroop04/shiplog-integration-poc

## What we found testing Nango

Worked cleanly across all 5 tests once configuration was correct
(`providerConfigKey` needs to exactly match the dashboard's Integration
ID - the only real gotcha). ~500ms latency for an issues fetch, real
auto-retry and rate-limit backoff confirmed in testing, not just claimed.

## What we found testing Ampersand

**A real bug, found and fixed.** Their default GitHub OAuth setup
requested invalid scopes (`repos repositories` instead of the real GitHub
scope `repo`). This produces a token with no actual permissions, GitHub
returns 404 instead of an explicit permission error (a deliberate GitHub
API design choice), and Ampersand's retry logic treats that 404 as
retryable and **retries forever** - no circuit breaker, no way to cancel
from the dashboard or API. Reproduced this on two separate fresh
installations before finding the root cause.

After fixing the scope in their dashboard and redoing the OAuth flow:

- Backfill worked correctly, delivered all test records
- **Measured real end-to-end latency: ~2.8 seconds** (trigger → their
  internal processing ~2.07s → webhook delivery via Svix ~750ms more).
  Not sub-second as marketed, but a real number now, not a guess
- Genuine plus: the webhook payload includes the complete raw provider
  response alongside normalized fields - something Merge.dev never gives
  you under any circumstance

## The core architectural difference (the actual deciding factor)

Nango's proxy is one synchronous call - you get the answer in the same
request. Ampersand is three separate, time-displaced hops: trigger
(instant) → poll for status (~2s) → webhook delivery (~750ms more, on a
totally different code path than the original call).

That async gap is the real reason this doesn't fit our use case, more
than the bug:

1. **Live agent tool calls need a synchronous answer in the same turn.**
   Ampersand's model can't naturally do that without bolting on its own
   polling/waiting logic.
2. **It doesn't actually reduce our infrastructure.** We already run
   Inngest for orchestration across the whole product. Adopting
   Ampersand's bundled retries/backfill wouldn't remove that - it would
   just add a second async layer running alongside it.

## Recommendation

Keep Nango + Inngest. It already fits both the continuous-sync need and
the live-agent need, has the broadest connector catalog (60+ live, 400+
available - a real GTM lever when a new customer needs a provider we
haven't built yet), and is already proven in production. Ampersand is the
most credible alternative found in this research, and worth knowing
about, but not a reason to re-platform.
