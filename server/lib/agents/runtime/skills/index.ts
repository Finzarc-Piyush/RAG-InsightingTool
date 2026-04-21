/**
 * Skills index — re-exports the registry primitives from
 * `./registry.js` and runs the side-effect imports that auto-register
 * every built-in skill at module load.
 *
 * The separation matters: skills `import { registerSkill } from
 * "./registry.js"` directly, so this index is the only place in the
 * tree that forms a graph with the skill modules. That graph is a
 * tree, not a cycle, which is what keeps every skill-related test
 * free of the TDZ error that previously broke the suite.
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

// Auto-register Phase-1 skills on first import. Each module calls
// `registerSkill(...)` at load time against `./registry.js`.
import "./varianceDecomposer.js";
import "./driverDiscovery.js";
import "./insightExplorer.js";
import "./timeWindowDiff.js";
