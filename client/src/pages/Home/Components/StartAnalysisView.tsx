import { Database, Upload, FileSpreadsheet } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface StartAnalysisViewProps {
  onSelectUpload: () => void;
  onSelectSnowflake: () => void;
}

export function StartAnalysisView({ onSelectUpload, onSelectSnowflake }: StartAnalysisViewProps) {
  return (
    <div className="h-[calc(100vh-80px)] bg-gradient-to-br from-slate-50 to-white flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">
            Welcome to Marico Insight
          </h1>
          <p className="text-base text-gray-600">
            Choose how you want to start your analysis
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Card
            className="cursor-pointer transition-all duration-300 rounded-2xl border-2 border-dashed border-gray-200 hover:border-primary/50 hover:bg-primary/5 hover:shadow-lg bg-white shadow-sm overflow-hidden"
            onClick={onSelectSnowflake}
            data-testid="start-snowflake"
          >
            <div className="flex flex-col items-center justify-center py-10 px-6">
              <div className="w-16 h-16 rounded-full bg-sky-100 flex items-center justify-center mb-4">
                <Database className="w-8 h-8 text-sky-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Import from Snowflake
              </h3>
              <p className="text-sm text-gray-500 text-center mb-4">
                Connect to your Snowflake account and import a table for analysis
              </p>
              <Button variant="outline" size="sm" className="pointer-events-none">
                Connect & select table
              </Button>
            </div>
          </Card>

          <Card
            className="cursor-pointer transition-all duration-300 rounded-2xl border-2 border-dashed border-gray-200 hover:border-primary/50 hover:bg-primary/5 hover:shadow-lg bg-white shadow-sm overflow-hidden"
            onClick={onSelectUpload}
            data-testid="start-upload"
          >
            <div className="flex flex-col items-center justify-center py-10 px-6">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                <Upload className="w-8 h-8 text-primary" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Upload CSV / Excel
              </h3>
              <p className="text-sm text-gray-500 text-center mb-4">
                Drag & drop or browse to upload your data file
              </p>
              <div className="flex items-center gap-2 text-xs text-gray-400 bg-gray-50 px-3 py-1.5 rounded-full">
                <FileSpreadsheet className="w-3 h-3" />
                <span>CSV, XLS, XLSX • Max 500MB</span>
              </div>
            </div>
          </Card>
        </div>

        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="text-center p-4 rounded-xl bg-white shadow-sm transition-shadow">
            <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center mx-auto mb-3">
              <span className="text-lg">📊</span>
            </div>
            <h4 className="font-semibold text-gray-900 mb-1 text-sm">Smart Charts</h4>
            <p className="text-xs text-gray-500">Auto-generated visualizations</p>
          </div>
          <div className="text-center p-4 rounded-xl bg-white shadow-sm transition-shadow">
            <div className="w-10 h-10 bg-yellow-100 rounded-lg flex items-center justify-center mx-auto mb-3">
              <span className="text-lg">💡</span>
            </div>
            <h4 className="font-semibold text-gray-900 mb-1 text-sm">AI Insights</h4>
            <p className="text-xs text-gray-500">Actionable suggestions</p>
          </div>
          <div className="text-center p-4 rounded-xl bg-white shadow-sm transition-shadow">
            <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center mx-auto mb-3">
              <span className="text-lg">💬</span>
            </div>
            <h4 className="font-semibold text-gray-900 mb-1 text-sm">Natural Language</h4>
            <p className="text-xs text-gray-500">Ask questions about your data</p>
          </div>
        </div>
      </div>
    </div>
  );
}
