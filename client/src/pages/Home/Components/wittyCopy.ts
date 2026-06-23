// Shared "witty loading copy" pool — ONE place that owns the playful status
// lines shown while the app is working, organized by category (pipeline stage).
//
// Why this exists (the problem it fixes):
//   Before this module the Thinking panel mapped each server step to exactly
//   ONE hardcoded string (a `switch`), the enrichment loader owned its own
//   private arrays, and the dashboard-build ticker owned a third list. There
//   was no shared pool, so "add more lines like Enriching, and use them in
//   Thinking too" was structurally impossible. This module is the shared pool:
//   every surface resolves a stage → a CATEGORY → a bank of candidate lines.
//
// How the lines are used:
//   - A non-active step shows ONE deterministically-picked line (stable for a
//     given step instance via `pickWittyLine(category, seed)` — seed is the
//     step's timestamp — so it does not flicker on re-render but DOES vary
//     across turns).
//   - The currently-active step (and the enrichment / dashboard-build phases)
//     ROTATE through the whole category bank via `useRotatingMessage`, so a
//     long wait surfaces many of these lines.
//
// Style contract (keep new lines in register):
//   - one short status, <= ~60 chars, ellipsis by default
//   - plausibly true at ANY instant during that stage (rotation is time-based
//     and order-shuffled) — so NO finality / "almost done" / "saving now"
//   - witty, warm, classy; light FMCG / haircare flavor on a MINORITY of lines
//   - present-progressive voice; grounded in what that stage actually does
//
// Mirrors + absorbs the ROTATING_GENERIC pattern (DatasetEnrichmentLoader) and
// the DASHBOARD_BUILD_MESSAGES bank (imported below as the `dashboard` bucket).

import type { EnrichmentStep } from "@/lib/api/uploadStatus";
import { DASHBOARD_BUILD_MESSAGES } from "./dashboardBuildMessages";

export type WittyCategory =
  // Thinking / agent-loop stages
  | "columns"
  | "intent"
  | "queryType"
  | "loading"
  | "hypotheses"
  | "brief"
  | "preplanner"
  | "context"
  | "plan"
  | "planning"
  | "tool"
  | "synthesis"
  | "review"
  | "dashboard"
  // Dataset-enrichment stages
  | "profile"
  | "dates"
  | "buildingContext"
  | "persisting"
  // Catch-all
  | "generic";

// Reading the schema — column names, types, roles, headers.
const COLUMNS: readonly string[] = [
  "Eyeballing the columns…",
  "Reading the column headers…",
  "Sizing up what each field holds…",
  "Sorting dimensions from measures…",
  "Working out which columns are numbers…",
  "Spotting the date columns…",
  "Mapping each field to its role…",
  "Noting which columns are categories…",
  "Checking the shape of the table…",
  "Tracing how the columns relate…",
  "Picking out the identifier columns…",
  "Telling the labels from the values…",
  "Scanning for the metrics that matter…",
  "Getting the lay of the schema…",
  "Cataloguing every column in play…",
  "Reading the grain of each field…",
  "Lining up the columns side by side…",
  "Working out units and types…",
  "Flagging the columns worth charting…",
  "Pairing names with their data types…",
  "Skimming the header row for clues…",
  "Sorting the signal columns from the noise…",
  "Untangling which fields drive the rest…",
  "Counting the dimensions on offer…",
  "Marking the columns I'll lean on…",
  "Building a mental map of the fields…",
  "Recognising the usual suspects in the schema…",
  "Pinning down what's measurable here…",
  "Surveying the columns end to end…",
  "Reading the table like a contents page…",
];

// Understanding what the user actually asked.
const INTENT: readonly string[] = [
  "Decoding what you actually meant…",
  "Reading between the lines of your ask…",
  "Working out what you're really after…",
  "Pinning down the real question…",
  "Translating the ask into something measurable…",
  "Catching the intent behind the words…",
  "Making sure I heard you right…",
  "Teasing out exactly what you want to know…",
  "Mapping your words onto the data…",
  "Clarifying the question in my head…",
  "Figuring out what 'good' looks like here…",
  "Spotting the metric you care about…",
  "Reading the brief between your lines…",
  "Nailing down the unit of the answer…",
  "Separating the must-know from the nice-to-know…",
  "Listening for what you didn't say…",
  "Anchoring on the outcome you're chasing…",
  "Working out which slice you mean…",
  "Turning the phrasing into a precise ask…",
  "Checking I'm answering YOUR question…",
  "Holding your intent front and centre…",
  "Reading the question the way you meant it…",
  "Distilling the ask to its core…",
  "Lining up the question with the columns…",
  "Pinpointing what would actually help…",
  "Sketching the answer you're hoping for…",
  "Getting crisp on the real objective…",
  "Parsing the ask, not just the words…",
];

