# integration-benchmark

Researching what's the best way to handle data ingestion / continuous sync from
third-party providers (GitHub, Linear, etc) into our system.

The actual problem we care about: continuously pulling data from a bunch of
providers, keeping it in sync over time, and being able to recover/replay if
something breaks. Not one-off triggers, not "when X happens do Y" - ongoing
sync.

## Alloy - ruled out

Looked at Alloy (Runalloy) first since it's also an integration platform.
Ruled it out because it's built for a different shape of problem - it's a
workflow automation tool (event happens -> trigger an action somewhere else),
not a continuous data sync tool. It doesn't have the cursor/checkpoint
primitive you need for "give me only what changed since last time." So even
though it's in the same general category as Nango, it doesn't fit this use
case.

## The candidates

- **Nango** - code-first, you write the sync logic, they run it on their
  infra and handle OAuth + retries
- **Merge.dev** - unified API, normalizes data into a fixed schema per
  category (ticketing, CRM, etc), less code but less control
- **Airbyte** - open source ELT, syncs into a destination warehouse you
  configure, not request/response
- **Fivetran** - same ELT model as Airbyte, fully managed, zero sync code
- **Ampersand** - added later, see below. Claims to ship the orchestration
  layer (retries, rate-limit backoff, backfills) that Nango leaves to you,
  plus event-driven webhooks instead of polling

These all actually have a "sync" primitive built in (scheduled runs,
incremental state). Alloy and Composio don't really - they're more
proxy/action layers.

**Also looked at and ruled out:** Truto (no self-serve signup, you have to
contact sales just to get an account - not worth it for a benchmark, removed
the adapter entirely), Corsair (open source, but built for AI
agent action execution with permission gates, not continuous data sync -
same category mismatch as Alloy) and Knit (another Merge.dev-style unified
API, doesn't add anything Merge.dev doesn't already cover).

## What's in here

A small CLI that runs the same GitHub sync against each platform and prints
a comparison. Tests:

- `sync` - basic fetch, time to first record, lines of adapter code
- `pagination` - GitHub uses Link headers, who handles that for you
- `rate-limit` - who backs off automatically vs who throws raw 429s at you
- `failures-replay` - what happens when a request fails mid-sync, and
  whether you can reprocess from a stored raw payload without re-hitting
  the source API (spoiler: none of them support this)
- `incremental` - after a full sync, can you fetch only what changed, and
  who tracks the cursor

## Running it

```
npm install
cp .env.example .env
# fill in whatever keys you have, GITHUB_TOKEN is optional
npm run benchmark
```

Each platform is skipped automatically if its env vars aren't set. Direct
GitHub API works with zero setup.

Airbyte and Fivetran need more than just an API key - they need a connector
configured against a real destination Postgres DB. Didn't bother setting
those up live, the code is there mostly to show the architecture difference
(ELT-to-warehouse vs request/response proxy), not to get real numbers.

## Findings so far

- Pagination and rate limit handling differ across every platform, nobody
  fully abstracts it away
- None of the 4 platforms store raw payloads or support replay without
  re-calling the source API - this is something we'd build ourselves no
  matter which platform we pick
- Cursor tracking for incremental sync is always partially on you, even with
  a "managed" platform - the difference is whether the platform has a native
  scheduled sync engine behind it or you're just calling a proxy endpoint
  on demand
- Merge.dev/Truto solve normalization within their supported categories,
  but none of them link the same real-world entity across different sources
  (a Jira ticket and a Salesforce deal about the same thing) - that part is
  always custom

## What none of these solve on their own: orchestration/reliability

Connect + fetch is one problem. Retries, DLQ, per-tenant concurrency, and
replay are a separate problem, and none of the 4 candidates really solve it.

The combo that actually covers most of this: **Nango + a durable workflow
engine like Inngest** (could also be Trigger.dev or Temporal, Inngest is
just the one with the simplest mental model).

- Nango handles auth + scheduled fetch + pagination/rate limits
- Inngest wraps the sync as a step function - automatic retries, DLQ for
  failed runs, concurrency limits per org
- side benefit: Inngest caches each step's output, so if step 2
  (normalize) has a bug and you fix it, replaying the run reuses the
  cached output of step 1 (the fetch) instead of re-hitting the source
  API. That's basically "replay from raw" without building a landing zone
  from scratch.

Still custom either way: long-term immutable raw storage for compliance,
the actual normalization logic, and entity resolution across sources. But
auth + fetch + retries + DLQ + cheap replay is a big chunk of the problem
covered by just these two pieces together.

