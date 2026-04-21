/**
 * Snowflake connection and query service.
 * Uses env-based config. Connection is created once and reused for metadata.
 *
 * STEP 1 — Account must be fully qualified:
 *   <account_locator>.<region>.aws  (e.g. zv14667.ap-south-1.aws)
 *   OR <org_name>-<account_name>
 * Do NOT use UI URLs or partial account names.
 */

import snowflake from 'snowflake-sdk';

export interface SnowflakeConnectionConfig {
  account: string;
  username: string;
  password: string;
  warehouse: string;
  database: string;
  schema: string;
  role?: string;
}

/** Normalize account identifier: trim and strip any URL so only account locator remains. */
function normalizeAccountIdentifier(account: string): string {
  const trimmed = (account || '').trim();
  if (!trimmed) return '';
  // If it looks like a URL, extract host part and then account (e.g. zv14667.ap-south-1.aws.snowflakecomputing.com -> zv14667.ap-south-1.aws)
  const lower = trimmed.toLowerCase();
  if (lower.includes('snowflakecomputing.com')) {
    try {
      const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
      const host = url.hostname;
      const parts = host.split('.');
      if (parts[0] && parts[parts.length - 1] === 'com') {
        const withoutCom = parts.slice(0, -1);
        const withoutSnowflake = withoutCom[withoutCom.length - 1] === 'snowflakecomputing'
          ? withoutCom.slice(0, -1)
          : withoutCom;
        return withoutSnowflake.join('.');
      }
    } catch {
      // fall through to return trimmed
    }
  }
  return trimmed;
}

function getConnectionOptions(config?: Partial<SnowflakeConnectionConfig>): SnowflakeConnectionConfig {
  const env = process.env;
  const account = config?.account ?? env.SNOWFLAKE_ACCOUNT ?? '';
  return {
    account: normalizeAccountIdentifier(account),
    username: config?.username ?? env.SNOWFLAKE_USERNAME ?? '',
    password: config?.password ?? env.SNOWFLAKE_PASSWORD ?? '',
    warehouse: config?.warehouse ?? env.SNOWFLAKE_WAREHOUSE ?? '',
    database: config?.database ?? env.SNOWFLAKE_DATABASE ?? '',
    schema: config?.schema ?? env.SNOWFLAKE_SCHEMA ?? '',
    // Do not pass role from env: SDK puts roleName in login URL and can cause 404 on some accounts.
    role: config?.role,
  };
}

function createConnection(config: SnowflakeConnectionConfig): snowflake.Connection {
  const opts: snowflake.ConnectionOptions = {
    account: config.account,
    username: config.username,
    password: config.password,
    warehouse: config.warehouse,
  };
  if (config.database?.trim()) opts.database = config.database.trim();
  if (config.schema?.trim()) opts.schema = config.schema.trim();
  // Omit role so Snowflake uses the user's default role; passing role can cause 404 on login URL.
  return snowflake.createConnection(opts);
}

function connectAsync(connection: snowflake.Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.connect((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function executeAsync(
  connection: snowflake.Connection,
  sqlText: string
): Promise<Record<string, any>[]> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      complete: (err: Error | undefined, stmt: snowflake.Statement, rows: any[] | undefined) => {
        if (err) {
          reject(err);
          return;
        }
        const rawRows = rows ?? [];
        const result: Record<string, any>[] = [];
        const columns = stmt.getColumns?.()?.map((c: any) => c.getName()) ?? [];
        for (const row of rawRows) {
          if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
            result.push({ ...row });
          } else if (Array.isArray(row) && columns.length) {
            const obj: Record<string, any> = {};
            columns.forEach((col: string, i: number) => {
              obj[col] = row[i];
            });
            result.push(obj);
          }
        }
        resolve(result);
      },
    });
  });
}

