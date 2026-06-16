# Concepts - how data actually gets into a system

Notes for myself on the fundamentals, before comparing specific platforms.
Every integration platform is just a different combination of answers to
these questions.

## 1. How does data get from the provider to you?

There are really only two directions data can move, and everything else is
a variation of these two.

### Pull (you ask, on a schedule)

You call the provider's API yourself, on a timer ("every 15 min, ask GitHub
for issues").

```
Your system  --(GET /issues?since=...)-->  GitHub
Your system  <--------(issues JSON)---------  GitHub
```

Problem: you have to know *when* to ask, and *what* to ask for ("only
what's new"). That's the incremental sync problem (see below).

Example: the `Direct` and `Nango` adapters in this repo both work this way -
GitHub never contacts you, you go get the data.

### Push (provider tells you, when something happens)

The provider calls *you* (a webhook) whenever there's new data. You don't
poll, you just sit and wait.

```
GitHub  --(something happened, here's a webhook POST)-->  Your system
```

Problem: you need a public endpoint they can reach, and if your endpoint is
down when they fire it, you can miss data (unless they retry).

Example: Gryn's Kuehne+Nagel integration - K+N pushes shipment data to us
via a webhook, we never ask them for anything.

### Hybrid: pull-triggered, push-delivered

A few platforms (Ampersand is the one in this repo) do something in
between: you tell them "go fetch now," they pull from the provider on your
behalf, then push the result to a webhook *you* configured ahead of time.

```
You  --(trigger read)-->  Ampersand  --(pulls)-->  GitHub
                                 |
                                 +--(pushes result)-->  your webhook
```

This is really still a pull from the provider's perspective, just with an
extra hop and a push-style delivery for the result.

## 2. The problems that show up no matter which direction you pick

### Auth

Two very different flavors, and people often lump them together:

- **Delegated OAuth** (authorization code flow) - a human clicks "Connect,"
  logs into their own GitHub/Salesforce account, grants scopes, you get an
  access token + a refresh token you have to rotate over time. This is what
  Nango/Merge/etc are built to manage, because doing this for hundreds of
  end-users by hand is real work.
- **Client credentials grant** - a static client_id/client_secret per
  business relationship, no human consent screen, no refresh token, you
  just request a fresh token whenever you need one. Most B2B/enterprise
  partner APIs (e.g. our Kuehne+Nagel integration) use this. It's ~30 lines
  of code, no platform needed.

One more dimension that matters: **single-tenant vs multi-tenant.** If
it's just you connecting your own GitHub account, OAuth complexity barely
exists - one token, you manage it. The actual hard case is when you have
N customers, each authorizing their own account through the same OAuth
App (registered once, representing your product), and you need to keep
N separate token pairs refreshed and isolated:

```
              Your OAuth App (registered once)
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   Customer A         Customer B         Customer C
   groupRef: A        groupRef: B        groupRef: C
   their own token    their own token    their own token
```

This is the actual case Nango/Ampersand/Merge solve well - managing
refresh across many isolated, customer-owned tokens. At read time you pass
the specific customer's ID (`groupRef` for Ampersand, `connectionId` for
Nango) so it pulls from *their* connection, not anyone else's.

The mistake is assuming every API auth problem needs Nango. Check which
kind of OAuth you're actually dealing with first.

### Pagination

Every provider splits large results into pages, but the mechanism differs:

- **Link headers** (GitHub) - the URL for the next page is in a response
  header, not the body: `Link: <https://api.github.com/...&page=2>; rel="next"`
- **Cursor-based** (Linear, Merge.dev) - the response body includes an
  opaque cursor string, you pass it back as a parameter on the next request
- **Offset-based** (some REST APIs) - you just increment `?page=N` or
  `?offset=N` yourself, no signal from the server about when to stop other
  than an empty page

None of the platforms in this repo eliminate this entirely - Direct/Nango
both manually parse Link headers, Merge.dev abstracts it behind a cursor.

### Rate limits

Every provider enforces limits differently:
- GitHub: `x-ratelimit-remaining` / `x-ratelimit-reset` headers, 403 when
  exceeded
- Some APIs: a flat 429 with a `Retry-After` header
- Some APIs: just silently throttle/slow down, no header at all

"Handling rate limits" means: read the right header for *this* provider,
back off the right amount, retry. Multiply by N providers and this is a
real maintenance burden, which is why Nango/Merge/Ampersand all claim to
abstract it (with varying levels of actually doing so - see `rate-limit.ts`
test in this repo).

