"use client";

import Link from "next/link";
import type { FormEvent, Ref } from "react";
import { BrandMark } from "../brand/brand-mark";
import { ExploreIcon } from "./icons";
import a from "./around.module.css";
import styles from "./around-header.module.css";

/** Header island of the home map: brand, search toggle and, when open, the address search. */
export function AroundHeader({ search, query, busy, inputRef, onToggle, onQuery, onSubmit }: {
  search: boolean; query: string; busy: boolean; inputRef: Ref<HTMLInputElement>;
  onToggle: () => void; onQuery: (value: string) => void; onSubmit: (event: FormEvent) => void;
}) {
  return <>
    <div className={styles.topline}>
      <Link href="/" prefetch={false} className={styles.brand}><BrandMark /></Link>
      <button className={a.iconButton} type="button" aria-label={search ? "Закрыть поиск" : "Найти адрес"} onClick={onToggle}><ExploreIcon name={search ? "close" : "search"} /></button>
    </div>
    {search ? <form className={styles.search} onSubmit={onSubmit}>
      <label htmlFor="map-address">Какой дом вас интересует?</label>
      <div className={styles.searchRow}>
        <input id="map-address" ref={inputRef} value={query} onChange={event => onQuery(event.target.value)} minLength={3} maxLength={180} required placeholder="Улица и номер дома в Москве" autoComplete="off" />
        <button type="submit" disabled={busy || query.trim().length < 3} aria-label="Найти дом"><ExploreIcon name="arrow" /></button>
      </div>
      <Link href={`/create?${new URLSearchParams(query.trim() ? { address: query.trim() } : { new: "1" })}`} prefetch={false}>Ввести адрес для истории вручную →</Link>
    </form> : null}
  </>;
}
