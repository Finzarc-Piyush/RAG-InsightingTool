---
id: kpi-and-metric-glossary
title: FMCG KPI and Metric Glossary
category: glossary
priority: 12
enabledByDefault: true
version: 2026-04-26
---

This is a glossary of the metrics and acronyms most commonly used in Marico's analytical workflow. When a user question uses one of these terms, treat the meaning here as authoritative for column / dimension matching.

## Sales / revenue metrics

- **GSV (Gross Sales Value)** — invoice value before trade schemes, rebates and discounts.
- **NSV (Net Sales Value)** — GSV minus trade schemes, rebates, returns. The line that hits the P&L as revenue.
- **Sell-in** / **Primary sales** — sales from manufacturer to distributor / wholesaler. Reported revenue typically reflects sell-in.
- **Sell-out** / **Secondary sales** — sales from distributor / retailer to consumer. The truer demand signal; usually tracked via retail audits and direct distribution data.
- **IMS (In-Market Sales)** — sell-out captured from the market, tracked via panel data (Nielsen, Kantar, GfK) and direct retail data.
- **Channel inventory** — stock held in trade between sell-in and sell-out. A growing inventory gap means primary is running ahead of secondary.

## Share / distribution metrics

- **Value market share** — a brand's share of category value in the measured market.
- **Volume market share** — a brand's share of category volume; may diverge from value share when price points differ across players.
- **ND (Numeric Distribution)** — the percentage of all relevant retail outlets that stock the brand or SKU. Reach metric.
- **WD (Weighted Distribution)** — percentage of category sales accounted for by outlets that stock the brand. Quality-of-distribution metric.
- **Throughput per outlet** — average sale per stocking outlet; combines productivity and demand.
- **Range Selling** — number of distinct SKUs stocked per outlet; matters for new-SKU launches.

## Marketing and trade metrics

- **A&P (Advertising and Promotion)** — total marketing spend; usually expressed as a percentage of NSV.
- **A&P intensity** — A&P / NSV ratio. Higher in years of new launches or category investment.
- **Trade scheme cost** — discounts and incentives paid to trade (distributor / retailer); the gap between GSV and NSV on the trade side.
- **Consumer promotion cost** — discounts to the consumer (price-off, BOGO, free SKU); often tracked separately from trade scheme.
- **CAC (Customer Acquisition Cost)** — D2C / digital metric: marketing spend per new acquired customer.
- **AOV (Average Order Value)** — D2C / e-com metric: average value per order.
- **Repeat rate** — D2C metric: percentage of customers who order a second time.

## Operations and supply metrics

- **OTIF (On Time In Full)** — percentage of orders fulfilled on time and in full quantity.
- **Service level** — broader fill-rate metric.
- **Days of cover / DOH (Days On Hand)** — finished-goods inventory expressed in days of forward sales.

## Time references

- **MAT (Moving Annual Total)** — trailing twelve months. A standard FMCG smoothing convention.
- **YTD (Year To Date)** — sales since fiscal year start.
- **L4W (Last 4 Weeks)** — high-frequency trend metric, common in retail audits.
- **YoY (Year on Year)** — same period vs. prior year, the default growth comparison.

## Finance waterfall and margin identities

The P&L flows top-to-bottom; each line is **defined** in terms of the ones above it. These are accounting identities, not relationships to be "discovered".

- **GSV → NSV/NR**: `NSV = GSV − trade schemes − returns − taxes`. (NR / Net Revenue ≈ NSV in FMCG.)
- **NSV → Gross Contribution (GC)**: `GC = NR − COGS` (sometimes less variable selling). COGS = raw material (RM) + packaging material (PM) + conversion cost.
- **GC → EBITDA**: `EBITDA = GC − A&P − overheads`.
- **Realisation / value identity**: `value = volume × price (realisation/ASP)`.

Margin ratios (all NON-additive — never summed across channels/brands/periods; aggregate by recomputing from the parts or weighting by the denominator):

- **GC% (Gross Contribution margin)** = `GC / NR` = `1 − COGS/NR`.
- **Gross Margin %** = `Gross Profit / NR`. **EBITDA %** = `EBITDA / NR`. **A&P intensity** = `A&P / NSV`. **Trade spend %** = `trade spend / GSV`.

## Definitional relationships are not insights

A **denominator is not a driver of its own ratio**, and a **component is not a cause of its aggregate**. These pairs move together *by construction*, so a correlation between them is a tautology, never an insight:

- GC% ↔ Net Revenue, GC% ↔ COGS, GC% ↔ GC; Gross Margin % ↔ COGS; EBITDA % ↔ EBITDA/NR; trade % ↔ GSV; A&P % ↔ NSV.
- A total ↔ its parts: NR ↔ GSV / trade; GC ↔ NR / COGS; EBITDA ↔ GC / A&P; total NR ↔ a single channel's NR.
- value ↔ volume × price.

NEVER report "GC% is impacted by / driven by Net Revenue" — NR is GC%'s denominator. The **legitimate** version is a *decomposition*: "rising COGS compressed GC% by N pts" attributes the margin move to a cause and quantifies it — that is actionable, not a tautology. And a correlation between two metrics that are NOT in the same identity (e.g. A&P spend vs. volume growth) is an **association** to validate, not a proven cause — only call it a driver with decomposition, lead-lag, controlled-comparison, or a cited mechanism behind it.

## Patterns to keep in mind

- "Growth" without a value/volume qualifier is ambiguous — always pin it down before drawing conclusions.
- A widening gap between sell-in and sell-out is a leading indicator of upcoming inventory correction at the manufacturer.
- ND and WD together tell a richer story than either alone; high ND with low WD means the brand is in many small outlets.
