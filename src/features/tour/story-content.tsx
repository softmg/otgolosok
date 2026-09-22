import { useId } from "react";
import type { HistoricalContent } from "./types";

export function StoryText({ story }: { story: HistoricalContent["story"] }) {
  return <div className="story-text">
    {story.paragraphs.map((paragraph) => <p key={paragraph.id}>{paragraph.text}</p>)}
  </div>;
}

export function StorySources({ content, open, onToggle }: {
  content: HistoricalContent;
  open: boolean;
  onToggle: () => void;
}) {
  const sourcesId = useId();
  const checkedAt = content.story.checked_at && !Number.isNaN(new Date(content.story.checked_at).getTime())
    ? new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(content.story.checked_at))
    : null;
  return <div className="source-control">
    <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={sourcesId}>
      {open ? "Скрыть источники" : "Откуда это известно?"}
    </button>
    <div id={sourcesId} hidden={!open}>
      {checkedAt ? <p className="source-note">Проверено по публикациям {checkedAt}</p> : <p className="source-note">Дата проверки не указана.</p>}
      <ol className="source-list">{content.sources.map((source) => (
        <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>
      ))}</ol>
      <details className="fact-details">
        <summary>Факты и подтверждения · {content.facts.length}</summary>
        <ol className="fact-list">{content.facts.map((fact) => (
          <li key={fact.id}>
            <p>{fact.claim}</p>
            {fact.confidence !== "verified" ? <p className="source-note">{fact.confidence === "legend" ? "Легенда" : "Требует проверки"}</p> : null}
            {fact.evidence.map((evidence) => {
              const sourceIndex = content.sources.findIndex((source) => source.id === evidence.source_id);
              const source = content.sources[sourceIndex];
              if (!source) return null;
              return <p className="fact-evidence" key={`${evidence.source_id}:${evidence.locator}`}>
                <a href={source.url} target="_blank" rel="noreferrer" aria-label={`${source.title}. ${evidence.locator}`}>
                  [{sourceIndex + 1}] {evidence.locator}
                </a>
                <span>{evidence.summary}</span>
              </p>;
            })}
          </li>
        ))}</ol>
      </details>
      <p className="source-note">{content.editorial_note}</p>
    </div>
  </div>;
}
