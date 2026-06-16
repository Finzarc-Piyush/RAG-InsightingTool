import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/lib/api';
import { getUserEmail } from '@/utils/userStorage';
import { 
  AnalysisSessionSummary, 
  CompleteAnalysisData, 
  ColumnStatisticsResponse,
  RawDataResponse,
  UserAnalysisSessionsResponse 
} from '@/shared/schema';

interface AnalysisHistoryProps {
  onLoadAnalysis?: (analysisData: CompleteAnalysisData) => void;
}

export function AnalysisHistory({ onLoadAnalysis }: AnalysisHistoryProps) {
  const [sessions, setSessions] = useState<AnalysisSessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<CompleteAnalysisData | null>(null);
  const [columnStats, setColumnStats] = useState<ColumnStatisticsResponse | null>(null);
  const [rawData, setRawData] = useState<RawDataResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const { toast } = useToast();

  const userEmail = getUserEmail();

  const loadUserSessions = useCallback(async () => {
    if (!userEmail) return;

    setLoading(true);
    try {
      const response = await api.get<UserAnalysisSessionsResponse>(`/data/user/${userEmail}/sessions`);
      setSessions(response.sessions);
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to load analysis sessions',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [userEmail, toast]);

  useEffect(() => {
    if (userEmail) {
      loadUserSessions();
    }
  }, [userEmail, loadUserSessions]);

  const loadAnalysisData = async (chatId: string) => {
    if (!userEmail) return;
    
    setLoading(true);
    try {
      const response = await api.get<CompleteAnalysisData>(`/data/chat/${chatId}?username=${userEmail}`);
      setSelectedSession(response);
      setActiveTab('overview');
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to load analysis data',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const loadColumnStatistics = async (chatId: string) => {
    if (!userEmail) return;
    
    try {
      const response = await api.get<ColumnStatisticsResponse>(`/data/chat/${chatId}/statistics?username=${userEmail}`);
      setColumnStats(response);
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to load column statistics',
        variant: 'destructive',
      });
    }
  };

  const loadRawData = async (chatId: string, page = 1, limit = 100) => {
    if (!userEmail) return;
    
    try {
      const response = await api.get<RawDataResponse>(`/data/chat/${chatId}/raw-data?username=${userEmail}&page=${page}&limit=${limit}`);
      setRawData(response);
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to load raw data',
        variant: 'destructive',
      });
    }
  };

  const handleLoadAnalysis = (session: AnalysisSessionSummary) => {
    loadAnalysisData(session.id);
    if (onLoadAnalysis) {
      // Load complete data for the callback
      loadAnalysisData(session.id).then(() => {
        if (selectedSession) {
          onLoadAnalysis(selectedSession);
        }
      });
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  if (loading && sessions.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
              <p className="text-muted-foreground">Loading analysis history...</p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (sessions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Analysis History</CardTitle>
          <CardDescription>Your previously uploaded data analyses will appear here</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <p className="text-muted-foreground">No analysis sessions found</p>
            <p className="text-sm text-muted-foreground mt-2">Upload a file to start analyzing your data</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Sessions List */}
      <Card>
        <CardHeader>
          <CardTitle>Analysis History</CardTitle>
          <CardDescription>Your previously uploaded data analyses</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {sessions.map((session) => (
              <div key={session.id} className="border rounded-lg p-4 hover:bg-muted/50 transition-colors">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <h3 className="font-semibold">{session.fileName}</h3>
                    <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                      <span>Uploaded: {formatDate(session.uploadedAt)}</span>
                      <span>•</span>
                      <span>{session.dataSummary.rowCount} rows, {session.dataSummary.columnCount} columns</span>
                      <span>•</span>
                      <span>{session.chartsCount} charts, {session.insightsCount} insights</span>
                      <span>•</span>
                      <span>{formatFileSize(session.analysisMetadata.fileSize)}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <Badge variant="secondary">
                        {session.dataSummary.numericColumns.length} numeric columns
                      </Badge>
                      <Badge variant="outline">
                        Processing: {session.analysisMetadata.totalProcessingTime}ms
                      </Badge>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => loadAnalysisData(session.id)}
                    >
                      View Details
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => handleLoadAnalysis(session)}
                    >
                      Load Analysis
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Analysis Details */}
      {selectedSession && (
        <Card>
          <CardHeader>
            <CardTitle>Analysis Details: {selectedSession.fileName}</CardTitle>
            <CardDescription>
              Complete analysis data including charts, insights, and statistics
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="statistics">Statistics</TabsTrigger>
                <TabsTrigger value="raw-data">Raw Data</TabsTrigger>
                <TabsTrigger value="charts">Charts & Insights</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="text-center p-4 border rounded-lg">
                    <div className="text-2xl font-bold">{selectedSession.dataSummary.rowCount}</div>
                    <div className="text-sm text-muted-foreground">Total Rows</div>
                  </div>
                  <div className="text-center p-4 border rounded-lg">
                    <div className="text-2xl font-bold">{selectedSession.dataSummary.columnCount}</div>
                    <div className="text-sm text-muted-foreground">Total Columns</div>
                  </div>
                  <div className="text-center p-4 border rounded-lg">
                    <div className="text-2xl font-bold">{selectedSession.dataSummary.numericColumns.length}</div>
                    <div className="text-sm text-muted-foreground">Numeric Columns</div>
                  </div>
                  <div className="text-center p-4 border rounded-lg">
                    <div className="text-2xl font-bold">{selectedSession.charts.length}</div>
                    <div className="text-sm text-muted-foreground">Generated Charts</div>
                  </div>
                </div>

                <div className="space-y-4">
                  <h3 className="font-semibold">Column Information</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <h4 className="font-medium mb-2">Numeric Columns</h4>
                      <div className="flex flex-wrap gap-2">
                        {selectedSession.dataSummary.numericColumns.map((col) => (
                          <Badge key={col} variant="secondary">{col}</Badge>
                        ))}
                      </div>
                    </div>
                    <div>
                      <h4 className="font-medium mb-2">Date Columns</h4>
                      <div className="flex flex-wrap gap-2">
                        {selectedSession.dataSummary.dateColumns.length > 0 ? (
                          selectedSession.dataSummary.dateColumns.map((col) => (
                            <Badge key={col} variant="outline">{col}</Badge>
                          ))
                        ) : (
                          <span className="text-muted-foreground">No date columns</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <h3 className="font-semibold">Analysis Metadata</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <div className="font-medium">Processing Time</div>
                      <div className="text-muted-foreground">{selectedSession.analysisMetadata.totalProcessingTime}ms</div>
                    </div>
                    <div>
                      <div className="font-medium">AI Model</div>
                      <div className="text-muted-foreground">{selectedSession.analysisMetadata.aiModelUsed}</div>
                    </div>
                    <div>
                      <div className="font-medium">File Size</div>
                      <div className="text-muted-foreground">{formatFileSize(selectedSession.analysisMetadata.fileSize)}</div>
                    </div>
                    <div>
                      <div className="font-medium">Analysis Version</div>
                      <div className="text-muted-foreground">{selectedSession.analysisMetadata.analysisVersion}</div>
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="statistics">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">Column Statistics</h3>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => loadColumnStatistics(selectedSession.id)}
                    >
                      Load Statistics
                    </Button>
                  </div>
                  
                  {columnStats && (
                    <div className="space-y-4">
                      {Object.entries(columnStats.columnStatistics).map(([column, stats]) => (
                        <div key={column} className="border rounded-lg p-4">
                          <h4 className="font-medium mb-3">{column}</h4>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                            <div>
                              <div className="font-medium">Count</div>
                              <div className="text-muted-foreground">{stats.count}</div>
                            </div>
                            <div>
                              <div className="font-medium">Mean</div>
                              <div className="text-muted-foreground">{stats.mean}</div>
                            </div>
                            <div>
                              <div className="font-medium">Median</div>
                              <div className="text-muted-foreground">{stats.median}</div>
                            </div>
                            <div>
                              <div className="font-medium">Std Dev</div>
                              <div className="text-muted-foreground">{stats.standardDeviation}</div>
                            </div>
                            <div>
                              <div className="font-medium">Min</div>
                              <div className="text-muted-foreground">{stats.min}</div>
                            </div>
                            <div>
                              <div className="font-medium">Max</div>
                              <div className="text-muted-foreground">{stats.max}</div>
                            </div>
                            <div>
                              <div className="font-medium">Range</div>
                              <div className="text-muted-foreground">{stats.range}</div>
                            </div>
                            <div>
                              <div className="font-medium">Sum</div>
                              <div className="text-muted-foreground">{stats.sum}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="raw-data">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">Raw Data</h3>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => loadRawData(selectedSession.id)}
                    >
                      Load Raw Data
                    </Button>
                  </div>
                  
                  {rawData && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between text-sm text-muted-foreground">
                        <span>Showing {rawData.data.length} of {rawData.pagination.totalRows} rows</span>
                        <span>Page {rawData.pagination.page} of {rawData.pagination.totalPages}</span>
                      </div>
                      
                      <div className="border rounded-lg overflow-hidden">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              {rawData.data.length > 0 && Object.keys(rawData.data[0]).map((column) => (
                                <TableHead key={column}>{column}</TableHead>
                              ))}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {rawData.data.map((row, index) => (
                              <TableRow key={index}>
                                {Object.values(row).map((value, cellIndex) => (
                                  <TableCell key={cellIndex}>
                                    {value !== null ? String(value) : '-'}
                                  </TableCell>
                                ))}
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="charts">
                <div className="space-y-4">
                  <h3 className="font-semibold">Generated Charts</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {selectedSession.charts.map((chart, index) => (
                      <div key={index} className="border rounded-lg p-4">
                        <h4 className="font-medium mb-2">{chart.title}</h4>
                        <div className="text-sm text-muted-foreground mb-2">
                          Type: {chart.type} | X: {chart.x} | Y: {chart.y}
                        </div>
                        {chart.keyInsight && (
                          <div className="text-sm">
                            <div className="font-medium">Key Insight:</div>
                            <div className="text-muted-foreground">{chart.keyInsight}</div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="space-y-4">
                    <h3 className="font-semibold">Key Insights</h3>
                    <div className="space-y-2">
                      {selectedSession.insights.map((insight) => (
                        <div key={insight.id} className="border rounded-lg p-4">
                          <div className="text-sm">{insight.text}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
