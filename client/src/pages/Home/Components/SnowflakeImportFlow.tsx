import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Database, FolderOpen, Loader2, Table2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  snowflakeApi,
  type SnowflakeDatabaseInfo,
  type SnowflakeSchemaInfo,
  type SnowflakeTableInfo,
} from '@/lib/api/snowflake';
import { useToast } from '@/hooks/use-toast';

interface SnowflakeImportFlowProps {
  onBack: () => void;
  onImport: (params: { database: string; schema: string; tableName: string }) => void;
  isImporting: boolean;
}

type Step = 'database' | 'schema' | 'table';

export function SnowflakeImportFlow({
  onBack,
  onImport,
  isImporting,
}: SnowflakeImportFlowProps) {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>('database');
  const [databases, setDatabases] = useState<SnowflakeDatabaseInfo[]>([]);
  const [schemas, setSchemas] = useState<SnowflakeSchemaInfo[]>([]);
  const [tables, setTables] = useState<SnowflakeTableInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDatabase, setSelectedDatabase] = useState<string | null>(null);
  const [selectedSchema, setSelectedSchema] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<SnowflakeTableInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDatabases = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { databases: list } = await snowflakeApi.listDatabases();
      setDatabases(list);
      setSelectedDatabase(null);
      setSelectedSchema(null);
      setSelectedTable(null);
      setSchemas([]);
      setTables([]);
      setStep('database');
      if (list.length === 0) {
        toast({ title: 'No databases', description: 'No databases found in this Snowflake account.' });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not load databases.';
      setError(message);
      toast({
        title: 'Failed to load databases',
        description: 'Snowflake may not be configured. Check server/server.env (SNOWFLAKE_*).',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadSchemas = useCallback(async (database: string) => {
    setLoading(true);
    setError(null);
    try {
      const { schemas: list } = await snowflakeApi.listSchemas(database);
      setSchemas(list);
      setSelectedSchema(null);
      setSelectedTable(null);
      setTables([]);
      setStep('schema');
      if (list.length === 0) {
        toast({ title: 'No schemas', description: `No schemas found in database "${database}".` });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not load schemas.';
      setError(message);
      toast({ title: 'Failed to load schemas', description: message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadTables = useCallback(async (database: string, schema: string) => {
    setLoading(true);
    setError(null);
    try {
      const { tables: list } = await snowflakeApi.listTables(database, schema);
      setTables(list);
      setSelectedTable(null);
      setStep('table');
      if (list.length === 0) {
        toast({ title: 'No tables', description: `No tables found in ${database}.${schema}.` });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not load tables.';
      setError(message);
      toast({ title: 'Failed to load tables', description: message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadDatabases();
  }, [loadDatabases]);

  const handleSelectDatabase = (name: string) => {
    setSelectedDatabase(name);
    loadSchemas(name);
  };

  const handleSelectSchema = (name: string) => {
    setSelectedSchema(name);
    if (selectedDatabase) loadTables(selectedDatabase, name);
  };

  const handleSelectTable = (table: SnowflakeTableInfo) => {
    setSelectedTable(table);
  };

  const handleImport = () => {
    if (!selectedTable) {
      toast({
        title: 'Select a table',
        description: 'Please select a table to import.',
        variant: 'destructive',
      });
      return;
    }
    onImport({
      database: selectedTable.database,
      schema: selectedTable.schema,
      tableName: selectedTable.name,
    });
  };

  const goBackToDatabases = () => {
    setStep('database');
    setSelectedDatabase(null);
    setSelectedSchema(null);
    setSelectedTable(null);
    setError(null);
    loadDatabases();
  };

  const goBackToSchemas = () => {
    if (!selectedDatabase) return;
    setStep('schema');
    setSelectedSchema(null);
    setSelectedTable(null);
    setError(null);
    loadSchemas(selectedDatabase);
  };

  const goBackToTables = () => {
    if (!selectedDatabase || !selectedSchema) return;
    setStep('table');
    setSelectedTable(null);
    setError(null);
    loadTables(selectedDatabase, selectedSchema);
  };

  const breadcrumb =
    step === 'database'
      ? 'Select a database'
      : step === 'schema'
        ? `Database: ${selectedDatabase} — select a schema`
        : `Database: ${selectedDatabase} · Schema: ${selectedSchema} — select a table to import`;

  return (
    <div className="h-[calc(100vh-80px)] bg-background flex items-center justify-center p-4 overflow-auto">
      <div className="w-full max-w-2xl">
        <Button
          variant="ghost"
          size="sm"
          className="mb-4 -ml-2"
          onClick={onBack}
          data-testid="snowflake-back"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back
        </Button>

        <Card className="p-6 rounded-2xl border-2 border-border bg-card shadow-sm">
          <div className="flex items-center gap-2 mb-6">
            <div className="w-10 h-10 rounded-full bg-sky-100 flex items-center justify-center">
              <Database className="w-5 h-5 text-sky-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">Import from Snowflake</h2>
              <p className="text-sm text-muted-foreground">{breadcrumb}</p>
            </div>
          </div>

          {step !== 'database' && (
            <div className="flex gap-2 mb-4 flex-wrap">
              <Button variant="outline" size="sm" onClick={goBackToDatabases}>
                Change database
              </Button>
              {step === 'table' && (
                <>
                  <Button variant="outline" size="sm" onClick={goBackToSchemas}>
                    Change schema
                  </Button>
                  <Button variant="outline" size="sm" onClick={goBackToTables}>
                    Refresh tables
                  </Button>
                </>
              )}
            </div>
          )}

          {loading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 className="w-10 h-10 text-sky-600 animate-spin mb-4" />
              <p className="text-sm text-muted-foreground">
                {step === 'database' && 'Loading databases…'}
                {step === 'schema' && 'Loading schemas…'}
                {step === 'table' && 'Loading tables…'}
              </p>
            </div>
          ) : error ? (
            <div className="py-8 text-center">
              <p className="text-sm text-red-600 mb-4">{error}</p>
              <Button
                variant="outline"
                onClick={() => {
                  if (step === 'database') loadDatabases();
                  else if (step === 'schema' && selectedDatabase) loadSchemas(selectedDatabase);
                  else if (selectedDatabase && selectedSchema) loadTables(selectedDatabase, selectedSchema);
                }}
              >
                Retry
              </Button>
            </div>
          ) : step === 'database' ? (
            <>
              <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-border">
                <ul className="divide-y divide-border">
                  {databases.map((db) => (
                    <li key={db.name}>
                      <button
                        type="button"
                        onClick={() => handleSelectDatabase(db.name)}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
                      >
                        <Database className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="font-medium text-foreground">{db.name}</span>
                        {db.created_on != null && (
                          <span className="text-xs text-muted-foreground ml-auto">{db.created_on}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              {databases.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">No databases found.</p>
              )}
            </>
          ) : step === 'schema' ? (
            <>
              <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-border">
                <ul className="divide-y divide-border">
                  {schemas.map((s) => (
                    <li key={s.name}>
                      <button
                        type="button"
                        onClick={() => handleSelectSchema(s.name)}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
                      >
                        <FolderOpen className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="font-medium text-foreground">{s.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              {schemas.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">No schemas found.</p>
              )}
            </>
          ) : (
            <>
              <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-border">
                <ul className="divide-y divide-border">
                  {tables.map((t) => (
                    <li key={`${t.database}.${t.schema}.${t.name}`}>
                      <button
                        type="button"
                        onClick={() => handleSelectTable(t)}
                        className={`
                          w-full flex items-center gap-3 px-4 py-3 text-left transition-colors
                          hover:bg-muted/40
                          ${selectedTable?.database === t.database && selectedTable?.schema === t.schema && selectedTable?.name === t.name ? 'bg-primary/10 border-l-4 border-l-primary' : ''}
                        `}
                      >
                        <Table2 className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="font-medium text-foreground">{t.name}</span>
                        <span className="text-xs text-muted-foreground truncate ml-auto">
                          {t.row_count != null && `${t.row_count} rows`}
                          {t.row_count != null && t.bytes != null && ' · '}
                          {t.bytes != null && `${(t.bytes / 1024).toFixed(1)} KB`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              {tables.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">No tables found.</p>
              )}
              <Button
                className="mt-6 w-full"
                onClick={handleImport}
                disabled={!selectedTable || isImporting}
              >
                {isImporting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Importing…
                  </>
                ) : (
                  'Import selected table & start analysis'
                )}
              </Button>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
