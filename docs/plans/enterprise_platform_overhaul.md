# Enterprise Data Platform — Architectural Overhaul

**Status:** Strategic plan (pre-implementation) · **Author:** Claude (April 2026) · **Scope:** 6–9 months, 5–8 engineers

---

## TL;DR

Today's app is a single-user XLSX analyst tool. Target is **federated, multi-source, thousands-of-users, dashboard-on-demand** for managers across Marico's warehouses (Snowflake, Mode, Azure SQL, Nielsen, …).

The one idea that decides whether this scales: **never let the LLM write raw SQL directly against warehouses.** Instead, build a **Semantic Catalog** (Azure AI Search) + **Semantic Layer** (Cube / dbt Semantic Layer) + **Tool-based agent mesh** (extension of the current runtime). AI Search becomes the spine — it's what tells the agent *where to look, what things mean, and what's already been answered.*

This doc sketches the target architecture, then breaks rollout into 6 phases, each a dependency graph of tiny waves per CLAUDE.md cadence.

---

## 1 · Why the current shape doesn't scale

| Dimension | Today | Target |
|---|---|---|
| Users | 1 at a time, one session per dataset | 1000s concurrent, no upload step |
| Data | Uploaded XLSX/CSV via DuckDB | Federated: Snowflake, Mode, Azure SQL, Nielsen, SharePoint, internal APIs |
| Scope per chat | One file | Any company data, RLS-enforced |
| Answer | Text + chart | Full interactive dashboard + narrative + drilldowns |
| Correctness | LLM + DuckDB over small sample | Must guarantee canonical metrics + provenance |
| AI Search role | Session-scoped vector cache (marginal value) | Central semantic brain |
| Cost posture | Negligible | Must cap per-user per-day or it bankrupts the project |
| Governance | None required | Row-level security, audit, PII masking, sensitivity labels |

The current agent runtime, chart pipeline, pivot infra, and Cosmos/Blob scaffolding **survive**. What changes is everything around them: data ingress, semantic layer, orchestration scope, and observability.

---

## 2 · The architectural idea (one picture)

```
 ┌───────────────────────────────────────────────────────────────────────┐
 │  Manager types: "Why did Q3 sales drop in West, and who's holding up  │
 │  the shortfall?"                                                       │
 └───────────────────────────────────────────────────────────────────────┘
                               │
                   [Auth + Tenant + RLS Context]   (Azure AD SSO → groups → policies)
                               │
                   [Router] ── classify: metric Q / exploratory / document / report fetch
                               │
  ┌────────────────────────────┼────────────────────────────────────────┐
  │                            ▼                                        │
  │               [Semantic Catalog — Azure AI Search]                  │
  │       ┌──────────────────────────────────────────────────────┐      │
  │       │  Hybrid (keyword + vector + semantic-rerank) search  │      │
  │       │  over indexes of:                                    │      │
  │       │    • table_doc     — every table across all sources  │      │
  │       │    • metric_doc    — canonical business definitions  │      │
  │       │    • dashboard_doc — Mode reports, saved dashboards  │      │
  │       │    • past_analysis — every prior Q&A + SQL + success │      │
  │       │    • document_doc  — Nielsen PDFs, playbooks, docs   │      │
  │       │    • glossary_doc  — business terms, abbreviations   │      │
  │       └──────────────────────────────────────────────────────┘      │
  │                            │                                        │
  │                            ▼                                        │
  │                [Planner — agent runtime]                            │
  │   Decomposes into sub-queries + picks tools + drafts dashboard spec │
  │                            │                                        │
  │          ┌─────────────────┼──────────────────────────┐             │
  │          ▼                 ▼                          ▼             │
  │   [Semantic Layer]    [Document Search]        [Report Fetch]       │
  │   (Cube / dbt SL)     (AI Search doc_doc)      (Mode API)           │
  │          │                 │                          │             │
  │          ▼                 │                          │             │
  │  ┌───────────────┐         │                          │             │
  │  │ Snowflake     │         │                          │             │
  │  │ Azure SQL     │         │                          │             │
  │  │ user-uploads  │         │                          │             │
  │  │ (DuckDB)      │         │                          │             │
  │  └───────────────┘         │                          │             │
  │          │                 │                          │             │
  │          └─────── Results → [Cache layer (Redis + Cosmos)] ←────────┤
  │                            │                                        │
  │                            ▼                                        │
  │               [Synthesizer — dashboard spec + narrative]            │
  │                            │                                        │
  │                            ▼                                        │
  │               [Verifier — provenance + number consistency]          │
  │                            │                                        │
  │                            ▼                                        │
  │               [Render + Save + Index back as past_analysis_doc]     │
  └─────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
           Manager sees a full dashboard with narrative, drilldowns,
           data provenance, and "share / schedule / export" actions.
```