### Incremental sync ("give me what changed")

After the first full sync, you don't want to re-fetch everything every
time. Two pieces to this:

1. The provider needs *some* way to ask for "only what changed" - e.g.
   GitHub's `?since=<timestamp>`, Merge's `?modified_after=`
2. Something needs to remember the last successful sync's cursor/timestamp
   and pass it back next time

The thing people get wrong: even on a "managed" platform, #2 is usually
still your job unless you're using that platform's *native scheduled sync
engine* specifically (not just calling their proxy/REST API on demand). See
`incremental.ts` in this repo - every platform tested still needed a
cursor passed in manually through their basic API.

This is also exactly why Alloy (a workflow-automation tool, not a sync
tool) doesn't fit here - it has no concept of a stored cursor at all. It's
built for "when X happens, do Y," not "remember where we left off."

### Normalization (the data shape problem)

Every provider returns the same *concept* in a different shape:

```
GitHub issue:   { id, number, title, state, body, created_at }
Linear issue:   { id, identifier, title, state: { name }, description, createdAt }
Salesforce case: { Id, Subject, Status__c, CreatedDate }
```

Same idea ("a ticket"), three completely different field names and
structures. This is a separate problem from auth/fetch - Nango fixes auth,
not this.

Platforms that fix this *within a category* (all ticketing tools normalized
into one shape): Merge.dev, Truto. They don't fix it *across* categories
(a Jira ticket and a Salesforce opportunity about the same deal are still
two unrelated objects to them).

### Reliability (retries, dead-letter queue)

What happens when a single request in the middle of a sync fails?

- No handling: the whole sync dies, you find out from a support ticket
- Manual: you catch the error, log it, maybe increment a counter (this is
  literally what our KN emissions cronjob does today - see README)
- Retry with backoff: automatically re-attempt failed requests a few times
  before giving up
- DLQ (dead-letter queue): failed items get parked somewhere you can
  inspect and manually re-trigger, instead of being silently dropped or
  silently retried forever

Workflow engines (Inngest, Temporal, Trigger.dev) are built specifically
for this layer. Connector platforms (Nango, Merge) only sometimes have it,
and only for their own internal calls, not your downstream processing.

### Replay ("redo this without re-fetching from the source")

If your *processing logic* has a bug (not the fetch, the step after it),
can you fix the bug and reprocess the data you already have, without
hitting the rate-limited source API again?

This needs the raw response saved somewhere durable *before* you transform
it - a "raw landing zone." None of the connector platforms tested in this
repo do this for you (see `failures-replay.ts`). Workflow engines like
Inngest get you partway there for free, because they cache each step's
output - replaying a failed run reuses the earlier step's cached result
instead of re-running it. But that's not the same guarantee as a real
immutable, checksum-verified archive built for compliance/audit purposes -
that part is always custom.

### Entity resolution (the hardest, rarely-discussed one)

Even after normalization, you might have the *same real-world thing*
showing up from multiple sources:

```
Slack: "deal with Brose closes Friday"
Salesforce: Opportunity { account: "Brose SE", close_date: "2024-12-06" }
GitHub: commit "fix: bumps for Brose release"
```

Three different objects, same underlying deal. Linking them requires
fuzzy matching, sometimes an LLM, sometimes a human-in-the-loop fallback.
No platform sells this - it's the kind of thing that becomes a product's
actual moat (see Shiplog's "Entity Resolver" + "Knowledge Graph" layers).

## 3. Quick reference - who solves what

| Problem | Nango | Merge.dev | Airbyte/Fivetran | Ampersand | Alloy | You, always |
|---|---|---|---|---|---|---|
| Delegated OAuth | Yes | Yes | Yes | Yes | Yes | - |
| Pagination | Partial (you write the loop) | Yes (cursor) | Yes | Claims yes | N/A | Fallback |
| Rate limits | Partial | Yes | Yes | Claims yes | N/A | Fallback |
| Incremental sync | Native engine only, not via proxy | Filter param, you pass cursor | Yes (native) | Claims yes | No | Fallback |
| Normalization | No | Yes (within category) | Partial | No | No | Always, across categories |
| Retries/DLQ | Partial | Partial | Partial | Claims yes | N/A | Usually you (Inngest etc) |
| Replay from raw | No | No | No | No | No | Always you |
| Entity resolution | No | No | No | No | No | Always you |
