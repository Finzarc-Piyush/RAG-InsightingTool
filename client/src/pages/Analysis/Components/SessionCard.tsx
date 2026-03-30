import { Calendar, FileText, MessageSquare, BarChart3, Loader2, Trash2, Edit2, Share2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Session } from '../types';
import { formatDate, formatFileName } from '../utils/formatting';

interface SessionCardProps {
  session: Session;
  isLoading: boolean;
  onSessionClick: (session: Session) => void;
  onEditClick: (e: React.MouseEvent, session: Session) => void;
  onDeleteClick: (e: React.MouseEvent, session: Session) => void;
  onShareClick: (e: React.MouseEvent, session: Session) => void;
}

/**
 * Card component for displaying a single analysis session
 * Shows session metadata and action buttons
 */
export const SessionCard = ({
  session,
  isLoading,
  onSessionClick,
  onEditClick,
  onDeleteClick,
  onShareClick,
}: SessionCardProps) => {
  return (
    <Card
      className={cn(
        'relative border-border/80 transition-shadow hover:shadow-md',
        isLoading ? 'cursor-wait opacity-75' : 'cursor-pointer'
      )}
      onClick={() => !isLoading && onSessionClick(session)}
    >
      {isLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-card/85 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-6 w-6 animate-spin text-primary motion-reduce:animate-none" />
            <p className="text-sm font-medium text-muted-foreground">Loading…</p>
          </div>
        </div>
      )}
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <FileText className="h-5 w-5 shrink-0 text-primary" />
              <h3 className="text-lg font-semibold text-foreground">
                {formatFileName(session.fileName)}
              </h3>
              <Badge variant="secondary" className="text-xs">
                {session.id.split('_')[0]}
              </Badge>
            </div>

            <div className="mb-3 flex items-center gap-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-1">
                <Calendar className="h-4 w-4" />
                <span>Last analysis {formatDate(session.lastUpdatedAt)}</span>
              </div>
              <div className="flex items-center gap-1">
                <MessageSquare className="h-4 w-4" />
                <span>{session.messageCount} messages</span>
              </div>
              <div className="flex items-center gap-1">
                <BarChart3 className="h-4 w-4" />
                <span>{session.chartCount} charts</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-right text-sm text-muted-foreground">
              <div>{new Date(session.lastUpdatedAt).toLocaleDateString()}</div>
              <div className="text-xs">
                {new Date(session.lastUpdatedAt).toLocaleTimeString()}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => onShareClick(e, session)}
                disabled={isLoading}
                className="text-primary hover:bg-primary/10 hover:text-primary disabled:opacity-50"
                title="Share analysis"
              >
                <Share2 className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => onEditClick(e, session)}
                disabled={isLoading}
                className="text-primary hover:bg-primary/10 hover:text-primary disabled:opacity-50"
                title="Edit analysis name"
              >
                <Edit2 className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => onDeleteClick(e, session)}
                disabled={isLoading}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                title="Delete analysis"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

