"use client";

import type { Draft } from "./model";

/** An approvable text needs a title and at least one paragraph, none of them blank. */
export function placeTextValid(draft: Draft | null) {
  return Boolean(draft?.title.trim() && draft.paragraphs.length && draft.paragraphs.every(item => item.text.trim()));
}

/** Title and per-paragraph editors shared by the place catalog and the drafts queue. */
export function PlaceTextFields({ draft, disabled, onChange }: { draft: Draft; disabled: boolean; onChange: (next: Draft) => void }) {
  return <>
    <label htmlFor="content-title">Заголовок</label>
    <input id="content-title" value={draft.title} disabled={disabled}
      onChange={event => onChange({ ...draft, title: event.target.value })} />
    {draft.paragraphs.map((paragraph, index) => <div className="admin-paragraph" key={index}>
      <label htmlFor={`content-paragraph-${index}`}>Абзац {index + 1}</label>
      <textarea id={`content-paragraph-${index}`} rows={6} value={paragraph.text} disabled={disabled}
        onChange={event => onChange({ ...draft, paragraphs: draft.paragraphs.map((value, i) => i === index ? { ...value, text: event.target.value } : value) })} />
    </div>)}
  </>;
}
