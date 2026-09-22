"use client";

import { useRef, useState } from "react";
import { ExploreIcon } from "../explore/icons";

export function AddressInput({ label, initialValue = "", onResolve, onCancel, disabled = false }: {
  label: string; initialValue?: string; onResolve: (query: string) => Promise<void>; onCancel: () => void; disabled?: boolean;
}) {
  const [query, setQuery] = useState(initialValue);
  const pending = useRef(false);
  return <form className="creation-address-editor" onSubmit={async event => {
    event.preventDefault();
    if (disabled || pending.current || query.trim().length < 3) return;
    pending.current = true;
    try { await onResolve(query.trim()); }
    finally { pending.current = false; }
  }}>
    <label className="creation-address-label"><span>{label}</span><input disabled={disabled} autoFocus value={query} required minLength={3} maxLength={180} placeholder="Улица и номер дома" autoComplete="street-address" enterKeyHint="done" onChange={event => setQuery(event.target.value)} /></label>
    <button type="submit" className="creation-address-submit" disabled={disabled || query.trim().length < 3} aria-label="Подтвердить адрес">{disabled ? "…" : "✓"}</button>
    <button type="button" className="creation-address-cancel" disabled={disabled} onClick={onCancel} aria-label={`Отменить ввод: ${label}`}><ExploreIcon name="close" /></button>
  </form>;
}
