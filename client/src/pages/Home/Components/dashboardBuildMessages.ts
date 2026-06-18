// Witty status lines shown while a dashboard is being assembled.
//
// After the answer narrative streams, an explicit dashboard ask kicks off a
// long, previously-silent phase on the server — the visual planner proposes
// supporting charts, a feature sweep fills coverage gaps across every
// dimension, best/worst leaderboards are computed, a flagship model writes the
// executive summary, KPIs and the grid are laid out, and the spec is persisted.
// That ~1 minute used to sit under a frozen "Synthesizing answer" pill. The
// server now brackets the whole phase with one "Building dashboard" thinking
// step; ThinkingPanel turns that pill into a rotating banner that cycles these
// lines (via useRotatingMessage) so the user always knows the dashboard is
// under construction — and roughly what we're doing.
//
// Style contract (keep new lines in register):
//   - one short status, <= ~58 chars, ellipsis by default
//   - plausibly true at ANY instant during assembly (rotation is time-based and
//     shown in random order) — so NO finality / "almost done" / "saving now"
//   - witty, warm, classy; light FMCG/haircare flavor on a minority of lines
//   - grounded in a real sub-stage (chart selection, dimension sweep, best/worst
//     leaders, time-axis grain, KPI strip, executive summary, grid layout)
//
// Generated + adversarially curated; mirrors the ROTATING_GENERIC pattern in
// DatasetEnrichmentLoader.tsx.

export const DASHBOARD_BUILD_MESSAGES: readonly string[] = [
  "Crunching the math behind every candidate chart…",
  "Weighing which charts actually earn their pixels…",
  "Sorting the marquee numbers from the nice-to-knows…",
  "Auditioning grains for the time axis…",
  "Translating the data into a decision…",
  "Asking which angle deserves its own chart…",
  "Cross-checking every slice for blind spots…",
  "Boiling the deck down to one clean takeaway…",
  "Casting the hero tile for the front row…",
  "Hunting for the dimension nobody charted yet…",
  "Sussing out where the sheen has slipped…",
  "Sorting the heroes from the hangers-on…",
  "Trading jargon for plain, useful English…",
  "Pinning a 'look here' on the shaky numbers…",
  "Deciding what leads and what plays backup…",
  "Pacing the aisles of the data for empty shelves…",
  "Distilling the so-what for a busy desk…",
  "Curating the chart lineup, no filler allowed…",
  "Letting the boldest metric claim the spotlight…",
  "Testing whether daily detail is noise or news…",
  "Composing the headline that earns the room…",
  "Drawing red circles round the danger zones…",
  "Sizing up which trends want a second look…",
  "Squinting at the calendar to call the grain…",
  "Ranking tiles by who carries the brand story…",
  "Flagging a few things worth a second look…",
  "Pitting chart against chart for the headline slot…",
  "Building each chart spec and running its numbers…",
  "Curating the takeaway a CMO would quote…",
  "Frisking each dimension for a missing breakdown…",
  "Pitting top performers against the bottom rung…",
  "Weighing day, week, or month for the trend…",
  "Arranging the so-what above the fold…",
  "Spotting where market share is leaking…",
  "Putting the punchline where eyes land first…",
  "Shortlisting plots before any make the cut…",
  "Lining up tiles by who shouts loudest…",
  "Picking the metrics that earn the front row…",
  "Sniffing out the quiet trouble in the ranks…",
  "Sweeping the data for under-covered corners…",
  "Reaching for the KPIs that move the boardroom…",
  "Picking the front-runners off each dimension…",
  "Tuning the time axis so the trend breathes…",
  "Sorting the vanity metrics from the vital ones…",
  "Cutting the fluff so the signal sings…",
  "Auditing coverage across channel and cluster…",
  "Trimming the chart roster to the ones that sing…",
  "Circling the figures that don't sit right…",
  "Crowning the winners, naming the laggards…",
  "Making the case in the language of the boardroom…",
  "Scouting for the tile worthy of top billing…",
  "Stress-testing coverage before a tile gets drawn…",
  "Phrasing it the way a sharp analyst would…",
  "Letting the date range pick the grain…",
  "Raising an eyebrow at the odd outlier…",
  "Pairing each chart with the data that backs it…",
  "Sizing up which KPIs deserve the spotlight…",
  "Deciding if this story reads better by week…",
  "Marking the soft spots before they bite…",
  "Sorting the shelf-stars from the shelf-warmers…",
  "Weighing every SKU on its own merits…",
  "Combing the categoricals so nothing hides…",
  "Arranging the numbers a CEO reads first…",
  "Drafting supporting visuals on spec…",
  "Saying more with fewer, sharper words…",
  "Lining up champions against the also-rans…",
  "Keeping a wary eye on the wobbly bits…",
  "Letting the visual planner pitch its ideas…",
  "Matching the grain to the span on hand…",
  "Counting the buckets before I draw the axis…",
  "Putting the underperformers on notice…",
  "Smoothing the trend to the right cadence…",
  "Stacking the top-line KPIs shoulder to shoulder…",
  "Sketching specs while the numbers come to a boil…",
  "Building the leaderboard, top to bottom…",
  "Scanning for the gap between shown and known…",
  "Pricing out which segments deserve a panel…",
  "Sizing up who's pulling their weight…",
  "Pinning market share to the headline row…",
  "Choosing which sheen of the data leads the room…",
  "Asking the data: month, or are we going weekly…",
  "Drafting the top-of-dashboard narrative…",
  "Turning numbers into a clean narrative…",
  "Asking what the brand-by-channel cut might reveal…",
  "Drawing up the supporting cast of visuals…",
  "Shaping the story before the charts pile in…",
  "Making sure no SKU slips through the cracks…",
  "Choosing words that brief without boring…",
  "Auditioning charts for a supporting role…",
  "Roll-calling every category for absentees…",
  "Honing the opener that sets the whole tone…",
  "Picking the figure that belongs on the shelf edge…",
  "Settling who anchors the board and who supports…",
  "Giving the market story a manager-friendly voice…",
  "Weighing which insight leads the summary…",
  "Framing the brief for a thirty-second read…",
  "Laying out the grid, square by square…",
  "Balancing the panels left to right…",
  "Drawing the scaffolding for your view…",
  "Giving each chart room to breathe…",
];