// Classifying the question — trend? comparison? ranking? lookup?
const QUERY_TYPE: readonly string[] = [
  "Sussing out the angle here…",
  "Working out what kind of question this is…",
  "Trend, comparison, or ranking? Deciding…",
  "Reading the shape of the question…",
  "Sorting this into the right kind of analysis…",
  "Is this a 'who', a 'how much', or a 'why'?…",
  "Sizing up whether time matters here…",
  "Deciding if this is a leaderboard moment…",
  "Working out the natural frame for this…",
  "Spotting whether we need a breakdown…",
  "Judging if this wants a chart or a number…",
  "Classifying the ask before I commit…",
  "Choosing the lens that fits the question…",
  "Telling apart 'compare' from 'track'…",
  "Reading whether this is one slice or many…",
  "Deciding the right altitude for the answer…",
  "Working out if a trend is hiding in here…",
  "Naming the question type out loud…",
  "Sizing the answer: headline or deep dive…",
  "Sniffing out whether segments matter…",
  "Picking the family this question belongs to…",
  "Weighing a single number against a spread…",
  "Reading the question's centre of gravity…",
  "Deciding what would actually settle this…",
  "Framing it the way an analyst would…",
  "Working out the cut that answers it cleanly…",
];

// Opening the dataset, reading rows into the engine.
const LOADING: readonly string[] = [
  "Cracking open the dataset…",
  "Pulling the rows into memory…",
  "Loading the table up…",
  "Warming up the data engine…",
  "Fetching the numbers we'll need…",
  "Opening the dataset for a closer look…",
  "Lining the rows up to query…",
  "Bringing the data to the table…",
  "Spinning up the query engine…",
  "Reading the rows in…",
  "Getting the dataset within reach…",
  "Staging the data for analysis…",
  "Loading the cells we care about…",
  "Wheeling the dataset into position…",
  "Priming the columns for crunching…",
  "Drawing the data into the workspace…",
  "Caching the rows for fast access…",
  "Unpacking the table row by row…",
  "Getting the full picture loaded…",
  "Settling the data into the engine…",
  "Pointing the engine at your data…",
  "Making the rows ready to question…",
  "Tuning up DuckDB for the run…",
  "Laying the dataset out to work on…",
  "Loading every row that counts…",
  "Threading the data into place…",
  "Opening the workbook of numbers…",
];

// Forming theories about what the data might show.
const HYPOTHESES: readonly string[] = [
  "Floating a few theories…",
  "Sketching what the answer might be…",
  "Lining up some hunches to test…",
  "Imagining where the story could go…",
  "Guessing where the interesting bits hide…",
  "Drafting a couple of educated guesses…",
  "Thinking about what could be driving this…",
  "Pencilling in some likely explanations…",
  "Brainstorming what the data might reveal…",
  "Setting up theories worth checking…",
  "Wondering which factors are in play…",
  "Mapping out the plausible answers…",
  "Picturing the patterns we might find…",
  "Naming the suspects before the chase…",
  "Forming a view I'll happily revise…",
  "Casting a few hypotheses to reel in…",
  "Considering what would surprise us…",
  "Weighing what's likely against what's loud…",
  "Outlining the angles worth a look…",
  "Putting up some ideas to knock down…",
  "Anticipating where the numbers will point…",
  "Guessing the shape of the finding…",
  "Lining up rivals for the best explanation…",
  "Hypothesising before I verify…",
  "Imagining the headline before I earn it…",
  "Sketching the theory of the case…",
];