## Ampersand - testing whether it replaces the combo above

Found this while looking around for more options. Their own marketing
(comparison page against Nango, so take it with a grain of salt) claims:

- event-driven webhooks instead of polling (sub-second vs "5 min minimum
  typical" for Nango)
- retries, rate-limit backoff, and backfills built into the platform itself,
  not something you write

If that's actually true, it's a real challenge to the "Nango + Inngest"
conclusion above - a single platform instead of two. Added an adapter to
test it.

One thing that matters architecturally: their read API is push-based, not
pull. You POST a trigger-read call, and records get delivered to a webhook
destination you configure ahead of time in their dashboard - the trigger
call itself doesn't hand you the data back. So the adapter has to run a
local HTTP listener, and for it to receive anything that listener needs to
be tunneled (ngrok) and registered as the destination first. Same setup
cost as Airbyte/Fivetran's destination requirement, just a webhook instead
of a database.

Haven't verified the retry/backoff claims hands-on yet - that's the actual
test to run before relying on this in the interview.

## Checked this against a real example at work

We already have two different integrations with the same partner (a freight
forwarder) at work, which turned out to be a good real-world check on all of
this:

- One direction is event-driven: the partner pushes data to us via a webhook
  through a workflow-automation tool (their workflow just forwards the
  payload to our API). No polling, no cursor - this matches exactly the
  "trigger" shape that ruled Alloy out for the *sync* problem above. Good
  tool for that job, just not this one.
- The other direction is a pull: we have our own cronjob that calls the
  partner's API daily. Auth there is OAuth2 client_credentials grant - a
  static client_id/secret per customer, no refresh token, no per-user
  consent flow. It's like 30 lines of code, already written by hand, no
  connector platform involved at all.

That second one is the useful data point: it shows Nango's actual value
(managing complex delegated OAuth + refresh tokens across many different
end-user accounts) just doesn't apply to a lot of B2B/enterprise partner
APIs. Those tend to use simple static credentials. The thing that *is*
missing in that cronjob is reliability - failures are just counted and
logged, retried implicitly whenever the cron runs again next time. No
backoff, no DLQ, no per-failure replay. Which lines up with the
orchestration gap above - the auth/fetch problem was never the hard part
here, the missing piece is the same Inngest-shaped layer.

## The company's actual architecture diagram confirms all of this

Got hold of the real product architecture diagram for the company I'm
interviewing with. The Integration layer is, almost exactly, the "Nango +
Inngest + custom raw landing zone" conclusion above - not Ampersand, not
Airbyte, not Fivetran:

- **Nango adapters** - OAuth vault, "60+ connectors live, 400+ more
  available via Nango" - explicitly called out on the sources row of the
  diagram as the GTM lever: when a new customer asks for a provider that
  isn't built yet, there's a good chance Nango already has it, so it's
  near-zero-cost to add instead of building a custom adapter
- **Raw landing zone** - gzip + sha256, immutable object storage. The
  literal thing I kept saying nobody sells - confirmed, they built it
  themselves
- **Ingestion manifest** - a state machine table (pending/normalized/failed)
  for tracking what's been processed - also custom
- **Inngest** - listed under their tech stack as the workflow engine, with
  per-org concurrency - and it's not scoped to just the integration layer,
  it's reused across the whole product (the Intelligence layer also has a
  "cron/webhook/user trigger" step). So it's a horizontal piece of
  infrastructure, not something tied to whichever connector platform they
  picked
- Backfill is explicitly "progressive: 30d -> 90d -> full, resumable,
  checkpointed, replay from raw on any change" - same idea as the
  incremental/replay tests above, just with the custom landing zone backing
  it instead of relying on any platform's built-in replay (there isn't one)

So this answers the "is Ampersand better for our use case" question pretty
directly: no, at least not for replacing Nango here. The reason isn't that
Ampersand's claims are false, it's that the actual decision they made was
to deliberately split this into a broad, lower-level connector layer
(Nango, optimized for *connector count* since that's the GTM lever) and a
separate general-purpose orchestration layer (Inngest, reused everywhere,
not just for sync) - rather than an all-in-one platform that bundles both
inside the connector tool. Ampersand's pitch is "fewer moving parts," but
this architecture deliberately chose more moving parts in exchange for: a
much bigger connector catalog, and one workflow engine for the entire
product instead of one that's only useful for the ingestion step.