---

## 3 · The Semantic Catalog (Azure AI Search, doing real work)

This is the single most important new component. It replaces `rag-session-chunks` entirely.

### 3.1 · Why AI Search specifically

Most vector DBs only do vector search. AI Search gives us:
- **Hybrid search**: BM25 + vector + semantic reranking. Managers use exact terms ("EBITDA", "ACV", SKU codes); pure vector search misses these. Hybrid catches both.
- **Integrated vectorization** (2024+): push docs, AI Search embeds them. No separate embedding pipeline.
- **Skillsets + indexers**: pull-based ingestion from Blob/Cosmos/SQL with OCR, entity extraction, language detection. *This is what the empty Skillsets tab in your portal is for* — we'll actually use it for the Nielsen PDF corpus.
- **Faceting, filtering, sorting**: critical for enterprise UIs (e.g., "search metrics in domain=Finance owned-by=CFO-office").
- **Sensitivity labels + AAD auth**: RLS-like access control at retrieval time.

### 3.2 · Index schema (six document types, one index — or split if cardinality demands it)

```yaml
# semantic-catalog index — one doc per logical entity

fields:
  id:            { key, filterable }           # "table_doc__snowflake__sales__fact_orders"
  tenantId:      { filterable, facetable }
  docType:       { filterable, facetable }     # table_doc | metric_doc | dashboard_doc | past_analysis | document_doc | glossary_doc
  sourceSystem:  { filterable, facetable }     # snowflake | mode | azure_sql | nielsen | upload | internal
  domain:        { filterable, facetable, collection }  # ["finance", "marketing", "supply_chain"]
  owner:         { filterable, facetable }
  sensitivity:   { filterable, facetable }     # public | internal | confidential | restricted
  accessPolicy:  { filterable, collection }    # AAD group IDs permitted to retrieve
  title:         { searchable }                # "Net Sales (Daily)", "fact_orders", "Q3 SE Asia Launch"
  description:   { searchable }                # rich prose
  body:          { searchable }                # columns, sample values, prose, SQL, etc.
  tags:          { searchable, collection, facetable }
  lastRefreshed: { filterable, sortable }
  dataVersion:   { filterable }                # monotonic per source refresh
  usageCount:    { sortable }                  # telemetry feedback
  successSignal: { sortable }                  # for past_analysis docs: fraction of thumbs-up
  titleVector:   { vector(3072), hnsw }
  bodyVector:    { vector(3072), hnsw }
```

### 3.3 · What each `docType` contains

| docType | Populates from | Refresh cadence | Example |
|---|---|---|---|
| `table_doc` | Snowflake INFORMATION_SCHEMA + dbt manifest + Azure SQL catalog + sample values | Nightly (indexer with skillset) | `fact_orders.warehouse_region_daily`: 234 cols, rowcount, partitions, lineage |
| `metric_doc` | Curated YAML in Git → synced job | On commit | `net_sales = SUM(quantity * net_price - discount) WHERE is_deleted = FALSE` with dims, owner |
| `dashboard_doc` | Mode API crawl + saved dashboards from Cosmos | Hourly | "West Region Exec Review — updated daily 7am" + filters it accepts |
| `past_analysis` | Every turn of the chat agent writes one | Real-time on answer | Question, rewritten question, SQL executed, charts built, thumbs-up/down, userId |
| `document_doc` | Blob container of PDFs/DOCX → AI Search indexer with OCR + entity extraction skillsets | Nightly | Nielsen "FY26 Edible Oil Category Report" — chunked with `SplitSkill`, enriched with `EntityRecognitionSkill` |
| `glossary_doc` | Curated Git repo of business terms | On commit | "DSR = Daily Sales Run-rate = last 7d sales / 7" |