// Drafting the analysis brief / case file.
const BRIEF: readonly string[] = [
  "Drawing up the case file…",
  "Writing the brief for this one…",
  "Outlining how I'll tackle it…",
  "Putting the analysis plan on paper…",
  "Framing the problem properly first…",
  "Jotting down what success looks like…",
  "Scoping the questions worth chasing…",
  "Laying out the brief, step by step…",
  "Setting the terms of the investigation…",
  "Drafting the to-do for this answer…",
  "Sketching the structure of the analysis…",
  "Noting what I need to prove…",
  "Pinning the brief to the wall…",
  "Spelling out the angle of attack…",
  "Tightening the scope before I dig…",
  "Writing down the open questions…",
  "Marking the milestones for this answer…",
  "Turning the ask into a work plan…",
  "Briefing myself like a fresh analyst…",
  "Mapping the route from question to answer…",
  "Penning the agenda for the dig…",
  "Listing what would make this airtight…",
  "Setting up the case before the evidence…",
  "Committing the plan to memory…",
];

// Pre-planner scoping the investigation.
const PREPLANNER: readonly string[] = [
  "Casing the data before I dig in…",
  "Scoping the dig before the first cut…",
  "Working out where to point the shovel…",
  "Surveying the ground before digging…",
  "Plotting which trails to follow…",
  "Sizing up the investigation ahead…",
  "Scanning for the richest seams to mine…",
  "Deciding which threads to pull first…",
  "Mapping the terrain before the trek…",
  "Picking the leads worth chasing…",
  "Reading the room before I commit…",
  "Triaging the angles by payoff…",
  "Sketching the investigation's first moves…",
  "Working out the cheapest path to proof…",
  "Lining up the questions in order…",
  "Choosing where the dig pays off most…",
  "Scouting the data for fast wins…",
  "Pre-flighting the investigation…",
  "Setting waypoints for the dig…",
  "Weighing which cuts to make first…",
  "Reconnoitring before the deep dive…",
  "Marking the spots most likely to talk…",
  "Drawing the map I'll dig against…",
  "Sequencing the investigation sensibly…",
];

// Recalling prior conversation / session memory.
const CONTEXT: readonly string[] = [
  "Flipping back through our chat…",
  "Remembering what we already covered…",
  "Recalling the thread of our conversation…",
  "Pulling up what you told me earlier…",
  "Leafing through the session so far…",
  "Picking up where we left off…",
  "Checking what we've already established…",
  "Reminding myself of the back-story…",
  "Retracing our earlier steps…",
  "Loading the memory of this session…",
  "Re-reading the notes from before…",
  "Catching up on our history together…",
  "Threading this answer to the last one…",
  "Recalling the numbers we already pulled…",
  "Stitching this to what came before…",
  "Reviewing the context we've built up…",
  "Dusting off the earlier findings…",
  "Holding the conversation in mind…",
  "Lining this up with prior answers…",
  "Refreshing my memory of your data…",
  "Reading back the durable context…",
  "Connecting the dots from earlier…",
  "Keeping continuity with our last turn…",
  "Remembering the shape of your dataset…",
  "Bringing prior context to bear…",
];

// Laying out the agent's route / step list.
const PLAN: readonly string[] = [
  "Plotting the route…",
  "Charting the steps from here…",
  "Laying out the path to the answer…",
  "Drawing the map for this run…",
  "Sequencing the moves ahead…",
  "Routing through the data smartly…",
  "Picking the order of operations…",
  "Sketching the itinerary…",
  "Setting the waypoints for this answer…",
  "Choosing which tools to call, in order…",
  "Mapping each hop to the next…",
  "Planning the journey through the numbers…",
  "Pencilling the route on the map…",
  "Deciding the first move and the next…",
  "Threading the steps into a plan…",
  "Lining the dominoes up…",
  "Working out the shortest honest path…",
  "Drafting the play-by-play…",
  "Arranging the steps in sequence…",
  "Charting a course through the dataset…",
  "Marking the turns on the way to the answer…",
  "Setting the running order…",
  "Plotting tool by tool…",
  "Drawing the line from here to done…",
];

