import { useState, useEffect, useRef, useCallback } from "react";
import { searchNotes } from "./api";
import type { NoteMetadata } from "./api";

interface NoteLinkPaletteProps {
  x: number;
  y: number;
  initialFilter: string;
  recentNotes: NoteMetadata[];
  onSelect: (noteId: string, noteTitle: string) => void;
  onClose: () => void;
}

export function NoteLinkPalette({
  x,
  y,
  initialFilter,
  recentNotes,
  onSelect,
  onClose,
}: NoteLinkPaletteProps) {
  const [query, setQuery] = useState(initialFilter);
  const [results, setResults] = useState<NoteMetadata[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const displayedNotes = query.trim() ? results : recentNotes.slice(0, 8);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);

    if (!query.trim()) {
      setResults([]);
      setActiveIndex(0);
      return;
    }

    searchTimeout.current = setTimeout(async () => {
      try {
        const notes = await searchNotes(query);
        setResults(notes);
        setActiveIndex(0);
      } catch {
        // Ignore search errors
      }
    }, 200);

    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
    };
  }, [query]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) =>
          displayedNotes.length > 0 ? (i + 1) % displayedNotes.length : 0,
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) =>
          displayedNotes.length > 0
            ? (i - 1 + displayedNotes.length) % displayedNotes.length
            : 0,
        );
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (displayedNotes[activeIndex]) {
          onSelect(displayedNotes[activeIndex].id, displayedNotes[activeIndex].title);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [activeIndex, displayedNotes, onSelect, onClose],
  );

  return (
    <div className="note-link-palette" style={{ left: x, top: y }}>
      <input
        ref={inputRef}
        className="note-link-search"
        type="text"
        placeholder="Search notes..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onClose}
      />
      {displayedNotes.length > 0 && (
        <div className="note-link-list">
          {displayedNotes.map((note, i) => (
            <button
              key={note.id}
              className={`note-link-item ${i === activeIndex ? "active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(note.id, note.title);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              {note.title}
            </button>
          ))}
        </div>
      )}
      {displayedNotes.length === 0 && query.trim() && (
        <div className="note-link-empty">No notes found</div>
      )}
    </div>
  );
}
