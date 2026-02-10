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
import fs from 'fs';
import path from 'path';

export interface SnowflakeConnectionConfig {
  account: string;
  username: string;
  password?: string; // Optional - not required for SSO/key pair auth
  warehouse: string;
  database: string;
  schema: string;
  role?: string;
  // Key pair authentication (for SSO accounts without passwords)
  privateKey?: string; // Private key content (PEM format)
  privateKeyPath?: string; // Path to private key file
  privateKeyPass?: string; // Passphrase if private key is encrypted
  authenticator?: 'SNOWFLAKE' | 'SNOWFLAKE_JWT' | 'EXTERNALBROWSER' | string; // Default: 'SNOWFLAKE' for password, 'SNOWFLAKE_JWT' for key pair
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
    password: config?.password ?? env.SNOWFLAKE_PASSWORD,
    warehouse: config?.warehouse ?? env.SNOWFLAKE_WAREHOUSE ?? '',
    database: config?.database ?? env.SNOWFLAKE_DATABASE ?? '',
    schema: config?.schema ?? env.SNOWFLAKE_SCHEMA ?? '',
    // Do not pass role from env: SDK puts roleName in login URL and can cause 404 on some accounts.
    role: config?.role,
    // Key pair authentication options
    privateKey: config?.privateKey ?? env.SNOWFLAKE_PRIVATE_KEY,
    privateKeyPath: config?.privateKeyPath ?? env.SNOWFLAKE_PRIVATE_KEY_PATH,
    privateKeyPass: config?.privateKeyPass ?? env.SNOWFLAKE_PRIVATE_KEY_PASS,
    authenticator: config?.authenticator ?? env.SNOWFLAKE_AUTHENTICATOR as any,
  };
}

function createConnection(config: SnowflakeConnectionConfig): snowflake.Connection {
  const opts: snowflake.ConnectionOptions = {
    account: config.account,
    username: config.username,
    warehouse: config.warehouse,
  };

  // Determine authentication method: key pair (SSO) or password
  const hasPassword = config.password && config.password.trim().length > 0;
  const hasPrivateKey = config.privateKey && config.privateKey.trim().length > 0;
  const hasPrivateKeyPath = config.privateKeyPath && config.privateKeyPath.trim().length > 0;

  if (hasPrivateKey || hasPrivateKeyPath) {
    // Key pair authentication (for SSO accounts)
    opts.authenticator = config.authenticator || 'SNOWFLAKE_JWT';
    
    if (hasPrivateKeyPath) {
      // Use private key file path (SDK will read the file)
      const keyPath = path.resolve(config.privateKeyPath!);
      if (!fs.existsSync(keyPath)) {
        throw new Error(`Private key file not found: ${keyPath}`);
      }
      opts.privateKeyPath = keyPath;
      if (config.privateKeyPass) {
        opts.privateKeyPass = config.privateKeyPass;
      }
    } else if (hasPrivateKey) {
      // Use private key content directly
      opts.privateKey = config.privateKey;
      if (config.privateKeyPass) {
        opts.privateKeyPass = config.privateKeyPass;
      }
    }
  } else if (hasPassword) {
    // Password authentication (default)
    opts.password = config.password;
    opts.authenticator = config.authenticator || 'SNOWFLAKE';
  } else {
    throw new Error('Snowflake authentication requires either password or private key (for SSO accounts).');
  }

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

/** Convert a single row (array or object) to Record<string, any> using column names. */
function rowToRecord(row: any, columns: string[]): Record<string, any> | null {
  if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
    return { ...row };
  }
  if (Array.isArray(row) && columns.length) {
    const obj: Record<string, any> = {};
    columns.forEach((col: string, i: number) => {
      obj[col] = row[i];
    });
    return obj;
  }
  return null;
}

function executeAsync(
  connection: snowflake.Connection,
  sqlText: string
): Promise<Record<string, any>[]> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      complete: (err: Error | undefined, stmt: snowflake.RowStatement, rows: any[] | undefined) => {
        if (err) {
          reject(err);
          return;
        }
        const rawRows = rows ?? [];
        const columns = stmt.getColumns?.()?.map((c: any) => c.getName()) ?? [];
        const result: Record<string, any>[] = [];
        for (const row of rawRows) {
          const rec = rowToRecord(row, columns);
          if (rec) result.push(rec);
        }
        resolve(result);
      },
    });
  });
}

/**
 * Execute a query and consume ALL rows via streaming (no row limit).
 * The default execute() complete callback can receive only the first batch (e.g. 50 rows)
 * from the Snowflake driver; streaming ensures we collect the entire result set.
 */
