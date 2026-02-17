import { useMemo, useCallback } from "react";
import { marked } from "marked";
import { openUrl } from "./api";

interface MarkdownViewProps {
  content: string;
  onEdit: () => void;
  onNoteNavigate?: (noteId: string, metaKey: boolean) => void;
}

export function MarkdownView({ content, onEdit, onNoteNavigate }: MarkdownViewProps) {
  const html = useMemo(
    () => marked.parse(content, { breaks: true }) as string,
    [content],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      let target = e.target as HTMLElement | null;
      while (target && target !== e.currentTarget) {
        if (target.tagName === "A") {
          const href = (target as HTMLAnchorElement).getAttribute("href");
          if (href) {
            e.preventDefault();
            if (href.startsWith("note://")) {
              const uuid = href.slice("note://".length);
              onNoteNavigate?.(uuid, e.metaKey || e.ctrlKey);
            } else {
              openUrl(href);
            }
          }
          return;
        }
        target = target.parentElement;
      }
      onEdit();
    },
    [onEdit, onNoteNavigate],
  );

  return (
    <div
      className="markdown-view"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
