import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror, { ReactCodeMirrorRef, ViewUpdate } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { keymap } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type NoteSummary = {
  id: string;
  path: string;
  title: string;
  created: string;
  tags: string[];
};

type SaveResponse = {
  note: NoteSummary;
  content: string;
};

type AppData = {
  notesDir: string;
  recent: NoteSummary[];
  tags: string[];
};

const SLASH_COMMANDS = [
  { label: "/h1", insert: "# " },
  { label: "/h2", insert: "## " },
  { label: "/h3", insert: "### " },
  { label: "/quote", insert: "> " },
  { label: "/list", insert: "- " },
  { label: "/ol", insert: "1. " },
  { label: "/code", insert: "```\n\n```" },
  { label: "/link", insert: "<a>text</a>" },
  { label: "/note", insert: "[[note:]]" },
  { label: "/divider", insert: "---" },
  { label: "/tag", insert: "" },
];

const hasTauriInvoke = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const WEB_DEMO_NOTES: NoteSummary[] = [
  {
    id: "a1b2c3d4-5678-90ab-cdef-1234567890ab",
    path: "20260216143200-main_note.md",
    title: "Main note",
    created: "2026-02-16T14:32:00+01:00",
    tags: ["demo"],
  },
  {
    id: "e5f6a7b8-1234-5678-90ab-cdef12345678",
    path: "20260216150000-related_note.md",
    title: "Related note",
    created: "2026-02-16T15:00:00+01:00",
    tags: ["demo"],
  },
];
const WEB_DEMO_CONTENT: Record<string, string> = {
  "20260216143200-main_note.md":
    "---\nid: a1b2c3d4-5678-90ab-cdef-1234567890ab\ncreated: 2026-02-16T14:32:00+01:00\ntags: [demo]\n---\n\n# Main note\n\nConnected [[note:e5f6a7b8-1234-5678-90ab-cdef12345678]].\n",
  "20260216150000-related_note.md":
    "---\nid: e5f6a7b8-1234-5678-90ab-cdef12345678\ncreated: 2026-02-16T15:00:00+01:00\ntags: [demo]\n---\n\n# Related note\n\nBack to [[note:a1b2c3d4-5678-90ab-cdef-1234567890ab]].\n",
};

async function backendInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasTauriInvoke()) {
    if (command === "get_app_data") {
      return { notesDir: "", recent: WEB_DEMO_NOTES, tags: ["demo"] } as T;
    }
    if (command === "list_recent_notes") {
      return WEB_DEMO_NOTES as T;
    }
    if (command === "search_notes") {
      const query = String(args?.query ?? "").toLowerCase();
      return WEB_DEMO_NOTES.filter((note) => note.title.toLowerCase().includes(query)) as T;
    }
    if (command === "list_tags") {
      return ["demo"] as T;
    }
    if (command === "open_note") {
      const path = String(args?.path ?? "");
      return (WEB_DEMO_CONTENT[path] ?? "") as T;
    }
    if (command === "save_note") {
      return {
        note: { id: "", path: "", title: "", created: "", tags: [] },
        content: (args?.request as { content?: string } | undefined)?.content ?? "",
      } as T;
    }
  }
  return invoke<T>(command, args);
}

