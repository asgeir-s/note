import { useEffect, useRef } from "react";
import { isPinnedNotePath } from "./api";
import type { NoteMetadata, SortBy } from "./api";

interface NotesListProps {
  notes: NoteMetadata[];
  label: string;
  loading?: boolean;
  onOpenNote: (id: string, metaKey: boolean) => void;
  highlightIndex?: number;
  sortBy: SortBy;
  onSortChange: (sortBy: SortBy) => void;
  tabs?: { label: string; active: boolean; onClick: () => void }[];
}

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour > 1 ? "s" : ""} ago`;
  if (diffDay === 1) return "yesterday";
  if (diffDay < 7) return `${diffDay} days ago`;
  return date.toLocaleDateString();
}

export function NotesList({
  notes,
  label,
  loading,
  onOpenNote,
  highlightIndex = -1,
  sortBy,
  onSortChange,
  tabs,
}: NotesListProps) {
  const highlightRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  if (notes.length === 0 && !loading) return null;

  return (
    <div className="notes-list">
      <div className="notes-list-header">
        {tabs ? (
          <div className="notes-list-tabs">
            {tabs.map((tab) => (
              <button
                key={tab.label}
                className={`notes-tab ${tab.active ? "active" : ""}`}
                onClick={tab.onClick}
              >
                {tab.label}
              </button>
            ))}
          </div>
        ) : (
          <span>
            {label}
            {loading && <span className="related-loading"> ...</span>}
          </span>
        )}
        <button
          className="sort-toggle"
          onClick={() =>
            onSortChange(sortBy === "created" ? "modified" : "created")
          }
        >
          {sortBy === "created" ? "Created" : "Updated"}
        </button>
      </div>
      {notes.map((note, i) => {
        return (
          <div key={note.id}>
            <button
              ref={i === highlightIndex ? highlightRef : undefined}
              className={`note-item ${i === highlightIndex ? "highlighted" : ""}`}
              onClick={(e) => onOpenNote(note.id, e.metaKey || e.ctrlKey)}
            >
              <span className="note-item-title">
                {isPinnedNotePath(note.path) && (
                  <span className="note-item-pin">
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      xmlns="http://www.w3.org/2000/svg"
                      aria-hidden="true"
                    >
                      <line x1="12" x2="12" y1="17" y2="22" />
                      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
                    </svg>
                  </span>
                )}
                {note.tags.includes("meeting") && (
                  <span className="note-item-meeting">⏺</span>
                )}
                {note.title}
              </span>
              <span className="note-item-time">
                {relativeTime(
                  sortBy === "modified" ? note.modified : note.created,
                )}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
