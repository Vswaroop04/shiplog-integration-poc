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

## 2. Ampersand

Hybrid - you trigger a read (pull-style call), but the actual records
arrive later via a webhook to a destination you configured ahead of time
in their dashboard.

```
GitHub/etc
        ▲ Ampersand fetches on your trigger
        │
┌─────────────────────────────┐
│          AMPERSAND            │
│  POST trigger-read            │
│  → returns operationId only   │
└─────────────────────────────┘
        │ you poll operation status        │ ...separately, pushes the
        ▼                                   │  actual records here:
┌─────────────┐                     ┌──────────────────────┐
│ your app     │                     │ your public webhook    │
│ (status only)│                     │ receiver (needs to       │
└─────────────┘                     │ exist + be tunneled       │
                                     │ BEFORE you trigger)        │
                                     └──────────────────────┘
                                              │
                                              ▼
                    [Raw Landing Zone] (custom) → [Ingestion Manifest] (custom)
```

Custom logic/DB: same as Nango, plus you need the webhook receiver running
*before* you can test anything, plus you store the last-synced timestamp
yourself (their `sinceTimestamp` param doesn't persist on their side).

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

## 5. Truto (ruled out - documenting for completeness)

Architecturally fine - pull, pass-through proxy, same effort as calling
the provider directly. Disqualified entirely on signup friction (sales
contact required), not on architecture.

```
GitHub
        ▲ pass-through proxy, Link headers come through unchanged
        │
┌─────────────────────────────┐
│            TRUTO               │
│  Thin proxy, zero data         │
│  retention                     │
└─────────────────────────────┘
        ▲ GET /proxy/github/... (sync)
        │
┌─────────────┐
│ your app     │
└─────────────┘
        │
        ▼
[Raw Landing Zone] (custom) → [Ingestion Manifest] (custom)
```

## 6. Airbyte / Fivetran

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

## 7. Alloy

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

| Concern | Nango | Ampersand | Merge.dev | Composio | Truto | Airbyte/Fivetran | Alloy |
|---|---|---|---|---|---|---|---|
| Incremental sync | Auto via Sync engine, manual via proxy | Manual (`sinceTimestamp`) | Manual (`modified_after`) | Manual | Manual | Auto, native per connector | No primitive at all |
| Replay | No | No | No (never see raw) | No | No | Partial, if raw JSON kept in destination | Yes - replays one past execution |
| Idempotency | Partial (Records API dedupes via Sync) | You manage | Partial (stable IDs) | You manage | You manage | Yes - upsert by primary key | You manage on receipt |
| Failed processing → DLQ | Partial (retries own errors only) | Unclear, assume you manage | You manage | You manage | You manage | Limited (job-level retry only) | Manual rerun = DLQ recovery |
| Rate limits | Auto | Claims auto, unverified | Auto (internal) | Claims auto | None - pass-through | Auto, mature connectors | N/A (push) / weak (pull mode) |
| Backfill | Native, configurable window | Manual (omit timestamp) | Manual pagination | Manual | Manual | Native, resumable | Not really a concept |
| Webhook + polling | Both | Both (poll status + receive webhook) | Polling only | Both (Actions=pull, Triggers=push) | Polling only | Polling + on-demand trigger | Webhook-first, manual pull supported |

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
