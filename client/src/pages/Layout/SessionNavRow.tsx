import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Pencil, Pin, PinOff, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Session } from '@/pages/Analysis/types';

type Props = {
  session: Session;
  busy: boolean;
  onNavigate: () => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  onRename: (sessionId: string, fileName: string) => void;
};

export function SessionNavRow({
  session,
  busy,
  onNavigate,
  onTogglePin,
  onRename,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(session.fileName);
      const t = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => clearTimeout(t);
    }
  }, [editing, session.fileName]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || trimmed === session.fileName) {
      setEditing(false);
      return;
    }
    onRename(session.sessionId, trimmed);
    setEditing(false);
  };

  const cancel = () => setEditing(false);

  const pinned = Boolean(session.pinned);

  return (
    <div
      className={cn(
        'group flex w-full items-center gap-1 rounded-lg px-2 py-1 text-xs text-sidebar-foreground hover:bg-sidebar-accent/80',
      )}
    >
      <button
        type="button"
        aria-label={pinned ? 'Unpin session' : 'Pin session'}
        title={pinned ? 'Unpin' : 'Pin to top'}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin(session.sessionId, !pinned);
        }}
        className={cn(
          'shrink-0 rounded p-1 hover:bg-sidebar-accent',
          pinned
            ? 'text-foreground'
            : 'text-muted-foreground opacity-50 group-hover:opacity-100',
        )}
      >
        {pinned ? (
          <Pin className="h-3.5 w-3.5 fill-current" aria-hidden />
        ) : (
          <PinOff className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>

      {editing ? (
        <>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
            placeholder={session.fileName}
            maxLength={200}
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
          />
          <button
            type="button"
            aria-label="Save name"
            title="Save"
            onClick={commit}
            className="shrink-0 rounded p-1 text-foreground hover:bg-sidebar-accent"
          >
            <Check className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Cancel rename"
            title="Cancel"
            onClick={cancel}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-sidebar-accent"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={onNavigate}
            className="flex min-w-0 flex-1 items-center gap-2 truncate text-left disabled:opacity-50"
            title={session.fileName}
          >
            {busy ? (
              <Loader2
                className="h-3.5 w-3.5 shrink-0 animate-spin"
                aria-hidden
              />
            ) : null}
            <span className="line-clamp-2">{session.fileName}</span>
          </button>
          <button
            type="button"
            aria-label="Rename session"
            title="Rename"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            className="shrink-0 rounded p-1 text-muted-foreground opacity-50 hover:bg-sidebar-accent group-hover:opacity-100 focus:opacity-100"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}