function executeStreamAsync(
  connection: snowflake.Connection,
  sqlText: string
): Promise<Record<string, any>[]> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      streamResult: true,
      complete: (err: Error | undefined, stmt: snowflake.RowStatement) => {
        if (err) {
          reject(err);
          return;
        }
        const columns = stmt.getColumns?.()?.map((c: any) => c.getName()) ?? [];
        const result: Record<string, any>[] = [];
        const stream = stmt.streamRows();
        stream
          .on('readable', function (this: NodeJS.ReadableStream) {
            let row: any;
            while ((row = this.read()) !== null) {
              const rec = rowToRecord(row, columns);
              if (rec) result.push(rec);
            }
          })
          .on('end', () => resolve(result))
          .on('error', (e: Error) => reject(e));
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

// Single connection reused for all metadata (created once, no database/schema in login).
let sharedConnection: snowflake.Connection | null = null;
let sharedConnectionConfig: string | null = null;

function connectionConfigKey(config: SnowflakeConnectionConfig): string {
  return `${config.account}|${config.username}|${config.warehouse}`;
}

/**
 * Validate that authentication credentials are provided (either password or key pair).
 */
function validateAuthConfig(config: SnowflakeConnectionConfig): void {
  const hasPassword = config.password && config.password.trim().length > 0;
  const hasPrivateKey = config.privateKey && config.privateKey.trim().length > 0;
  const hasPrivateKeyPath = config.privateKeyPath && config.privateKeyPath.trim().length > 0;
  
  if (!hasPassword && !hasPrivateKey && !hasPrivateKeyPath) {
    throw new Error('Snowflake authentication requires either password or private key (for SSO accounts). Set SNOWFLAKE_PASSWORD or SNOWFLAKE_PRIVATE_KEY/SNOWFLAKE_PRIVATE_KEY_PATH in environment variables.');
  }
}

/**
 * Validate that required connection config is present.
 */
function validateConnectionConfig(config: SnowflakeConnectionConfig): void {
  if (!config.account || !config.username || !config.warehouse) {
    throw new Error('Snowflake connection requires account, username, and warehouse.');
  }
  validateAuthConfig(config);
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
}

/**
 * List databases: SHOW DATABASES.
 * Returns { name, created_on }.
 */
export async function listDatabases(
  config?: Partial<SnowflakeConnectionConfig>
): Promise<{ name: string; created_on?: string }[]> {
  const fullConfig = getConnectionOptions(config);
  validateConnectionConfig(fullConfig);
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
  validateConnectionConfig(fullConfig);
  if (!database?.trim()) {
    throw new Error('Database name is required to list schemas.');
  }
  const connection = await getOrCreateConnection({
    ...fullConfig,
    database: '',
    schema: '',
  });
  const escapedDb = database.replace(/"/g, '""');
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
  validateConnectionConfig(fullConfig);
  if (!database?.trim() || !schema?.trim()) {
    throw new Error('Database and schema are required to list tables.');
  }
  const connection = await getOrCreateConnection({
    ...fullConfig,
    database: '',
    schema: '',
  });
  const escapedDb = database.trim().replace(/"/g, '""');
  const schemaEscapedForSql = schema.trim().replace(/'/g, "''");
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
  validateConnectionConfig(fullConfig);
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
  const escapedDb = db.replace(/"/g, '""');
  const escapedSchema = schema.replace(/"/g, '""');
  const escapedTable = tableName.trim().replace(/"/g, '""');
  const quotedTable = `"${escapedDb}"."${escapedSchema}"."${escapedTable}"`;
  const sql = `SELECT * FROM ${quotedTable}`;
  // Use streaming so we receive the full result set (no row limit); the default complete() callback may only get the first batch (e.g. 50 rows).
  return executeStreamAsync(connection, sql);
}

/**
 * Verify Snowflake connection at server startup (uses shared connection).
 */
export async function verifySnowflakeConnection(): Promise<{ ok: boolean; message?: string }> {
  const fullConfig = getConnectionOptions(undefined);
  if (!fullConfig.account || !fullConfig.username || !fullConfig.warehouse) {
    return { ok: false, message: 'Missing SNOWFLAKE_ACCOUNT, USERNAME, or WAREHOUSE in env.' };
  }
  const hasPassword = fullConfig.password && fullConfig.password.trim().length > 0;
  const hasPrivateKey = fullConfig.privateKey && fullConfig.privateKey.trim().length > 0;
  const hasPrivateKeyPath = fullConfig.privateKeyPath && fullConfig.privateKeyPath.trim().length > 0;
  if (!hasPassword && !hasPrivateKey && !hasPrivateKeyPath) {
    return { ok: false, message: 'Missing SNOWFLAKE_PASSWORD or SNOWFLAKE_PRIVATE_KEY/SNOWFLAKE_PRIVATE_KEY_PATH in env (required for SSO accounts).' };
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
    if (!fullConfig.account || !fullConfig.username) {
      return { ok: false, message: 'Missing account or username.' };
    }
    const hasPassword = fullConfig.password && fullConfig.password.trim().length > 0;
    const hasPrivateKey = fullConfig.privateKey && fullConfig.privateKey.trim().length > 0;
    const hasPrivateKeyPath = fullConfig.privateKeyPath && fullConfig.privateKeyPath.trim().length > 0;
    if (!hasPassword && !hasPrivateKey && !hasPrivateKeyPath) {
      return { ok: false, message: 'Missing password or private key (required for SSO accounts).' };
    }
    await getOrCreateConnection({ ...fullConfig, database: '', schema: '' });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}
