import { api } from "@/lib/httpClient";

export interface SnowflakeDatabaseInfo {
  name: string;
  created_on?: string;
}

export interface SnowflakeSchemaInfo {
  name: string;
}

export interface SnowflakeTableInfo {
  name: string;
  row_count?: number;
  bytes?: number;
  database: string;
  schema: string;
}

export interface SnowflakeImportResponse {
  jobId: string;
  sessionId: string;
  fileName: string;
  status: string;
  message?: string;
}

export const snowflakeApi = {
  listDatabases: () =>
    api.get<{ databases: SnowflakeDatabaseInfo[] }>("/api/snowflake/databases"),

  listSchemas: (database: string) =>
    api.get<{ schemas: SnowflakeSchemaInfo[] }>("/api/snowflake/schemas", {
      params: { database },
    }),

  /** List tables in a schema (database + schema required). */
  listTables: (database: string, schema: string) =>
    api.get<{ tables: SnowflakeTableInfo[] }>("/api/snowflake/tables", {
      params: { database, schema },
    }),

  importTable: (params: { database: string; schema: string; tableName: string }) =>
    api.post<SnowflakeImportResponse>("/api/snowflake/import", params),
};