function destroyAsync(connection: snowflake.Connection): Promise<void> {
  return new Promise((resolve) => {
    try {
      connection.destroy((err) => {
        if (err) console.warn('Snowflake connection destroy warning:', err.message);
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

const MAX_IMPORT_ROWS = 500_000;

/**
 * Escape a Snowflake identifier (db / schema / table / column name) for safe
 * interpolation into SQL. Always use double-quotes around the result.
 * Consolidates ad-hoc replace() calls that previously differed per call site (P-030).
 */
export function sanitizeIdentifier(name: string): string {
  return (name ?? '').trim().replace(/"/g, '""');
}

/**
 * Escape a Snowflake string literal for safe interpolation into SQL. Always
 * surround the result with single-quotes at the call site.
 */
export function sanitizeStringLiteral(value: string): string {
  return (value ?? '').replace(/'/g, "''");
}

// Shared connection cache + single-flight guard on creation (P-004). The socket
// logs in with empty database/schema; every query must be fully-qualified so
// concurrent requests cannot alias contexts. The config key therefore only
// needs to partition by identity (account|username|warehouse|role).
let sharedConnection: snowflake.Connection | null = null;
let sharedConnectionConfig: string | null = null;
let sharedConnectionPromise: Promise<snowflake.Connection> | null = null;

function connectionConfigKey(config: SnowflakeConnectionConfig): string {
  return `${config.account}|${config.username}|${config.warehouse}|${config.role ?? ''}`;
}

/**
 * Get or create the shared Snowflake connection (no database/schema).
 * Used for all metadata queries; connection is reused.
 */
async function getOrCreateConnection(config: SnowflakeConnectionConfig): Promise<snowflake.Connection> {
  const key = connectionConfigKey(config);
  if (sharedConnection && sharedConnectionConfig === key) {
    return sharedConnection;
  }
  if (sharedConnectionPromise) {
    // Another caller is already establishing the connection; piggy-back on it.
    const conn = await sharedConnectionPromise;
    if (sharedConnectionConfig === key) {
      return conn;
    }
    // Identity changed under us — fall through and rebuild.
  }
  sharedConnectionPromise = (async () => {
    if (sharedConnection) {
      await destroyAsync(sharedConnection);
      sharedConnection = null;
      sharedConnectionConfig = null;
    }
    const connection = createConnection({
      ...config,
      database: '',
      schema: '',
    });
    await connectAsync(connection);
    sharedConnection = connection;
    sharedConnectionConfig = key;
    return connection;
  })();
  try {
    return await sharedConnectionPromise;
  } finally {
    sharedConnectionPromise = null;
  }
}

/**
 * List databases: SHOW DATABASES.
 * Returns { name, created_on }.
 */
export async function listDatabases(
  config?: Partial<SnowflakeConnectionConfig>
): Promise<{ name: string; created_on?: string }[]> {
  const fullConfig = getConnectionOptions(config);
  if (!fullConfig.account || !fullConfig.username || !fullConfig.password || !fullConfig.warehouse) {
    throw new Error('Snowflake connection requires account, username, password, and warehouse.');
  }
  const connection = await getOrCreateConnection({
    ...fullConfig,
    database: '',
    schema: '',
  });
  const rows = await executeAsync(connection, 'SHOW DATABASES');
  return rows.map((r) => {
    const row = r as Record<string, any>;
    const name = row.name ?? row.NAME ?? row.Name ?? '';
    const created_on = row.created_on ?? row.CREATED_ON ?? row.Created_On;
    return { name: String(name), created_on: created_on != null ? String(created_on) : undefined };
  });
}

/**
 * List schemas in a database: SHOW SCHEMAS IN DATABASE <database_name>.
 * Returns { name }.
 */
export async function listSchemas(
  database: string,
  config?: Partial<SnowflakeConnectionConfig>
): Promise<{ name: string }[]> {
  const fullConfig = getConnectionOptions(config);
  if (!fullConfig.account || !fullConfig.username || !fullConfig.password || !fullConfig.warehouse) {
    throw new Error('Snowflake connection requires account, username, password, and warehouse.');
  }
  if (!database?.trim()) {
    throw new Error('Database name is required to list schemas.');
  }
  const connection = await getOrCreateConnection({
    ...fullConfig,
    database: '',
    schema: '',
  });
  const escapedDb = sanitizeIdentifier(database);
  const rows = await executeAsync(connection, `SHOW SCHEMAS IN DATABASE "${escapedDb}"`);
  return rows.map((r) => {
    const row = r as Record<string, any>;
    const name = row.name ?? row.NAME ?? row.Name ?? '';
    return { name: String(name) };
  });
}

/**
 * List tables in a schema. Uses INFORMATION_SCHEMA (metadata only, no table data).
 * Returns { name, row_count, bytes } plus database/schema for import.
 */
export async function listTablesInSchema(
  database: string,
  schema: string,
  config?: Partial<SnowflakeConnectionConfig>
): Promise<{ name: string; row_count?: number; bytes?: number; database: string; schema: string }[]> {
  const fullConfig = getConnectionOptions(config);
  if (!fullConfig.account || !fullConfig.username || !fullConfig.password || !fullConfig.warehouse) {
    throw new Error('Snowflake connection requires account, username, password, and warehouse.');
  }
  if (!database?.trim() || !schema?.trim()) {
    throw new Error('Database and schema are required to list tables.');
  }
  const connection = await getOrCreateConnection({
    ...fullConfig,
    database: '',
    schema: '',
  });
  const escapedDb = sanitizeIdentifier(database);
  const schemaEscapedForSql = sanitizeStringLiteral(schema.trim());
  const sql = `SELECT TABLE_NAME AS "name", ROW_COUNT AS "row_count", BYTES AS "bytes"
    FROM "${escapedDb}"."INFORMATION_SCHEMA"."TABLES"
    WHERE TABLE_SCHEMA = '${schemaEscapedForSql}' AND TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_NAME`;
  const rows = await executeAsync(connection, sql);
  return rows.map((r) => {
    const row = r as Record<string, any>;
    const name = row.name ?? row.NAME ?? row.Table_name ?? row.TABLE_NAME ?? '';
    const row_count = row.row_count ?? row.ROW_COUNT ?? row.Row_count;
    const bytes = row.bytes ?? row.BYTES ?? row.Bytes;
    return {
      name: String(name),
      row_count: row_count != null ? Number(row_count) : undefined,
      bytes: bytes != null ? Number(bytes) : undefined,
      database: database.trim(),
      schema: schema.trim(),
    };
  });
}

/**
 * Fetch table data (only when user explicitly selects a table to import).
 * Uses shared connection; metadata queries do not load table data.
 */
export async function fetchTableData(
  config: Partial<SnowflakeConnectionConfig> & { tableName: string }
): Promise<Record<string, any>[]> {
  const fullConfig = getConnectionOptions(config);
  const { tableName } = config;
  if (!fullConfig.account || !fullConfig.username || !fullConfig.password || !fullConfig.warehouse) {
    throw new Error('Snowflake connection requires account, username, password, and warehouse.');
  }
  if (!tableName?.trim()) {
    throw new Error('Table name is required.');
  }
  const db = (fullConfig.database ?? '').trim();
  const schema = (fullConfig.schema ?? '').trim();
  if (!db || !schema) {
    throw new Error('Database and schema are required to fetch table data.');
  }
  const connection = await getOrCreateConnection({
    ...fullConfig,
    database: '',
    schema: '',
  });
  const escapedDb = sanitizeIdentifier(db);
  const escapedSchema = sanitizeIdentifier(schema);
  const escapedTable = sanitizeIdentifier(tableName);
  const quotedTable = `"${escapedDb}"."${escapedSchema}"."${escapedTable}"`;
  const sql = `SELECT * FROM ${quotedTable} LIMIT ${MAX_IMPORT_ROWS}`;
  return executeAsync(connection, sql);
}

/**
 * Verify Snowflake connection at server startup (uses shared connection).
 */
export async function verifySnowflakeConnection(): Promise<{ ok: boolean; message?: string }> {
  const fullConfig = getConnectionOptions(undefined);
  if (!fullConfig.account || !fullConfig.username || !fullConfig.password || !fullConfig.warehouse) {
    return { ok: false, message: 'Missing SNOWFLAKE_ACCOUNT, USERNAME, PASSWORD, or WAREHOUSE in env.' };
  }
  try {
    await getOrCreateConnection({ ...fullConfig, database: '', schema: '' });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}

/**
 * Test connectivity (for ad-hoc use).
 */
export async function testConnection(
  config?: Partial<SnowflakeConnectionConfig>
): Promise<{ ok: boolean; message?: string }> {
  try {
    const fullConfig = getConnectionOptions(config);
    if (!fullConfig.account || !fullConfig.username || !fullConfig.password) {
      return { ok: false, message: 'Missing account, username, or password.' };
    }
    await getOrCreateConnection({ ...fullConfig, database: '', schema: '' });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}
