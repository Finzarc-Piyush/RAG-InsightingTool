/**
 * `isDataModificationOperation` intent helper — extracted verbatim from
 * `dataOpsOrchestrator.ts` (ARCH-2 / CQ-2 god-file decomposition).
 *
 * Pure predicate over the operation discriminant; zero coupling to the
 * orchestrator's locals / session state. An operation that modifies data should
 * auto-show a preview, so the orchestrator ORs this into `shouldShowPreview`.
 * Behaviour-preserving move.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";

/**
 * Check if an operation modifies data and should automatically show preview
 */
export function isDataModificationOperation(operation: DataOpsIntent['operation']): boolean {
  const dataModificationOperations: DataOpsIntent['operation'][] = [
    'remove_nulls',
    'create_column',
    'create_derived_column',
    'normalize_column',
    'modify_column',
    'remove_column',
    'rename_column',
    'remove_rows',
    'add_row',
    'replace_value',
    'convert_type',
    'aggregate',
    'pivot',
    'treat_outliers',
    'filter',
    'revert',
  ];

  return dataModificationOperations.includes(operation);
}
