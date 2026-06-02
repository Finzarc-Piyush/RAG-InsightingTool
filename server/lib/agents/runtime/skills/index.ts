/**
 * ============================================================================
 * index.ts — public entry point for the skills subsystem
 * ============================================================================
 * WHAT THIS FILE DOES
 *   This is the one file the rest of the app imports to "turn on" skills. It
 *   does two jobs: (1) re-exports the registry helpers and types so callers
 *   have a single import surface, and (2) runs side-effect imports of each
 *   built-in skill module. Each skill module calls registerSkill(...) at the
 *   moment it loads, so importing this index is what actually populates the
 *   skill registry. ("Side-effect import" = importing a file purely to run its
 *   top-level code, not to use a named export.)
 *
 * WHY IT MATTERS
 *   Without importing this file, no skills exist and the planner sees an empty
 *   manifest. The import ORDER and structure here are deliberate: only this
 *   index imports the skill modules, so the module graph stays a tree rather
 *   than a cycle. A cycle here previously caused a temporal-dead-zone (TDZ)
 *   "cannot access before initialization" crash across the skill test suite.
 *
 * KEY PIECES
 *   - Re-exports types (AnalysisSkill, SkillInvocation) and feature-flag
 *     helpers (isDeepAnalysisSkillsEnabled, skillAllowlist) from ./types.js.
 *   - Re-exports the registry API (registerSkill, listRegisteredSkills,
 *     formatSkillsManifestForPlanner, selectSkill, expandSkill) from
 *     ./registry.js.
 *   - Side-effect imports of the five built-in skills, which self-register.
 *
 * HOW IT CONNECTS
 *   Imported by the agent runtime / planner. Pulls in registry.ts, types.ts,
 *   and every skill file (varianceDecomposer, driverDiscovery, insightExplorer,
 *   timeWindowDiff, growthAnalysis).
 */
export type { AnalysisSkill, SkillInvocation } from "./types.js";
export {
  isDeepAnalysisSkillsEnabled,
  skillAllowlist,
} from "./types.js";
export {
  registerSkill,
  listRegisteredSkills,
  formatSkillsManifestForPlanner,
  selectSkill,
  expandSkill,
} from "./registry.js";

// Auto-register the built-in skills on first import. Each module calls
// `registerSkill(...)` at load time against `./registry.js`.
import "./varianceDecomposer.js";
import "./driverDiscovery.js";
import "./insightExplorer.js";
import "./timeWindowDiff.js";
import "./growthAnalysis.js";
