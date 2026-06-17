/**
 * `filter` data-op handler — extracted VERBATIM from `executeDataOperation`'s
 * switch (ARCH-2 / CQ-2 god-file decomposition).
 *
 * Validates + applies the intent's `filterConditions` over the rows, then
 * prefers the NON-DESTRUCTIVE `activeFilter` overlay (Wave-FA4): when every
 * condition translates cleanly AND a session doc is present, it writes the
 * overlay spec and returns `saved: false` (canonical dataset preserved). For
 * operators the overlay can't model (`!=`, `contains`, …) or when the session
 * doc is unavailable, it falls back to the legacy destructive
 * `saveModifiedData` path and returns `saved: true`. The body below is moved
 * unchanged from the orchestrator — same translation/fallback ordering, same
 * answer strings, same return shapes. The module-private
 * `loadActiveFilterPersistModule` dynamic import is inlined here (used only by
 * filter / revert). The only change vs. the orchestrator is collapsing the
 * captured locals into a single typed args object (CQ-2).
 */
import { saveModifiedData, getPreviewFromSavedData } from "../dataPersistence.js";
import { translateLegacyFilterToActiveFilter } from "../intent/translateLegacyFilterToActiveFilter.js";
import { logger } from "../../logger.js";
import type { ChatDocument } from "../../../models/chat.model.js";
import type { DataRow, DataOpResult } from "../dataOpsTypes.js";
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";

export interface FilterArgs {
  intent: DataOpsIntent;
  data: DataRow[];
  sessionId: string;
  sessionDoc?: ChatDocument;
}