### 3.4 · How retrieval actually helps the agent

A single hybrid query like:

```
"why did Q3 sales drop in West region"
↓
POST /indexes/semantic-catalog/docs/search
  queryType: semantic
  search: "Q3 sales drop West region"
  semanticConfiguration: "default"
  vectorQueries: [{ vector: <embedding>, fields: "bodyVector,titleVector", k: 20 }]
  filter: "accessPolicy/any(p: search.in(p, 'group1,group2')) and tenantId eq 'marico'"
  facets: [docType, domain, sourceSystem]
  top: 15
```

returns (interleaved by hybrid rerank):

1. **metric_doc** `net_sales`, `net_sales_growth_pct` — now the LLM knows the canonical metric
2. **table_doc** `fact_orders_regional_daily` — the right source table with `region`, `order_date`, `net_sales_cents`
3. **past_analysis** "Why did Q2 sales drop in West?" — shows how this was answered last time, including the SQL the analyst accepted
4. **glossary_doc** "West region = US-West + LATAM-West (changed FY24)"
5. **document_doc** chunks from a Nielsen quarterly category report on western markets
6. **dashboard_doc** "West Region Exec Review" — the manager can also jump straight to it

Now the planner writes a semantic-layer query, *not* raw SQL, using canonical metrics the LLM didn't invent, filtered by the right region definition. That's an answer you can trust in front of a CFO.

### 3.5 · Why this is 10× the current setup

| Current | New |
|---|---|
| Indexes raw rows from one uploaded file | Indexes *metadata* for all company data |
| Session-scoped only | Tenant-scoped, access-filtered, cross-session |
| No governance | Sensitivity labels, access policy, audit-ready |
| No refresh pipeline | Nightly indexers, real-time past-analysis writes |
| Marginal quality lift | Directly unblocks multi-source federation |

---

## 4 · The Semantic Layer (non-negotiable)

### 4.1 · Why

The alternative — LLM writes raw SQL against 500 warehouse tables — fails three ways at scale:

1. **Correctness**: "Net Sales" has 15 different definitions across the company. Every question gets a slightly wrong answer.
2. **Security**: Managing RLS across 500 tables via dynamic SQL is a nightmare.
3. **Cost**: LLM-written SQL is rarely optimal. At thousands of queries/day on Snowflake, unoptimized queries cost real money.

A semantic layer solves all three: one canonical definition per metric, RLS pushed down once, query plans reviewed, aggregations cached.

### 4.2 · Tool choice

