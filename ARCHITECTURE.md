# Architecture - how each platform actually moves data, and what to build around it

This is the missing piece between CONCEPTS.md (the fundamentals) and README.md
(findings) - one diagram per platform, what's automatic vs what you build, and
at the end, the unified picture: if I were building the Integration layer for
something like Shiplog, here's where each piece would sit.

## Requirements first (the actual brief, regardless of platform)

### Functional

- Connect to N different providers, each with a different auth mechanism
  (delegated OAuth, client_credentials, plain API keys)
- Pull full history once (backfill), then keep pulling only what changed
  (incremental sync) - except for the providers that push to us instead
- Normalize wildly different response shapes into one internal model
- Resolve the same real-world entity across sources (a Jira ticket and a
  Salesforce deal about the same account)
- Land everything somewhere queryable for graph construction + LLM retrieval

### Non-functional

- **Reliability** - idempotent processing (re-running a sync twice
  shouldn't double-insert), retries with backoff, a DLQ for things that
  keep failing instead of silently dropping them
- **Replayability** - if the normalization code has a bug, fix it and
  reprocess without re-hitting a rate-limited source API
- **Per-tenant isolation** - one customer's broken/slow sync can't block
  or slow down everyone else's
- **Rate-limit compliance** - per provider, without hand-writing
  header-parsing for every single one if avoidable
- **Auditability** - an immutable, checksum-verified raw archive (useful
  for compliance asks and for debugging "what did the provider actually
  send us on March 3rd")
- **Latency tiering** - most ingestion can be eventually-consistent (a few
  seconds/minutes of lag is fine), but a live agent tool call needs a
  synchronous answer in the same request
- **Extensibility** - adding a new provider should be near-zero-cost if
  it's already in a connector catalog somewhere

## 1. Nango

Pull-based. Either you call their proxy directly (sync, request/response),
or you deploy a "Sync" script that Nango runs on a schedule and caches
results in their Records API, which you then pull from whenever you want.

```
GitHub/Salesforce/etc (60+ live, 400+ available)
        ▲
        │ polls on schedule (Sync) or on-demand (proxy)
        │
┌────────────────────────────────────────┐
│                 NANGO                    │
│  - OAuth vault, auto-refreshes tokens     │
│  - Sync engine - cursor persisted per     │
│    connection, IF you use deployed syncs  │
│  - Records API - cache of synced records  │
└────────────────────────────────────────┘
        │ webhook: "sync completed"     │ proxy: direct request/response
        ▼                                ▼
┌──────────────┐                ┌─────────────────┐
│ your handler  │ ─────────────► │ your app, sync   │
└──────────────┘                └─────────────────┘
        │
        ▼
[Raw Landing Zone] (custom, you build it - Nango's cache isn't a permanent
 immutable archive) → [Ingestion Manifest] (custom)
```

Custom logic/DB needed from day one: raw storage, ingestion manifest. Nango
doesn't normalize, doesn't replay, doesn't give you a DLQ for your own
downstream processing failures.

## 2. Ampersand - fully async, three decoupled hops

This is the core architectural difference from Nango, worth being precise
about: a trigger-read is **not** one request/response. It's three separate
hops, each with its own latency, none of them blocking the others:

```
 HOP 1 - trigger (synchronous, fast)              T+0ms
 ─────────────────────────────────────
   your app                 AMPERSAND
       │  POST trigger-read     │
       ├────────────────────────▶
       │                        │  starts an async job,
       │  ◀─ operationId only ──┤  does NOT wait for it
       │     (HTTP call ends     │  to finish
       │      here - ~instant)   │
                                 ▼
                         ┌───────────────┐
                         │  fetch GitHub   │  (this runs in the
                         │  + process       │   background, your
                         └───────────────┘   HTTP call already
                                 │            returned)
                                 ▼
 HOP 2 - status (you poll, separately)          T+0 to T+~2070ms
 ─────────────────────────────────────
   your app                 AMPERSAND
       │  GET operation status  │   (repeat every ~3s
       ├────────────────────────▶    until status flips
       │  ◀── "in_progress" ────┤    from in_progress
       ├────────────────────────▶    to success)
       │  ◀──── "success" ──────┤   measured: ~2.07s after
                                     trigger, in our test

 HOP 3 - delivery (push, via Svix, fully decoupled) T+~2070 to T+~2820ms
 ─────────────────────────────────────
                         ┌───────────────┐
                         │  AMPERSAND      │
                         │  hands off to   │
                         │  Svix for        │
                         │  webhook delivery │
                         └───────┬───────┘
                                 │ POST (your destination URL,
                                 │  registered ahead of time)
                                 ▼
                         ┌───────────────┐
                         │ your webhook    │  ◀── records actually
                         │ receiver         │      arrive HERE,
                         └───────────────┘      ~750ms after Hop 2
                                                  finished (measured)
                                 │
                                 ▼
              [Raw Landing Zone] (custom) → [Ingestion Manifest] (custom)
```

**Measured end to end (real numbers from this benchmark):** trigger at
`T+0`, Ampersand's internal processing done at `T+2070ms`, webhook actually
landing at `T+2820ms`. Total ~2.8s - not sub-second as marketed, but the
useful insight is *where* the time goes: ~2s is GitHub fetch + processing
(comparable to any API call), ~750ms is specifically the Svix delivery hop
- a cost Nango's synchronous proxy model doesn't have at all, because it
never decouples the request from the response in the first place.

This is also exactly why this model is a poor fit for live agent tool
calls: hop 1 returns instantly, but the data you actually want shows up
~2.8s later, on a completely different code path (your webhook handler,
not the original caller). An LLM mid-turn waiting on a tool result can't
naturally consume that without its own polling/waiting logic bolted on -
Nango's proxy just returns the answer in the same call.

Custom logic/DB needed either way: same as Nango, plus you need the
webhook receiver running *before* you can test anything, plus you store
the last-synced timestamp yourself (their `sinceTimestamp` param doesn't
persist on their side).

**Correction after reading their actual quickstart docs** (not just the
marketing comparison page): the primary read mechanism isn't really the
`trigger-read` REST call - it's a declarative manifest (`amp.yaml`) you
write and deploy via their CLI:

```yaml
read:
  objects:
    - objectName: issues
      destination: issuesWebhook
      schedule: "*/30 * * * *"   # a literal cron string you set
      backfill:
        defaultPeriod:
          fullHistory: true
```

```bash
amp login
amp deploy source --project=<project-id>
```

Two things this corrects:
1. **"Sub-second webhooks" almost certainly means provider-native webhook
   relay for providers that support it** (e.g. if the source pushes events
   itself), not the general read mechanism - which is plain cron polling,
   same category as Nango's. The schedule is something *you* configure,
   not an inherent platform property.
2. Deploying via CLI means this is still config-as-code, same as Nango's
   deployed sync scripts - "less code" is relative (YAML instead of
   TypeScript), not "no setup."

**Firsthand reliability finding, reproduced twice:** their GitHub `issues`
object maps to GitHub's "list issues assigned to the authenticated user"
endpoint - a global feed, not scoped to a repo at all, regardless of
anything configured in `amp.yaml`. On a fresh installation, this 404'd
immediately (likely a scope or auth nuance with that specific endpoint),
and Ampersand's internal retry loop classified the 404 as retryable and
**kept retrying indefinitely** - the operation just sat "In Progress"
forever in the dashboard, with no cancel button anywhere and no documented
API to terminate it. Every subsequent on-demand trigger for that
installation+object got rejected with "concurrent request rejected."

Deleted the installation, created a completely fresh one (new groupRef, new
connection) - **same failure, immediately, on the very first auto-triggered
read.** Reproducible, not a fluke. This is a sharper, evidence-backed
answer to "how do you handle failures" than any of the marketing claims:
their own retry logic doesn't have a circuit breaker - it doesn't know when
to give up on a non-transient error, and there's no user-facing way to
intervene once it's stuck.

**Root cause found and fixed:** the GitHub OAuth App registered in
Ampersand's dashboard was requesting invalid scopes - literally `repos` and
`repositories`, neither of which are real GitHub OAuth scopes (the correct
one is `repo`). GitHub silently grants a permission-less token for
unrecognized scopes, and returns 404 instead of 403 for under-scoped
requests on this specific endpoint (a deliberate GitHub API design choice
to avoid leaking resource existence) - which is what fed the infinite retry
loop above. Fixed it in the dashboard's OAuth Provider App config, redid
the OAuth flow, and on the next fresh installation:

- The stuck-forever bug didn't recur
- Backfill correctly delivered all 5 historical issues
- **Measured real end-to-end latency, decoupled from any wait-window
  assumptions:** triggered at `13:01:25.049Z`, Ampersand's internal
  processing finished at `13:01:27.122Z` (~2.07s), webhook delivery (via
  Svix) landed at `13:01:27.868Z` (~750ms more) - **~2.8s trigger-to-delivery
  total.** Not sub-second as marketed, but a real, defensible number now,
  not a guess.
- **Correction on the replay finding:** the webhook payload includes both
  `fields` (normalized) and a `raw` key with the complete, untouched GitHub
  API response (every nested field - assignee, repository, permissions,
  everything). Ampersand doesn't replay this for you, but if you persist it
  yourself, you actually have what's needed - unlike Merge.dev, which never
  exposes raw provider data under any circumstance.

So the final picture isn't "Ampersand is broken" - it's "Ampersand had a
real, reproducible, customer-facing bug (bad default OAuth scopes + no
circuit breaker on non-transient errors), and once fixed, it performed
reasonably well, with one genuine point in its favor (raw payload access)
that Merge.dev doesn't have." That's a more credible, complete story than
either "their marketing is all true" or "this platform doesn't work."

## 3. Merge.dev

Pull, synchronous REST calls. Merge polls the underlying provider on its
own internal schedule and serves you already-normalized data.

```
GitHub/Jira/Salesforce (within Ticketing/CRM/etc category)
        ▲ Merge polls internally, on its own schedule
        │
┌─────────────────────────────┐
│           MERGE.DEV            │
│  Normalizes into a fixed       │
│  Ticket/Opportunity/etc schema │
└─────────────────────────────┘
        ▲ GET /tickets?modified_after=... (sync, you call whenever)
        │
┌─────────────┐
│ your app     │
└─────────────┘
        │
        ▼
[Ingestion Manifest] (custom - tracks your modified_after cursor)
```

Important gap: you never see the original provider JSON through Merge,
only their normalized shape. If you want a raw landing zone for compliance,
you can only archive *their* output, not the original GitHub/Jira payload.

## 4. Composio

Pull (Actions - synchronous, request/response) plus Push (Triggers -
webhook on a provider event). Built more for "an agent calls a tool and
gets an answer right now" than for bulk historical sync.

```
GitHub (and 100+ other apps)
        ▲ Composio calls the provider on your behalf, synchronously
        │
┌─────────────────────────────┐
│          COMPOSIO              │
│  Actions (pull, sync call)     │
│  Triggers (push, webhook)      │
└─────────────────────────────┘
        │ Action response (sync)     │ Trigger webhook (push, on event)
        ▼                             ▼
┌─────────────┐               ┌─────────────┐
│ your app     │               │ your handler │
└─────────────┘               └─────────────┘
        │                             │
        ▼                             ▼
       [Raw Landing Zone] (custom either way) → [Ingestion Manifest] (custom)
```

Weak fit for bulk backfill - Actions are built for "fetch this one thing
now," not "paginate through 10,000 historical records."

## 5. Airbyte / Fivetran

Their connector polls the source on their own infra; data lands in a
destination warehouse you own. From your app's perspective, you just query
your own database whenever you want - the ELT pipeline happens upstream of
that, on their schedule (or on-demand if you trigger a sync via their API).

```
GitHub
        ▲ their connector polls source on schedule (their infra)
        │
┌─────────────────────────────┐
│       AIRBYTE / FIVETRAN       │
│  ELT: extract → load into a    │
│  destination YOU own           │
└─────────────────────────────┘
        │ writes rows into
        ▼
┌──────────────────────┐
│  YOUR Postgres/         │ ← if configured with a raw-JSON column, this
│  warehouse destination  │   is the closest thing to a managed raw
└──────────────────────┘   landing zone of any platform here
        │ you query this whenever (pull, from your app's view)
        ▼
[Ingestion Manifest] (custom - track which destination rows are processed)
```

Closest to a "managed raw landing zone" if you configure it that way, but
batch-oriented (sync runs on a schedule, adds a warehouse hop, not built
for live agent tool calls).

## 6. Alloy

Push-first (event-driven webhook → workflow → calls your API), but also
supports a manual/scheduled pull mode. No cursor/incremental-sync
primitive either way - but it does keep execution history, which gives it
a genuine replay capability none of the sync platforms above have.

```
Kuehne+Nagel (pushes)              Puma-style (Alloy pulls on schedule/trigger)
        │                                          ▲
        ▼                                          │
┌──────────────────────────────────────────────────┐
│                       ALLOY                        │
│  Workflow: trigger → transform → action             │
│  Execution history kept →                            │
│  /workflows/:id/rerun replays a PAST execution         │
│  (the original payload), no need for the source to      │
│  push again - this is a real replay capability            │
└──────────────────────────────────────────────────┘
        │ final step: calls your API directly
        ▼
┌─────────────┐
│ your API     │ ← you must dedupe/idempotency-check on receipt yourself,
└─────────────┘   Alloy doesn't enforce this for you
```

No incremental sync concept, not built for bulk historical backfill - but
worth noting it's the only platform here with a working replay primitive,
just scoped to "replay one past workflow execution," not "replay any
arbitrary historical window."

## The operational concerns, side by side

| Concern | Nango | Ampersand | Merge.dev | Composio | Airbyte/Fivetran | Alloy |
|---|---|---|---|---|---|---|
| Incremental sync | Auto via Sync engine, manual via proxy | Manual (`sinceTimestamp`) | Manual (`modified_after`) | Manual | Auto, native per connector | No primitive at all |
| Replay | No | **Confirmed - webhook payload includes a `raw` field with the complete untouched provider response, alongside `fields` (normalized). They don't replay it for you, but if you store it yourself, you have what you need - unlike Merge.dev which never exposes raw data at all** | No (never see raw) | No | Partial, if raw JSON kept in destination | Yes - replays one past execution |
| Idempotency | Partial (Records API dedupes via Sync) | You manage | Partial (stable IDs) | You manage | Yes - upsert by primary key | You manage on receipt |
| Failed processing → DLQ | Partial (retries own errors only) | Mixed - confirmed both a stuck-retry-forever bug (bad OAuth scope causing 404s with no circuit breaker) AND, once fixed, a working delivery within ~2.8s end-to-end | You manage | You manage | Limited (job-level retry only) | Manual rerun = DLQ recovery |
| Rate limits | Auto | Claims auto, unverified | Auto (internal) | Claims auto | Auto, mature connectors | N/A (push) / weak (pull mode) |
| Backfill | Native, configurable window | Confirmed working once OAuth scope was fixed - `fullHistory: true` delivered all 5 historical issues correctly | Manual pagination | Manual | Native, resumable | Not really a concept |
| Webhook + polling | Both | Both (poll status + receive webhook) | Polling only | Both (Actions=pull, Triggers=push) | Polling + on-demand trigger | Webhook-first, manual pull supported |

## The unified picture - if I were building this

No matter which platform(s) you pick per provider, the picture downstream
of "Integration" doesn't change. This is the actual takeaway from all of
the above:

```
SOURCES: GitHub, Slack, Salesforce, Kuehne+Nagel, Puma, ...
                              │
                              ▼
┌──────────────────── INTEGRATION (choose per provider) ────────────────────┐
│                                                                              │
│  Nango          → broad catalog, real-time pull, OAuth-heavy providers      │
│  Ampersand       → if its orchestration claims hold up, alternative to Nango │
│  Merge.dev        → quick normalized access within ticketing/CRM categories  │
│  Composio          → agent-style single-action lookups, not bulk sync          │
│  Airbyte/Fivetran   → analytics-style batch ELT, not for live agent reads        │
│  Alloy               → providers that push to you (KN-style), or trigger-based   │
│  Direct/custom         → client_credentials partner APIs (simple, no platform)   │
│                                                                                    │
└──────────────────────────────────┬───────────────────────────────────────────────┘
                                     ▼
                    ┌───────────────────────────────┐
                    │   RAW LANDING ZONE (custom)      │ ← gzip+sha256, immutable.
                    │   needed regardless of platform   │   No platform above provides
                    └───────────────────────────────┘   this for you.
                                     ▼
                    ┌───────────────────────────────┐
                    │  INGESTION MANIFEST (custom)     │ ← pending/normalized/failed
                    └───────────────────────────────┘
                                     ▼
                    ┌───────────────────────────────┐
                    │ ORCHESTRATION (Inngest/similar)  │ ← retries, DLQ, per-org
                    │ wraps the whole ingestion step    │   concurrency. This is the
                    └───────────────────────────────┘   gap every platform above
                                     ▼                    leaves open.
        ════════════════════ DATA LAYER (identical regardless of source) ═══════════
        NORMALIZE + CLASSIFY → ENTITY RESOLVER → GRAPH INDEXER → KNOWLEDGE GRAPH
```

The only thing that changes per-provider is the top box. Everything below
the Integration layer - raw storage, manifest, orchestration, normalize,
entity resolution, the graph - is the same custom infrastructure no matter
which platform handles the actual fetch. That's the whole argument this
research has been building toward: the platform choice matters less than
people assume, because most of the hard, differentiated work starts
*after* the data has already arrived.

## Final verdict: Nango over Ampersand, for this specific product

After actually testing both hands-on (not just reading marketing pages):

|  | Nango | Ampersand |
|---|---|---|
| Time to first real data | Minutes | Hours - OAuth app + scopes + manifest + CLI deploy + destination + installation |
| Reliability under test | Clean across all 5 tests once config was right | Found a real bug - bad default OAuth scopes caused an infinite retry loop with no circuit breaker and no cancel mechanism |
| Latency model | Synchronous, ~500ms | Async, ~2.8s measured end-to-end - not sub-second as marketed |
| Fits live agent tool-calls | Yes - direct request/response | No - the data arrives on a separate webhook hop, ~2.8s later, not in the original call |
| Connector breadth | 60+ live / 400+ available (the GTM lever) | Smaller catalog |
| Already validated | This is literally what's in Shiplog's own production architecture | Untested anywhere we can see |
| Genuine point in its favor | - | Webhook payload includes raw provider data alongside normalized fields - Merge.dev has neither |

The deciding factor isn't even the bug we found (which we fixed) - it's
that Ampersand's architecture is fundamentally async (trigger → poll →
separate webhook delivery), which is the wrong shape for a product that
needs both continuous sync *and* synchronous answers for live agent tool
calls mid-conversation. Nango's proxy model fits both. Ampersand's bundled
orchestration pitch also loses force once you know Inngest already runs
company-wide regardless of connector choice - adopting Ampersand wouldn't
remove that infrastructure, just add a second async layer next to it.
