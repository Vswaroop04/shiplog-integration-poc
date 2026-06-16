# integration-benchmark

Researching what's the best way to handle data ingestion / continuous sync from
third-party providers (GitHub, Linear, etc) into our own system. This came up
because of an interview question about enterprise integrations and sync
pipelines - "Nango or Airbyte or Fivetran style, what did you build, how did
you handle failures and replay."

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

## The 4 candidates

- **Nango** - code-first, you write the sync logic, they run it on their
  infra and handle OAuth + retries
- **Merge.dev** - unified API, normalizes data into a fixed schema per
  category (ticketing, CRM, etc), less code but less control
- **Airbyte** - open source ELT, syncs into a destination warehouse you
  configure, not request/response
- **Fivetran** - same ELT model as Airbyte, fully managed, zero sync code

These 4 all actually have a "sync" primitive built in (scheduled runs,
incremental state). Alloy and Composio/Truto don't really - they're more
proxy/action layers.

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