// Choosing the sharpest approach.
const PLANNING: readonly string[] = [
  "Picking the sharpest angle of attack…",
  "Choosing the cleanest way in…",
  "Weighing the cleanest cut…",
  "Deciding the smartest approach…",
  "Finding the line that answers it fastest…",
  "Settling on the right method…",
  "Picking the cut that tells the truth…",
  "Choosing between a few good approaches…",
  "Going with the angle that pays off…",
  "Locking in the plan of attack…",
  "Selecting the lens that fits best…",
  "Trading thoroughness against speed…",
  "Reaching for the right tool for this…",
  "Deciding which slice answers cleanest…",
  "Choosing rigour over flash…",
  "Honing in on the decisive cut…",
  "Backing the approach most likely to hold…",
  "Committing to the sharpest line…",
  "Weighing breadth against depth here…",
  "Settling the strategy before the work…",
  "Picking the path of least hand-waving…",
  "Choosing the move that earns its keep…",
  "Zeroing in on the winning angle…",
  "Deciding how deep this one warrants…",
  "Going for the cut that decides it…",
  "Aiming at the heart of the question…",
  "Calling the approach and committing…",
];

// Running tools — queries, computations, number-crunching.
const TOOL: readonly string[] = [
  "Crunching the numbers…",
  "Running the query…",
  "Doing the arithmetic…",
  "Putting the data through its paces…",
  "Asking the dataset directly…",
  "Tallying the totals…",
  "Slicing the data the way we planned…",
  "Letting the engine do the heavy lifting…",
  "Aggregating across the rows…",
  "Computing the figures that matter…",
  "Running the math on every row…",
  "Pulling the exact numbers…",
  "Grouping and counting…",
  "Putting the query to work…",
  "Measuring what we set out to measure…",
  "Working the calculator hard…",
  "Summing, averaging, ranking…",
  "Sending the question to DuckDB…",
  "Turning rows into an answer…",
  "Counting carefully, twice…",
  "Rolling the data up…",
  "Filtering down to what counts…",
  "Calculating with the real values…",
  "Chasing the numbers to ground…",
  "Letting the figures speak…",
  "Running the cut we committed to…",
  "Doing the sums so you don't have to…",
  "Squeezing the answer out of the data…",
];

// Writing the answer / stitching findings together.
const SYNTHESIS: readonly string[] = [
  "Stitching it all together…",
  "Writing up what the numbers say…",
  "Turning findings into an answer…",
  "Composing the takeaway…",
  "Weaving the threads into a story…",
  "Pulling the pieces into one answer…",
  "Putting the finding into plain words…",
  "Shaping the numbers into a narrative…",
  "Drafting the headline and the why…",
  "Boiling it down to what matters…",
  "Translating the data into a decision…",
  "Lining up the evidence behind the claim…",
  "Setting the answer in order…",
  "Sharpening the takeaway to a point…",
  "Joining the dots into a conclusion…",
  "Framing the so-what clearly…",
  "Wording the answer with care…",
  "Bringing the strands together…",
  "Distilling the run into a result…",
  "Writing the answer you can act on…",
  "Tightening the prose around the proof…",
  "Building the case for the conclusion…",
  "Rendering numbers into meaning…",
  "Putting a bow on the findings…",
  "Saying it plainly, backed by data…",
  "Assembling the final read…",
  "Closing the loop from question to answer…",
];

// Reviewing / verifying its own answer.
const REVIEW: readonly string[] = [
  "Marking my own homework…",
  "Double-checking the figures…",
  "Sanity-checking the conclusion…",
  "Reading it back with a critic's eye…",
  "Making sure the math holds…",
  "Stress-testing the claim…",
  "Looking for holes before you do…",
  "Verifying the numbers add up…",
  "Re-reading for anything off…",
  "Checking the answer against the ask…",
  "Auditing my own working…",
  "Making sure I didn't overreach…",
  "Confirming the caveats are honest…",
  "Pressure-testing the takeaway…",
  "Catching mistakes before they ship…",
  "Cross-checking the totals…",
  "Asking 'would this survive scrutiny?'…",
  "Trimming any claim I can't back…",
  "Validating before I hand it over…",
  "Giving it one last careful look…",
  "Checking the story matches the data…",
  "Making sure it's right, not just neat…",
  "Holding the answer to a high bar…",
  "Reviewing for accuracy and fairness…",
  "Proofing the logic end to end…",
  "Tightening anything that wobbles…",
];