function App() {
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const [content, setContent] = useState("");
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [recentNotes, setRecentNotes] = useState<NoteSummary[]>([]);
  const [relatedNotes, setRelatedNotes] = useState<NoteSummary[]>([]);
  const [allNotes, setAllNotes] = useState<NoteSummary[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [cursorPos, setCursorPos] = useState(0);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [showTagInput, setShowTagInput] = useState(false);
  const [tagValue, setTagValue] = useState("");
  const [sideNote, setSideNote] = useState<{ note: NoteSummary; content: string } | null>(null);

  const shownNotes = content.trim()
    ? relatedNotes.length > 0
      ? relatedNotes
      : recentNotes
    : recentNotes;
  const isEditing = currentPath !== null;
  const currentEditingTitle = useMemo(
    () => allNotes.find((note) => note.path === currentPath)?.title ?? "Current note",
    [allNotes, currentPath],
  );
  const noteById = useMemo(
    () => new Map(allNotes.map((note) => [note.id, note])),
    [allNotes],
  );

  const slashMatches = useMemo(
    () =>
      slashQuery
        ? SLASH_COMMANDS.filter((cmd) => cmd.label.startsWith(slashQuery.toLowerCase()))
        : [],
    [slashQuery],
  );

  const cmExtensions = useMemo(
    () => [
      markdown(),
      keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            void saveCurrent();
            return true;
          },
        },
        {
          key: "Escape",
          run: () => {
            clearEditor();
            return true;
          },
        },
        {
          key: "Mod-t",
          run: () => {
            setShowTagInput(true);
            return true;
          },
        },
      ]),
    ],
    [],
  );

  async function initialize() {
    const data = await backendInvoke<AppData>("get_app_data");
    const notes = await backendInvoke<NoteSummary[]>("list_recent_notes", { limit: 10000 });
    setRecentNotes(data.recent);
    setAllNotes(notes);
    setAllTags(data.tags);
  }

  async function refreshRecentAndTags() {
    const [recent, tags, notes] = await Promise.all([
      backendInvoke<NoteSummary[]>("list_recent_notes"),
      backendInvoke<string[]>("list_tags"),
      backendInvoke<NoteSummary[]>("list_recent_notes", { limit: 10000 }),
    ]);
    setRecentNotes(recent);
    setAllTags(tags);
    setAllNotes(notes);
  }

  async function openNote(path: string) {
    const noteContent = await backendInvoke<string>("open_note", { path });
    setContent(noteContent);
    setCurrentPath(path);
    setSlashQuery(null);
    setShowTagInput(false);
  }

  async function openSideNote(note: NoteSummary) {
    const noteContent = await backendInvoke<string>("open_note", { path: note.path });
    setSideNote({ note, content: noteContent });
  }

  async function handleNoteSelection(note: NoteSummary) {
    if (isEditing) {
      await openSideNote(note);
      return;
    }
    await openNote(note.path);
  }

  function extractConnectedIds(markdownContent: string) {
    const ids = new Set<string>();
    const linkPattern = /\[\[note:([0-9a-fA-F-]{36})\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = linkPattern.exec(markdownContent)) !== null) {
      ids.add(match[1]);
    }
    return [...ids];
  }

  async function saveCurrent() {
    if (!content.trim()) return;
    const saved = await backendInvoke<SaveResponse>("save_note", {
      request: { content, existingPath: currentPath },
    });
    setContent("");
    setCurrentPath(null);
    setRelatedNotes([]);
    setSideNote(null);
    setShowTagInput(false);
    setTagValue("");
    await refreshRecentAndTags();
    return saved;
  }

  function clearEditor() {
    setContent("");
    setCurrentPath(null);
    setRelatedNotes([]);
    setSideNote(null);
    setSlashQuery(null);
    setShowTagInput(false);
    setTagValue("");
  }

  function upsertTag(tag: string) {
    const cleanTag = tag.trim();
    if (!cleanTag) return;
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!frontmatterMatch) {
      setContent(`---\ntags: [${cleanTag}]\n---\n\n${content.trimStart()}`);
      return;
    }

    const fm = frontmatterMatch[1];
    const body = content.slice(frontmatterMatch[0].length);
    if (fm.includes("tags:")) {
      const updated = fm.replace(/tags:\s*\[(.*?)\]/, (_, raw: string) => {
        const parts = raw
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
        if (!parts.includes(cleanTag)) parts.push(cleanTag);
        return `tags: [${parts.join(", ")}]`;
      });
      setContent(`---\n${updated}\n---\n${body}`);
      return;
    }
    setContent(`---\n${fm}\ntags: [${cleanTag}]\n---\n${body}`);
  }

  function relativeTime(timestamp: string) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "";
    const diff = Date.now() - date.getTime();
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return "just now";
    if (diff < hour) {
      const value = Math.floor(diff / minute);
      return `${value} min${value === 1 ? "" : "s"} ago`;
    }
    if (diff < day) {
      const value = Math.floor(diff / hour);
      return `${value} hour${value === 1 ? "" : "s"} ago`;
    }
    const days = Math.floor(diff / day);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }

  function detectSlash(text: string, position: number) {
    const before = text.slice(0, position);
    const token = before.split(/\s/).pop() ?? "";
    const prevChar = before[before.length - token.length - 1];
    if (token.startsWith("/") && (before.length === token.length || /\s/.test(prevChar ?? ""))) {
      setSlashQuery(token.toLowerCase());
      return;
    }
    setSlashQuery(null);
  }

  function applyCommand(label: string) {
    const command = SLASH_COMMANDS.find((item) => item.label === label);
    if (!command || !editorRef.current?.view) return;

    const view = editorRef.current.view;
    const from = Math.max(0, cursorPos - (slashQuery?.length ?? 0));
    const to = cursorPos;

    if (label === "/tag") {
      view.dispatch({ changes: { from, to, insert: "" } });
      setShowTagInput(true);
      setSlashQuery(null);
      return;
    }

    view.dispatch({
      changes: { from, to, insert: command.insert },
      selection: { anchor: from + command.insert.length },
    });
    setSlashQuery(null);
  }

  useEffect(() => {
    void initialize();
  }, []);

  useEffect(() => {
    const handler = setTimeout(async () => {
      if (!content.trim()) {
        setRelatedNotes([]);
        return;
      }
      const lines = content.trim().split("\n");
      const query = (lines[lines.length - 1] ?? "").trim();
      const matches = await backendInvoke<NoteSummary[]>("search_notes", { query, limit: 6 });
      setRelatedNotes(matches);
    }, 500);
    return () => clearTimeout(handler);
  }, [content]);

  return (
    <main className="dump-shell">
      <section className={`editor-layout${sideNote ? " with-side" : ""}`}>
        <div className="editor-column">
          {isEditing && (
            <div className="edit-indicator">
              Editing: <strong>{currentEditingTitle}</strong>
            </div>
          )}
          <CodeMirror
            ref={editorRef}
            value={content}
            extensions={cmExtensions}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
            }}
            placeholder="Write..."
            onChange={(value) => setContent(value)}
            onUpdate={(update: ViewUpdate) => {
              if (update.selectionSet || update.docChanged) {
                const position = update.state.selection.main.head;
                setCursorPos(position);
                detectSlash(update.state.doc.toString(), position);
              }
            }}
          />

          {showTagInput && (
            <div className="tag-input-row">
              <input
                autoFocus
                list="tag-suggestions"
                value={tagValue}
                placeholder="Tag..."
                onChange={(e) => setTagValue(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    upsertTag(tagValue);
                    setTagValue("");
                    setShowTagInput(false);
                  }
                  if (e.key === "Escape") {
                    setShowTagInput(false);
                  }
                }}
              />
              <datalist id="tag-suggestions">
                {allTags.map((tag) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
            </div>
          )}

          {slashMatches.length > 0 && (
            <div className="slash-palette">
              {slashMatches.map((cmd) => (
                <button key={cmd.label} type="button" onClick={() => applyCommand(cmd.label)}>
                  {cmd.label}
                </button>
              ))}
            </div>
          )}

          <div className="notes-list">
            {shownNotes.map((note) => (
              <button
                key={note.id}
                type="button"
                className="note-row"
                onClick={() => void handleNoteSelection(note)}
              >
                <span>{content.trim() ? `Related: "${note.title}"` : note.title}</span>
                {!content.trim() && <small>{relativeTime(note.created)}</small>}
              </button>
            ))}
          </div>
        </div>
        {sideNote && (
          <aside className="side-view">
            <div className="side-head">
              <strong>{sideNote.note.title}</strong>
              <button type="button" onClick={() => void openNote(sideNote.note.path).then(() => setSideNote(null))}>
                Start editing
              </button>
            </div>
            <pre>{sideNote.content}</pre>
            <div className="side-links">
              {extractConnectedIds(sideNote.content).map((id) => {
                const note = noteById.get(id);
                if (!note) return null;
                return (
                  <button key={id} type="button" onClick={() => void openSideNote(note)}>
                    {note.title}
                  </button>
                );
              })}
            </div>
          </aside>
        )}
      </section>
    </main>
  );
}

export default App;