| Option | Pros | Cons |
|---|---|---|
| **Cube.dev (self-hosted)** | Mature, strong SQL generation, REST + GraphQL APIs, pre-aggregations built in | Another system to operate; Yaml-heavy modelling |
| **dbt Semantic Layer (MetricFlow)** | Already ubiquitous in dbt shops; versioned with analytical code | Requires dbt Cloud for the SL runtime; newer |
| **Malloy (Google)** | Elegant query language | Smaller ecosystem |
| **Home-grown (don't)** | Full control | Will burn a team-quarter and produce a worse Cube |

**Recommendation: Cube.dev self-hosted.** Has a REST API the agent can call as a tool; pre-aggregations handle the "thousands of users hitting same metric" case beautifully. Use dbt Semantic Layer only if Marico is already all-in on dbt Cloud.

### 4.3 · How the agent uses it

A new tool registered in `agents/runtime/tools/registerTools.ts`:

```ts
{
  name: "semantic_layer_query",
  description: "Query canonical business metrics with dimensions + filters",
  schema: {
    metric: string,        // "net_sales", "gross_margin_pct", …
    dimensions: string[],  // ["region", "month"]
    filters: Filter[],     // [{dim: "region", op: "in", values: ["US-West"]}]
    timeGrain: "day" | "week" | "month" | "quarter",
    limit?: number
  }
}
```

Cube answers this in ~100ms from pre-aggregations or ~5s from cold Snowflake. The LLM never sees SQL, writes fewer broken queries, and can't leak other regions' numbers.

For "long-tail" exploratory queries that can't be expressed as metric+dimensions (e.g., "find all SKUs whose sales pattern resembles this one"), fall back to a guarded SQL tool — but it runs in a sandboxed, read-only role with a query-cost cap.

---

## 5 · Federated data-source tool mesh

Every source is a tool. New source = new adapter + new tool, no core changes.

| Tool | Source | Use case |
|---|---|---|
| `semantic_layer_query` | Cube → Snowflake/Azure SQL | Canonical metric questions (the 80% case) |
| `sandboxed_sql` | Snowflake (read-only role, 60s timeout, 1GB result cap) | Long-tail exploratory |
| `mode_report_fetch` | Mode API | "Show me the West Region weekly report" |
| `nielsen_document_search` | AI Search document_doc filter | "What did Nielsen say about edible oil Q3?" |
| `past_analysis_fetch` | AI Search past_analysis filter | "What did my team find on this last time?" |
| `glossary_lookup` | AI Search glossary_doc filter | Quick definitions mid-turn |
| `dashboard_fetch` | Saved dashboard in Cosmos | Manager asks for a named existing dashboard |
| `upload_data_query` | DuckDB (existing) | User wants ad-hoc analysis on their own upload |
| `internal_api_fetch` | HR/Finance/Ops internal REST APIs | Narrow use cases with API contracts |

The planner picks 1–5 tools per turn. The agent runtime's existing parallel-tool-groups infra (W8) already handles this.

### Auth pass-through

Every tool call carries `(tenantId, userId, groupIds[])` so each source can enforce its own RLS:

- **Snowflake**: use SAML-via-Azure-AD to get per-user session tokens; rely on Snowflake row-access policies
- **Azure SQL**: Azure AD authentication + native RLS predicates
- **Mode**: service account + post-filter on report metadata access list
- **Nielsen docs in AI Search**: `accessPolicy/any(p: search.in(p, 'userGroups'))` filter

---

## 6 · Dashboard generation pipeline

Manager asks → **full dashboard returned**, not a single chart. This is real product work.

### 6.1 · Dashboard spec (target output of the planner)

```ts
interface Dashboard {
  id: string;                      // shareable URL slug
  title: string;                   // LLM-generated
  narrative: {
    headline: string;              // "Net Sales fell 8% in West driven by Body Care"
    supporting: string[];          // 3-5 bullets
    caveats: string[];
  };
  layout: "executive" | "drilldown" | "comparison" | "root_cause" | "trend";
  sections: Section[];             // each section = charts + prose
  filters: FilterBar[];            // interactive filters applied across sections
  provenance: {                    // per section: what generated each number
    sqlByChart: Record<string, QueryRecord>;
    sources: string[];             // "snowflake.warehouse.fact_orders@2026-04-21"
  };
  drilldowns: { from: ChartId, to: DashboardSpec | Question }[];
  exportTargets: ["pdf", "pptx", "xlsx"];
}
```

### 6.2 · Layout templates

Five canonical layouts stored as YAML in Git, **indexed in AI Search as `layout_doc`** so the planner can retrieve the right one:

1. **Executive Summary** — headline KPI tiles, primary trend, drilldown prompt
2. **Drilldown** — filtered chart at top, contributor breakdown, outlier table
3. **Comparison** — side-by-side charts with shared axes, variance columns
4. **Root-Cause** — headline change, waterfall decomposition, supporting tables
5. **Trend** — time-series + moving averages + anomaly markers

The planner retrieves a layout by semantic similarity to the question, then fills it in. This is the "template library" pattern that makes dashboard generation reliable instead of hallucinatory.

### 6.3 · Rendering

Extend the existing [client/src/pages/Dashboard/](client/src/pages/Dashboard/) infra. The spec → React component mapping already exists for single dashboards; extend to multi-section layouts. Reuse Recharts + the existing `ChartRenderer`.

### 6.4 · Export

Server-side render via Puppeteer → PDF; via Puppeteer + custom template → PowerPoint via `pptxgenjs`. Both are one-off tools; low risk.

---

## 7 · Operational backbone

### 7.1 · Multi-tier caching (do this or the project dies at scale)

| Layer | Keyed by | TTL | Hit-rate target |
|---|---|---|---|
| **Semantic question cache** | embedding of normalized question + user's permission set | until data version bumps | 30–40% (managers ask repeat questions) |
| **Tool result cache** | tool name + arg hash + permission set | minutes to hours per source | 60–80% on hot metrics |
| **Warehouse result cache** | Snowflake native (free), Cube pre-aggregations | hours to days | 90%+ on pre-aggs |
| **Rendered dashboard cache** | dashboard id + filter-state hash | until underlying query invalidates | 50%+ |

Implementation: Redis for L1/L2 (or Azure Cache for Redis); Cosmos for L3 durable; Snowflake/Cube native for L4.

### 7.2 · Observability

- **OpenTelemetry** traces across Express → agent tools → warehouse. Visualize in Grafana Tempo or Azure App Insights.
- **Per-query cost record**: tokens in/out, warehouse bytes scanned, cache hits, user, team. Write to a `query_telemetry` Cosmos container. Dashboard it.
- **Success signal**: thumbs up/down on every answer → back into `past_analysis_doc.successSignal`. Use for prompt few-shot selection and for killing bad metric definitions.
- **Sentry** for errors (already available as MCP server; wire in server + client).

### 7.3 · Cost controls

- **Per-user-per-day token budget** enforced in middleware. Tier by role (exec > manager > analyst > guest).
- **Query-cost estimator** before running: if estimated > N, prompt user to narrow.
- **Anomaly alerts**: Slack alert when any user's daily cost > 5× their rolling 30d median.

### 7.4 · Tenancy

Even if "one tenant = Marico" today, architect for multi-tenant from day 1:
- `tenantId` in every Cosmos doc, every AI Search doc, every Redis key prefix
- Partition Cosmos containers by `tenantId`
- Separate Snowflake warehouses per tenant (billing segregation)

Adding a second tenant later without this will be a 3-month retrofit.

### 7.5 · Governance

- **Metric review workflow**: new metric definitions require approval from a designated domain owner before becoming `metric_doc`
- **PII classification**: pipeline scans new `table_doc` entries, flags columns matching PII patterns, tags sensitivity
- **Audit log**: every query, who asked, what data touched, what answer returned — 1 year retention in Cosmos, queryable by compliance

---

## 8 · What we keep from the current app

Surprising amount survives:

| Component | Fate |
|---|---|
| Agent runtime (`server/lib/agents/runtime/`) | **Keep, extend.** Planner → tools → reflector → verifier stays. New tools added, new planner prompts. |
| Chart generator (`server/lib/chartGenerator.ts`) | **Keep.** Spec → chart mapping is reusable. |
| Pivot engine (`server/lib/pivotQueryService.ts`, client pivot UI) | **Keep.** Users still want pivots over result sets. |
| DuckDB upload path | **Keep, demote to "one source among many".** Manager-uploaded data becomes a valid `upload_data_query` tool. |
| Azure AD auth (`server/middleware/azureAdAuth.ts`) | **Extend** with group-based claims and permission resolution. |
| Cosmos + Blob | **Keep.** Add more containers (`telemetry`, `metrics`, `dashboards_saved`, `audit`). |
| Client Home / ChatInterface / MessageBubble | **Keep core, add dashboard renderer.** |
| RAG chunking of sessions | **Delete.** Replaced by `past_analysis_doc` writes and the broader semantic catalog. |
| `rag-session-chunks` index | **Delete.** Replaced by `semantic-catalog`. |

---

## 9 · Rollout — 6 phases

Per CLAUDE.md: tiny waves, one file-class each, subject lines `Wave W<n> · <subject>`. Phases run roughly sequentially; some overlap is fine.

### Phase 0 · Foundation (6–8 weeks)

Make the current codebase multi-tenant-ready and observable before adding complexity.

- **W0.1** — `DataSource` abstraction: interface + `UploadDataSource` (wraps DuckDB)
- **W0.2** — `tenantId` plumbed through Cosmos, Blob, AI Search, Redis
- **W0.3** — Azure AD groups → `Permissions` resolver middleware
- **W0.4** — OpenTelemetry tracing on server (auto-instrument Express + custom spans in agent loop)
- **W0.5** — `query_telemetry` Cosmos container + writer
- **W0.6** — Sentry MCP wired (server + client)
- **W0.7** — Feature-flag service (LaunchDarkly or home-grown from Cosmos) — can't ship at this scale without flags
- **W0.8** — Load-testing harness (k6 or Locust) with agent-simulating scenarios

**Exit criteria:** Current app still works. Every request is traced. Every answer has a cost record. Feature-flagged rollout pipeline in place.

### Phase 1 · Semantic Catalog (6–8 weeks)

The core new capability.

- **W1.1** — New AI Search index `semantic-catalog` with schema from §3.2
- **W1.2** — `past_analysis_doc` writer: every agent turn writes one doc (reuse existing Cosmos envelope)
- **W1.3** — `semantic_catalog_search` tool — hybrid search with access-policy filter
- **W1.4** — Planner integration: retrieve catalog hits **first**, before tool selection
- **W1.5** — `glossary_doc` Git repo + sync job
- **W1.6** — `document_doc` pipeline: Blob → AI Search indexer + OCR/Entity skillsets (Nielsen PDFs as first corpus)
- **W1.7** — Admin UI: catalog health, recent additions, top retrieved, stale detection
- **W1.8** — Delete `rag-session-chunks` + deprecate session-scoped RAG once catalog retrieval is ≥ feature-parity

**Exit criteria:** Manager asks "What did Nielsen say about edible oil in Q3?" → gets grounded answer with doc citations. Manager asks a repeat question → planner retrieves past analysis, delivers answer 5× faster.

### Phase 2 · Semantic Layer + Snowflake (6–8 weeks)

The first real production data source, done right.

- **W2.1** — Cube.dev deployment (AKS or App Service)
- **W2.2** — First 20 metric definitions — core finance + sales — reviewed & signed off
- **W2.3** — `metric_doc` sync from Cube → AI Search
- **W2.4** — Snowflake adapter: connection pooling, Azure AD token exchange, RLS push-down
- **W2.5** — `semantic_layer_query` tool in agent runtime
- **W2.6** — `sandboxed_sql` tool (read-only role, cost cap, 60s timeout)
- **W2.7** — `table_doc` sync job from Snowflake INFORMATION_SCHEMA + dbt manifests
- **W2.8** — Cube pre-aggregations for top 50 expected queries
- **W2.9** — Query result cache (Redis) with version-aware invalidation

**Exit criteria:** Managers can ask canonical-metric questions without uploading anything. Answers cite canonical definitions. P95 latency < 5s on cached metrics.

### Phase 3 · Dashboard generation (4–6 weeks)

Turn chat answers into dashboards.

- **W3.1** — Dashboard spec schema (§6.1) + TypeScript types shared client+server
- **W3.2** — 5 layout templates authored + stored as `layout_doc` in AI Search
- **W3.3** — Multi-section planner: LLM emits a `Dashboard` not just a `ChartSpec`
- **W3.4** — Dashboard renderer: extend current `Dashboard/` pages for multi-section + filter bar
- **W3.5** — Provenance display: "hover any number to see the query that produced it"
- **W3.6** — Save dashboard → Cosmos; shareable URL via existing share infra
- **W3.7** — PDF export (Puppeteer)
- **W3.8** — PowerPoint export (`pptxgenjs`)
- **W3.9** — Drilldown mechanic: click a bar → new Q&A → new sub-dashboard

**Exit criteria:** Manager asks "why did Q3 sales drop in West?" → gets back a full dashboard with headline finding, regional decomposition, product-category contributor chart, time trend, and 3 drilldown prompts. Export to PPT works.

### Phase 4 · Second source: Mode (3–4 weeks)

Prove federation works with a different source type.

- **W4.1** — Mode API adapter + service-account auth
- **W4.2** — `mode_report_fetch` + `mode_report_list` tools
- **W4.3** — `dashboard_doc` sync from Mode (hourly indexer)
- **W4.4** — "Open in Mode" fallback link when full embedding is wrong

### Phase 5 · Scale, polish, feedback (6–8 weeks)

Make it actually survive 1000 concurrent users.

- **W5.1** — Load test to 1000 concurrent sessions; find + fix bottlenecks
- **W5.2** — Semantic question cache (§7.1, L1)
- **W5.3** — Thumbs-up/down UI + `successSignal` update loop
- **W5.4** — Few-shot selection: top-rated `past_analysis_doc` entries injected into planner prompt
- **W5.5** — Cost-anomaly alerting
- **W5.6** — Per-user-per-day token budget middleware
- **W5.7** — Admin dashboard: cost by team, top queries, metric health, catalog freshness
- **W5.8** — SLO definition + alerting (P95 latency, success rate, cost)

### Phase 6 · Additional sources (ongoing after Phase 5)

- **P6.A** — Azure SQL adapter (same pattern as Snowflake)
- **P6.B** — Nielsen API adapter (if they have one; otherwise rely on PDF corpus)
- **P6.C** — Internal HR/Finance/Ops REST APIs as needed
- **P6.D** — SharePoint document indexer

---

## 10 · Success metrics (how we know it worked)

| Metric | Target at 6 months |
|---|---|
| DAUs | 500+ |
| Questions answered / day | 5,000+ |
| P95 end-to-end latency | < 10s |
| Thumbs-up rate | > 70% |
| Semantic cache hit rate | > 30% |
| Canonical-metric hit rate (answers cited a metric_doc) | > 80% |
| Cost per answer (LLM + warehouse) | < ₹5 |
| Full-dashboard answers (vs. single chart) | > 40% of analytical questions |
| Time from question to shareable PPT | < 2 minutes |

---

## 11 · Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Metric definitions spiral; users fight over "net sales" definition | High | High | Governance WF with domain owners; versioned defs; "as-of" timestamps on every answer |
| LLM still hallucinates SQL in sandboxed path | Medium | Medium | Cube handles 80%; sandboxed SQL has cost cap + schema-grounded prompts; verifier checks row counts |
| Azure OpenAI rate limits at peak load | High | High | Provisioned throughput units (PTUs); multi-region failover; aggressive caching |
| Snowflake compute cost explodes | Medium | High | Cube pre-aggregations; per-user caps; query-cost pre-check; off-peak warehousing for syncs |
| AI Search index size explodes | Low | Medium | Cap `past_analysis_doc` to last 180 days; archive to Blob; deduplicate by similarity |
| RLS misconfiguration leaks data cross-team | Medium | **Catastrophic** | Unit tests that assert forbidden retrievals; pen-test pre-GA; Sentry alert on 403s |
| Catalog staleness — users get old tables | High | Medium | Nightly sync; `lastRefreshed` filter in queries; UI warns on stale results |
| Mode / Nielsen API rate limits | Medium | Low | Cache aggressively; batch where possible |
| Vendor lock-in to AI Search | Low | Low | All catalog docs have a canonical JSON representation; could rehydrate into Elastic/Typesense if ever needed (months of work, not weeks) |

---

## 12 · What NOT to build

Explicit non-goals save months.

- **Don't** use AI Search as a data warehouse. It's retrieval-only. Aggregations live in Snowflake/Cube.
- **Don't** let LLMs write raw SQL as the default path. Semantic layer first, sandboxed SQL only for long-tail.
- **Don't** build a home-grown vector DB / semantic layer / feature flag system. Buy these.
- **Don't** add real-time (sub-minute) data freshness until a manager asks for it twice. Nightly is fine for Phase 1-5.
- **Don't** support arbitrary writes to sources. Read-only for v1. "Creating a ticket from an insight" is a Phase-7+ discussion.
- **Don't** try to make every chat turn produce a dashboard. Many questions are lookup-shaped. Classify and branch.
- **Don't** skip the thumbs UI thinking "we'll add it later". Feedback is what turns Phase 5 into Phase 10.
- **Don't** let `table_doc` be auto-generated from INFORMATION_SCHEMA alone — without descriptions it's noise. Require a description from dbt manifest or equivalent.
- **Don't** over-index on GPT-4-class models for every call. Classify first; route easy classification/rewrite to smaller/cheaper models.

---

## 13 · Team and budget rough-sizing

Scope honesty: this is a **6–9 month project with a real team.**

| Role | FTEs | Reason |
|---|---|---|
| Senior full-stack engineer | 2 | Agent runtime, tool mesh, dashboard generation |
| Data engineer | 1–2 | dbt, Cube, warehouse modelling, catalog sync jobs |
| ML / prompt engineer | 1 | Planner prompts, retrieval tuning, few-shot selection |
| Frontend engineer | 1 | Dashboard generation UX, admin console, exports |
| SRE / DevOps | 0.5–1 | Observability, load testing, multi-region failover, cost controls |
| Data governance / business-metrics owner | 0.5 | Metric review WF, glossary stewardship |
| **Total** | **6–7.5 FTEs** | Plus an eng manager / PM |

Infra run-rate (rough, annual):

- Azure AI Search Standard tier (S1 with replicas): ~$6k
- Azure OpenAI PTUs: ~$60–150k depending on volume
- Snowflake compute: highly variable, ~$120k+ at this scale
- Cube Cloud or self-host on AKS: ~$30k self-host incl. infra
- Redis + Cosmos + Blob + App Service: ~$25k
- Monitoring (Azure App Insights / Grafana Cloud / Sentry): ~$15k
- **Total infra:** ~$250–350k/year

That's the honest range. Worth validating with finance before commitment.

---

## 14 · Open questions for stakeholders

These need answers before Phase 1 kicks off. I recommend a half-day architecture review workshop.

1. **Source priority** — which order do we integrate Snowflake / Mode / Azure SQL / Nielsen? Suggest Snowflake first (most analytical queries), Mode second (reuse existing dashboards), Nielsen third (documents are a different problem class).
2. **Semantic layer choice** — Cube self-hosted vs. dbt Semantic Layer. Which direction does the data team already lean?
3. **Metric ownership** — who approves a new `metric_doc`? Central data team or distributed by domain?
4. **Row-level security source of truth** — which system holds canonical "who sees what" — Azure AD groups alone, or a separate entitlements service?
5. **Mode integration depth** — full embedded viewer, metadata-only link-out, or rebuild in our renderer? Each is a different investment.
6. **PDF corpus ownership** — who adds Nielsen reports, who tags sensitivity, what's the SLA?
7. **Data freshness SLA** — is nightly OK, or do managers need same-day?
8. **Offline / export needs** — PPT as first-class or best-effort?
9. **Approval for Phase-0 overhead** — multi-tenancy, observability, feature flags add 6 weeks up front with no visible feature delivery. Yes or no?

---

## 15 · First concrete step

If this plan is accepted, the very first wave worth shipping — independent of all the above — is:

**Wave W0.0 · `past_analysis_doc` writer**

Every answer the current app produces is written to a new AI Search doc with tenantId, userId, question, normalized-question, rewritten-question, SQL/tool-calls-used, charts-generated, timestamp. No retrieval yet, no UI change. Just **start collecting the dataset** that Phase 1's semantic catalog and Phase 5's few-shot selection both depend on. Even if the full roadmap slips by 6 months, this data is gold.

One wave. ~150 LOC. Ships in a week. Starts compounding value immediately.

---

*End of plan. Amendments welcome as a diff PR against this file, per CLAUDE.md convention.*
