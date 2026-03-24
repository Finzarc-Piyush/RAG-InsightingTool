import { type ChangeEvent, useEffect, useRef } from 'react';
import { Database, Upload, FileSpreadsheet } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface StartAnalysisViewProps {
  onSelectUpload: (file: File) => void;
  onSelectSnowflake: () => void;
  uploadDialogTrigger?: number;
  isUploadStarting?: boolean;
}

export function StartAnalysisView({
  onSelectUpload,
  onSelectSnowflake,
  uploadDialogTrigger = 0,
  isUploadStarting = false,
}: StartAnalysisViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastTriggerRef = useRef<number>(0);

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;
    if (selectedFile.size > 500 * 1024 * 1024) {
      alert('File size must be less than 500MB');
      event.target.value = '';
      return;
    }
    onSelectUpload(selectedFile);
    event.target.value = '';
  };

  useEffect(() => {
    if (uploadDialogTrigger > 0 && uploadDialogTrigger !== lastTriggerRef.current) {
      lastTriggerRef.current = uploadDialogTrigger;
      openFilePicker();
    }
  }, [uploadDialogTrigger]);

  return (
    <div className="h-[calc(100vh-80px)] bg-gradient-to-br from-slate-50 to-white flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <input
          ref={fileInputRef}
          type="file"
          accept=".xls,.xlsx"
          className="hidden"
          onChange={handleFileInputChange}
        />
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">
            Welcome to Marico RAGAlytics
          </h1>
          <p className="text-base text-gray-600">
            Choose your data
          </p>
          {isUploadStarting && (
            <p className="mt-3 text-sm text-primary font-medium">
              Uploading file... we will switch to preview as soon as the server acknowledges.
            </p>
          )}
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
                Pick a table from Snowflake
              </p>
              <Button variant="outline" size="sm" className="pointer-events-none">
                Connect
              </Button>
            </div>
          </Card>

          <Card
            className={`transition-all duration-300 rounded-2xl border-2 border-dashed border-gray-200 bg-white shadow-sm overflow-hidden ${isUploadStarting ? 'opacity-75 cursor-not-allowed' : 'cursor-pointer hover:border-primary/50 hover:bg-primary/5 hover:shadow-lg'}`}
            onClick={() => {
              if (!isUploadStarting) openFilePicker();
            }}
            data-testid="start-upload"
          >
            <div className="flex flex-col items-center justify-center py-10 px-6">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                <Upload className="w-8 h-8 text-primary" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Upload Excel
              </h3>
              <p className="text-sm text-gray-500 text-center mb-4">
                {isUploadStarting ? 'Upload in progress...' : 'Drag and drop / Browse'}
              </p>
              <div className="flex items-center gap-2 text-xs text-gray-400 bg-gray-50 px-3 py-1.5 rounded-full">
                <FileSpreadsheet className="w-3 h-3" />
                <span>XLS, XLSX</span>
              </div>
            </div>
          </Card>
        </div>

        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="text-center p-4 rounded-xl bg-white shadow-sm transition-shadow">
            <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center mx-auto mb-3">
              <span className="text-lg">📊</span>
            </div>
            <h4 className="font-semibold text-gray-900 mb-1 text-sm">Assisted Analysis with Collaborators</h4>
            <p className="text-xs text-gray-500">Auto-generated visualizations</p>
          </div>
          <div className="text-center p-4 rounded-xl bg-white shadow-sm transition-shadow">
            <div className="w-10 h-10 bg-yellow-100 rounded-lg flex items-center justify-center mx-auto mb-3">
              <span className="text-lg">💡</span>
            </div>
            <h4 className="font-semibold text-gray-900 mb-1 text-sm">Quick Dashboarding with Insights</h4>
            <p className="text-xs text-gray-500">Actionable suggestions</p>
          </div>
          <div className="text-center p-4 rounded-xl bg-white shadow-sm transition-shadow">
            <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center mx-auto mb-3">
              <span className="text-lg">💬</span>
            </div>
            <h4 className="font-semibold text-gray-900 mb-1 text-sm">Automations to save repeat work</h4>
            <p className="text-xs text-gray-500">Ask questions about your data</p>
          </div>
        </div>
      </div>
    </div>
  );
}