export async function handleFilter({
  intent,
  data,
  sessionId,
  sessionDoc,
}: FilterArgs): Promise<DataOpResult> {
  logger.log(`🔍 Executing filter operation with ${intent.filterConditions?.length || 0} conditions`);

  if (!intent.filterConditions || intent.filterConditions.length === 0) {
    return {
      answer: 'No filter conditions specified. Please specify what you want to filter. For example: "filter data where category is men\'s fashion" or "show only rows where revenue > 1000000".',
    };
  }

  const logicalOperator = intent.logicalOperator || 'AND';
  let filteredData = [...data];

  // Apply each filter condition
  for (const condition of intent.filterConditions) {
    const { column, operator, value, value2, values } = condition;

    if (!column) {
      logger.warn(`⚠️ Skipping filter condition without column:`, condition);
      continue;
    }

    // Verify column exists
    if (!data[0] || !(column in data[0])) {
      const availableColumns = Object.keys(data[0] || {}).slice(0, 10).join(', ');
      return {
        answer: `Column "${column}" not found in dataset. Available columns: ${availableColumns}${Object.keys(data[0] || {}).length > 10 ? '...' : ''}`,
      };
    }

    // Apply filter based on operator
    const rowsBeforeFilter = filteredData.length;

    filteredData = filteredData.filter(row => {
      const cellValue = row[column];

      switch (operator) {
        case '=':
          // Case-insensitive string comparison for text, exact for numbers
          if (typeof cellValue === 'number' && typeof value === 'number') {
            return cellValue === value;
          }
          return String(cellValue).toLowerCase().trim() === String(value).toLowerCase().trim();
        case '!=':
          if (typeof cellValue === 'number' && typeof value === 'number') {
            return cellValue !== value;
          }
          return String(cellValue).toLowerCase().trim() !== String(value).toLowerCase().trim();
        case '>':
          return Number(cellValue) > Number(value);
        case '>=':
          return Number(cellValue) >= Number(value);
        case '<':
          return Number(cellValue) < Number(value);
        case '<=':
          return Number(cellValue) <= Number(value);
        case 'contains':
          return String(cellValue).toLowerCase().includes(String(value).toLowerCase());
        case 'startsWith':
          return String(cellValue).toLowerCase().startsWith(String(value).toLowerCase());
        case 'endsWith':
          return String(cellValue).toLowerCase().endsWith(String(value).toLowerCase());
        case 'between': {
          if (value2 === undefined || value2 === null) {
            logger.warn(`⚠️ Between operator requires value2, skipping condition`);
            return true;
          }
          const numValue = Number(cellValue);
          return numValue >= Number(value) && numValue <= Number(value2);
        }
        case 'in': {
          if (!values || !Array.isArray(values) || values.length === 0) {
            logger.warn(`⚠️ In operator requires values array, skipping condition`);
            return true;
          }
          const cellStr = String(cellValue).toLowerCase().trim();
          return values.some(v => String(v).toLowerCase().trim() === cellStr);
        }
        default:
          logger.warn(`⚠️ Unknown filter operator: ${operator}`);
          return true;
      }
    });

    const rowsAfterFilter = filteredData.length;
    logger.log(`  ✅ Applied filter: ${column} ${operator} ${value || (values ? `[${values.join(', ')}]` : '')}${value2 ? ` and ${value2}` : ''} → ${rowsBeforeFilter} → ${rowsAfterFilter} rows`);

    // If using OR operator, we need to combine results differently
    // For now, AND is the default - all conditions must match
    if (logicalOperator === 'OR') {
      // For OR, we'd need to track which rows match each condition
      // This is a simplified version - you may want to refactor for complex OR logic
      logger.log(`⚠️ OR operator not fully implemented, using AND logic`);
    }
  }

  const rowsBefore = data.length;
  const rowsAfter = filteredData.length;
  const rowsRemoved = rowsBefore - rowsAfter;

  logger.log(`✅ Filter applied: ${rowsBefore} → ${rowsAfter} rows (removed ${rowsRemoved})`);

  if (rowsAfter === 0) {
    return {
      answer: `⚠️ The filter conditions resulted in an empty dataset (0 rows). Please adjust your filter criteria.\n\n**Filter conditions:** ${intent.filterConditions.map(c => {
        if (c.operator === 'between') {
          return `${c.column} between ${c.value} and ${c.value2}`;
        } else if (c.operator === 'in') {
          return `${c.column} in [${c.values?.join(', ')}]`;
        } else {
          return `${c.column} ${c.operator} ${c.value}`;
        }
      }).join(` ${logicalOperator} `)}`,
    };
  }

  // Build description of filter conditions
  const conditionDescriptions = intent.filterConditions.map(c => {
    if (c.operator === 'between') {
      return `${c.column} between ${c.value} and ${c.value2}`;
    } else if (c.operator === 'in') {
      return `${c.column} in [${c.values?.join(', ')}]`;
    } else {
      return `${c.column} ${c.operator} ${c.value}`;
    }
  }).join(` ${logicalOperator} `);

  // Wave-FA4 · Try to translate to the new non-destructive `activeFilter`
  // overlay. If every condition translates cleanly, write the spec to the
  // session document and return without ever calling `saveModifiedData`.
  // The canonical dataset is preserved; subsequent reads via
  // `loadLatestData` apply the filter automatically.
  const translation = translateLegacyFilterToActiveFilter(intent.filterConditions);
  if (translation.ok && sessionDoc) {
    const translateModule = await import("../../activeFilter/persistActiveFilter.js");
    await translateModule.applyActiveFilterFromIntent(
      sessionDoc,
      translation.conditions
    );
    const previewData = filteredData.slice(0, 50);
    const answer = `✅ I've filtered the dataset based on your conditions:\n\n` +
      `**Filter conditions:** ${conditionDescriptions}\n` +
      `**Rows before:** ${rowsBefore}\n` +
      `**Rows after:** ${rowsAfter}\n` +
      `**Rows removed:** ${rowsRemoved}\n\n` +
      `The filter is active for this analysis. Your original dataset is unchanged — open the Filter Data panel to refine or clear it.`;
    return {
      answer,
      data: filteredData,
      preview: previewData,
      saved: false,
    };
  }

  // Legacy fallback for operators the active-filter overlay can't model
  // (`!=`, `contains`, `startsWith`, `endsWith`) or when the session doc
  // is unavailable. Mutates the dataset exactly as before.
  const fallbackReason = translation.ok
    ? "session doc unavailable"
    : translation.reason;
  logger.warn(
    `⚠️ Legacy filter fallback (operator(s) not modelable as active filter): ${fallbackReason}`
  );
  const saveResult = await saveModifiedData(
    sessionId,
    filteredData,
    'filter',
    `Filtered data: ${conditionDescriptions}`,
    sessionDoc
  );

  // Get preview from saved data
  const previewData = await getPreviewFromSavedData(sessionId, filteredData);

  const answer = `✅ I've filtered the dataset based on your conditions:\n\n` +
    `**Filter conditions:** ${conditionDescriptions}\n` +
    `**Rows before:** ${rowsBefore}\n` +
    `**Rows after:** ${rowsAfter}\n` +
    `**Rows removed:** ${rowsRemoved}\n\n` +
    `The filtered dataset is now your working dataset. All subsequent queries will work on this filtered data.`;

  return {
    answer,
    data: filteredData,
    preview: previewData,
    saved: true,
  };
}
