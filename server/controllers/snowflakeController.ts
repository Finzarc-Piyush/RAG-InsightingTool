import { Request, Response } from 'express';
import { listDatabases, listSchemas, listTablesInSchema } from '../lib/snowflakeService.js';
import { createPlaceholderSession, updateChatDocument } from '../models/chat.model.js';
import { uploadQueue } from '../utils/uploadQueue.js';

/**
 * GET /api/snowflake/databases
 * List databases: SHOW DATABASES. Response: { databases: { name, created_on }[] }.
 */
export const getSnowflakeDatabases = async (req: Request, res: Response) => {
  try {
    const databases = await listDatabases(undefined);
    res.json({ databases });
  } catch (error) {
    console.error('Snowflake list databases error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to list databases. Check server Snowflake config (env).',
    });
  }
};

/**
 * GET /api/snowflake/schemas?database=...
 * List schemas: SHOW SCHEMAS IN DATABASE <database>. Response: { schemas: { name }[] }.
 */
export const getSnowflakeSchemas = async (req: Request, res: Response) => {
  try {
    const database = (req.query.database as string)?.trim();
    if (!database) {
      return res.status(400).json({ error: 'Query parameter database is required' });
    }
    const schemas = await listSchemas(database, undefined);
    res.json({ schemas });
  } catch (error) {
    console.error('Snowflake list schemas error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to list schemas.',
    });
  }
};

/**
 * GET /api/snowflake/tables?database=...&schema=...
 * List tables in schema (metadata only). Response: { tables: { name, row_count, bytes, database, schema }[] }.
 */
export const getSnowflakeTables = async (req: Request, res: Response) => {
  try {
    const database = (req.query.database as string)?.trim();
    const schema = (req.query.schema as string)?.trim();
    if (!database || !schema) {
      return res.status(400).json({ error: 'Query parameters database and schema are required' });
    }
    const tables = await listTablesInSchema(database, schema, undefined);
    res.json({ tables });
  } catch (error) {
    console.error('Snowflake list tables error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to list tables.',
    });
  }
};

/**
 * POST /api/snowflake/import
 * Import a Snowflake table. Body: { database, schema, tableName }.
 */
export const importSnowflakeTable = async (req: Request, res: Response) => {
  try {
    const { database, schema, tableName } = req.body as { database?: string; schema?: string; tableName?: string };

    if (!tableName?.trim()) {
      return res.status(400).json({ error: 'tableName is required' });
    }
    if (!database?.trim()) {
      return res.status(400).json({ error: 'database is required' });
    }
    if (!schema?.trim()) {
      return res.status(400).json({ error: 'schema is required' });
    }

    const usernameHeader = (req.headers['x-user-email'] as string) || 'anonymous@example.com';

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const displayName = `${database}.${schema}.${tableName}`.trim();

    try {
      const placeholder = await createPlaceholderSession(
        usernameHeader,
        displayName,
        sessionId,
        0,
        undefined
      );
      // Mark this session as Snowflake-backed so query execution can use pushdown
      placeholder.sourceType = 'snowflake';
      placeholder.snowflakeSource = {
        database: database.trim(),
        schema: schema.trim(),
        tableName: tableName.trim(),
      };
      await updateChatDocument(placeholder);
    } catch (placeholderError: unknown) {
      console.error('Failed to create placeholder session for Snowflake import:', placeholderError);
    }

    const jobId = await uploadQueue.enqueueSnowflakeImport(
      sessionId,
      usernameHeader,
      displayName,
      { database: database.trim(), schema: schema.trim(), tableName: tableName.trim() }
    );

    res.status(202).json({
      jobId,
      sessionId,
      fileName: displayName,
      status: 'processing',
      message: 'Snowflake import started. Use /api/upload/status/:jobId to check progress.',
    });
  } catch (error) {
    console.error('Snowflake import error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to start Snowflake import',
    });
  }
};