// Dataset enrichment — inferring column profile / roles.
const PROFILE: readonly string[] = [
  "Reading the shape and intent of your dataset…",
  "Inferring roles for each column…",
  "Naming patterns the way a careful analyst would…",
  "Working out what every field represents…",
  "Sorting the measures from the labels…",
  "Learning the grammar of your data…",
  "Profiling each column's character…",
  "Spotting IDs, dates, and amounts…",
  "Getting to know your columns…",
  "Inferring units and types as I go…",
  "Reading the dataset like a first chapter…",
  "Tagging which columns are categories…",
  "Sizing up the cardinality of each field…",
  "Mapping the roles your columns play…",
  "Learning what 'normal' looks like here…",
  "Sketching a profile of your data…",
  "Recognising the metrics worth tracking…",
  "Telling apart keys from values…",
  "Reading the intent baked into the columns…",
  "Quietly cataloguing every field…",
  "Building a portrait of your dataset…",
  "Working out the natural grain of the data…",
];

// Dataset enrichment — cleaning date-like strings.
const DATES: readonly string[] = [
  "Cleaning date-like strings into stable signals…",
  "Resolving ambiguous date formats…",
  "Normalising calendar values for reliable trends…",
  "Untangling the date columns…",
  "Teaching the dates a single format…",
  "Sorting day-month from month-day…",
  "Parsing timestamps into something solid…",
  "Straightening out the calendar…",
  "Making every date speak the same language…",
  "Pinning down the time grain…",
  "Repairing messy date entries…",
  "Aligning dates onto a clean timeline…",
  "Reading dates the way you intended…",
  "Standardising the time signals…",
  "Coaxing order out of the date strings…",
  "Decoding the date formats in play…",
  "Setting the clock straight across rows…",
  "Turning scattered dates into a series…",
  "Smoothing the calendar for trend work…",
  "Catching the off-format dates…",
  "Building a dependable time axis…",
  "Getting the dates trend-ready…",
];

// Dataset enrichment — building durable context.
const BUILDING_CONTEXT: readonly string[] = [
  "Seeding durable context so future answers stay grounded…",
  "Teaching the assistant your domain…",
  "Weaving profile and summary into durable context…",
  "Writing down what makes your data tick…",
  "Building memory that survives the session…",
  "Laying foundations for sharper answers…",
  "Encoding the context you'll lean on later…",
  "Briefing the assistant on your world…",
  "Storing the domain knowledge for reuse…",
  "Capturing the why behind your numbers…",
  "Setting up context that pays off downstream…",
  "Grounding future answers in your data…",
  "Banking the understanding we just built…",
  "Knitting the pieces into durable memory…",
  "Preparing the assistant to know your data…",
  "Composing the context layer…",
  "Locking in what we've learned so far…",
  "Making the dataset's story durable…",
  "Wiring the domain knowledge in…",
  "Seeding hints for better questions ahead…",
  "Building the brain behind your answers…",
  "Saving the shape of your data for later…",
];

// Dataset enrichment — persisting to storage.
const PERSISTING: readonly string[] = [
  "Writing insights to your session…",
  "Finalising storage and suggested questions…",
  "Crossing the last mile — persistence, not theatre…",
  "Tucking the findings away safely…",
  "Committing the understanding to storage…",
  "Saving the groundwork for next time…",
  "Filing everything where it belongs…",
  "Locking the insights into your session…",
  "Putting the finishing touches in storage…",
  "Recording the enrichment for keeps…",
  "Stowing the suggested questions…",
  "Making the work durable…",
  "Sealing the understanding in…",
  "Persisting the profile and summary…",
  "Saving so nothing is lost…",
  "Writing the last of it down…",
  "Setting the session up for fast answers…",
  "Banking the results…",
  "Cementing what we learned…",
  "Handing the insights to durable storage…",
  "Wrapping the enrichment up cleanly…",
  "Storing the keys to your data…",
];

// Generic catch-all — neutral "working" lines that fit any unmapped stage.
const GENERIC: readonly string[] = [
  "Working some magic…",
  "Thinking it through…",
  "Putting the pieces together…",
  "On it…",
  "Chewing on this…",
  "Lining things up…",
  "Getting into the detail…",
  "Mulling it over…",
  "Doing the careful bit…",
  "Turning this over in my head…",
  "Keeping the gears turning…",
  "Making steady progress…",
  "Sorting out the next move…",
  "Quietly getting on with it…",
  "Joining the dots…",
  "Tidying up the thinking…",
  "Following the thread…",
  "Working through it methodically…",
  "Holding the question in focus…",
  "Edging toward the answer…",
  "Doing right by your question…",
  "Giving it proper attention…",
  "Threading the needle…",
  "Keeping it honest and careful…",
  "Closing in on it…",
  "Weighing it carefully…",
  "Staying with the problem…",
  "Letting the logic settle…",
  "Building toward the answer…",
  "Minding the details…",
  "Squaring things away…",
  "Taking the sensible next step…",
  "Reasoning it out…",
  "Putting in the quiet work…",
  "Lining up a clean answer…",
  "Bringing it home…",
  "Making it make sense…",
  "Working steadily toward done…",
  "Keeping things moving…",
  "Doing the thinking so it lands right…",
];

export const WITTY_POOLS: Record<WittyCategory, readonly string[]> = {
  columns: COLUMNS,
  intent: INTENT,
  queryType: QUERY_TYPE,
  loading: LOADING,
  hypotheses: HYPOTHESES,
  brief: BRIEF,
  preplanner: PREPLANNER,
  context: CONTEXT,
  plan: PLAN,
  planning: PLANNING,
  tool: TOOL,
  synthesis: SYNTHESIS,
  review: REVIEW,
  dashboard: DASHBOARD_BUILD_MESSAGES,
  profile: PROFILE,
  dates: DATES,
  buildingContext: BUILDING_CONTEXT,
  persisting: PERSISTING,
  generic: GENERIC,
};

/** The server step the agent loop emits to bracket the long dashboard build. */
export const DASHBOARD_BUILDING_STEP = "Building dashboard";

/**
 * Resolve a raw server thinking-step key to a witty category. Ports the old
 * 1:1 `wittyLabelFor` switch (ThinkingPanel) but returns a CATEGORY so the
 * panel can pick from a bank instead of a single string. Unknown steps fall
 * back to `generic` — same behaviour as the old default label.
 */
export function categoryForThinkingStep(rawStep: string): WittyCategory {
  const step = rawStep.trim();
  if (/^Running tool:/i.test(step)) return "tool";
  switch (step) {
    case DASHBOARD_BUILDING_STEP:
      return "dashboard";
    case "Mapping columns from schema":
      return "columns";
    case "Analyzing user intent":
      return "intent";
    case "Detecting query type":
      return "queryType";
    case "Loading dataset":
      return "loading";
    case "Generating hypotheses":
      return "hypotheses";
    case "Drafting analysis brief & hypotheses":
      return "brief";
    case "Running investigation pre-planner":
      return "preplanner";
    case "Retrieving session context":
      return "context";
    case "Agent plan":
      return "plan";
    case "Planning approach":
      return "planning";
    case "Synthesizing answer":
      return "synthesis";
    case "Reviewing answer":
      return "review";
    default:
      return "generic";
  }
}

/** Resolve a dataset-enrichment step to its witty category. */
export function categoryForEnrichmentStep(step: EnrichmentStep): WittyCategory {
  switch (step) {
    case "inferring_profile":
      return "profile";
    case "dirty_date_enrichment":
      return "dates";
    case "building_context":
      return "buildingContext";
    case "persisting":
      return "persisting";
    default:
      return "generic";
  }
}

/** The full bank of candidate lines for a category (used for rotation). */
export function wittyPoolFor(category: WittyCategory): readonly string[] {
  const pool = WITTY_POOLS[category];
  return pool && pool.length > 0 ? pool : GENERIC;
}

// Integer hash (32-bit avalanche) — deterministic, so a given seed always maps
// to the same line (no flicker on re-render) while different seeds spread well.
function hashInt(n: number): number {
  let h = Math.trunc(n) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Deterministically pick one line from a category's bank, keyed by `seed`
 * (the step's timestamp). Stable for a given (category, seed) pair across
 * re-renders, but varies across turns because the timestamp changes.
 */
export function pickWittyLine(category: WittyCategory, seed: number): string {
  const pool = wittyPoolFor(category);
  const idx = hashInt(seed) % pool.length;
  return pool[idx] ?? pool[0]!;
}

/** A start index into a category's bank, derived from a seed (for rotation). */
export function startIndexFor(category: WittyCategory, seed: number): number {
  return hashInt(seed >>> 1) % wittyPoolFor(category).length;
}
