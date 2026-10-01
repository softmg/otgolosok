import { describe, expect, it } from "vitest";
import { audioBackfillNotice, batchItemStates, contentErrorOptions, contentStatusOptions, contentStatusStates, draftCheck, draftClipboardText, draftResearchOptions, draftResearchStatuses, initialDraft, pageCount, pageRange, safeSourceLink, type Draft, type Fact, type Job } from "./model";

const facts: Fact[] = Array.from({ length: 5 }, (_, index) => ({
  id: `f${index + 1}`, claim: "Verified claim", interesting: true, evidence: [],
}));
const draft: Draft = {
  title: "Editorial title",
  paragraphs: [
    { text: Array(50).fill("word").join(" "), factIds: ["f1", "f2", "f3"] },
    { text: Array(50).fill("word").join(" "), factIds: ["f4", "f5"] },
  ],
};

describe("editorial draft requirements", () => {
  it("accepts the minimum word and distinct-fact counts", () => {
    expect(draftCheck(draft, facts)).toEqual({ words: 100, facts: 5, valid: true });
  });
  it("rejects missing evidence, unknown facts and unlinked paragraphs", () => {
    expect(draftCheck(draft, []).valid).toBe(false);
    expect(draftCheck({ ...draft, paragraphs: [draft.paragraphs[0], { ...draft.paragraphs[1], factIds: ["f6"] }] }, facts).valid).toBe(false);
    expect(draftCheck({ ...draft, paragraphs: [draft.paragraphs[0], { ...draft.paragraphs[1], factIds: [] }] }, facts).valid).toBe(false);
  });
  it("rejects invalid lengths and empty titles", () => {
    expect(draftCheck({ ...draft, title: " " }, facts).valid).toBe(false);
    expect(draftCheck({ ...draft, title: "x".repeat(141) }, facts).valid).toBe(false);
    expect(draftCheck({ ...draft, paragraphs: [draft.paragraphs[0]] }, facts).valid).toBe(false);
    expect(draftCheck({ ...draft, paragraphs: Array(7).fill(draft.paragraphs[0]) }, facts).valid).toBe(false);
    expect(draftCheck({ ...draft, paragraphs: draft.paragraphs.map(p => ({ ...p, text: "short" })) }, facts).valid).toBe(false);
    expect(draftCheck({ ...draft, paragraphs: draft.paragraphs.map(p => ({ ...p, text: Array(126).fill("word").join(" ") })) }, facts).valid).toBe(false);
  });
  it("prefers the saved editorial draft and provides two empty paragraphs otherwise", () => {
    const job = { data: { editorDraft: draft, draft: { ...draft, title: "Model" }, draftCandidate: null } } as Job;
    expect(initialDraft(job)).toBe(draft);
    expect(initialDraft({ data: { editorDraft: null, draft: null, draftCandidate: null } } as Job).paragraphs).toHaveLength(2);
  });
});

describe("source links", () => {
  it("permits only absolute HTTP(S) URLs without credentials", () => {
    expect(safeSourceLink("https://example.org/source")).toBe("https://example.org/source");
    for (const value of [null, "javascript:alert(1)", "data:text/html,hello", "//example.org", "/source", "https://user:password@example.org"]) {
      expect(safeSourceLink(value)).toBeNull();
    }
  });
});

describe("группы состояний заданий", () => {
  it("покрывает каждое состояние задания ровно одним фильтром", () => {
    const covered = Object.values(contentStatusStates).flat();
    expect([...covered].sort()).toEqual(Object.keys(batchItemStates).sort());
    expect(new Set(covered).size).toBe(covered.length);
  });

  it("предлагает в списке те же фильтры, что и группировка состояний", () => {
    expect(contentStatusOptions.map(option => option.value)).toEqual(["all", ...Object.keys(contentStatusStates)]);
  });
});

describe("фильтр заданий по ошибке", () => {
  const errors = [{ code: "ADDRESS_UNCLEAR", count: 312 }, { code: null, count: 7 }];

  it("перечисляет коды с количеством и отдельный пункт для заданий без ошибки", () => {
    expect(contentErrorOptions(errors, "all")).toEqual([
      { value: "all", label: "Любая ошибка" },
      { value: "ADDRESS_UNCLEAR", label: "ADDRESS_UNCLEAR (312)" },
      { value: "none", label: "Без ошибки (7)" },
    ]);
  });

  it("сохраняет выбранный код, когда он исчез из партии после повтора", () => {
    expect(contentErrorOptions(errors, "TIMEOUT").at(-1)).toEqual({ value: "TIMEOUT", label: "TIMEOUT (0)" });
    expect(contentErrorOptions([], "none").at(-1)).toEqual({ value: "none", label: "Без ошибки (0)" });
  });

  it("не дублирует пункт, если выбранный код есть в списке", () => {
    expect(contentErrorOptions(errors, "ADDRESS_UNCLEAR")).toHaveLength(3);
  });
});

describe("фильтр черновиков по статусу переисследования", () => {
  it("перечисляет каждый статус с количеством, нули показывает тоже", () => {
    expect(draftResearchOptions({ plain: 561, perplexity: 24, queued: 20 })).toEqual([
      { value: "all", label: "Все черновики" },
      { value: "plain", label: "Ещё не переисследованы (561)" },
      { value: "perplexity", label: "Переисследованы через Perplexity (24)" },
      { value: "queued", label: "В очереди на переисследование (20)" },
      { value: "failed", label: "Переисследование не удалось (0)" },
    ]);
  });

  it("обнуляет счётчики, когда сервер их не прислал", () => {
    expect(draftResearchOptions().map(option => option.label)).toEqual([
      "Все черновики", "Ещё не переисследованы (0)", "Переисследованы через Perplexity (0)", "В очереди на переисследование (0)", "Переисследование не удалось (0)",
    ]);
  });

  it("у каждого статуса есть подпись для строки черновика", () => {
    for (const status of ["plain", "perplexity", "queued", "failed"] as const) {
      expect(draftResearchStatuses[status].length).toBeGreaterThan(0);
    }
  });
});

describe("подписи постраничной навигации", () => {
  it.each([
    [0, 50, 6107, "1–50 из 6107"],
    [6100, 7, 6107, "6101–6107 из 6107"],
    [0, 0, 0, "0"],
  ] as const)("описывает страницу со смещением %i", (offset, count, total, expected) => {
    expect(pageRange(offset, count, total)).toBe(expected);
  });

  it.each([[0, 1], [1, 1], [50, 1], [51, 2], [6107, 123]] as const)("считает страницы для %i записей", (total, pages) => {
    expect(pageCount(total, 50)).toBe(pages);
  });
});

describe("bulk voicing notice", () => {
  const base = { queued: 0, retried: 0, alreadyQueued: 0, failed: 0, inspected: 0, hasMore: false, awaitingApproval: 0 };
  it.each([
    ["nothing to voice", base, "Утверждённых текстов без аудио нет — ставить в очередь нечего."],
    ["nothing approved, some waiting for an editor", { ...base, awaitingApproval: 95 },
      "Утверждённых текстов без аудио нет — ставить в очередь нечего. Ждут утверждения, в очередь не ставятся: 95."],
    ["queued with more pages", { ...base, queued: 500, inspected: 500, hasMore: true },
      "В очередь поставлено: 500. Повторено: 0. Проверено: 500 — нажмите ещё раз для продолжения."],
    ["partial failures and waiting texts", { ...base, queued: 2, retried: 1, failed: 1, inspected: 4, awaitingApproval: 3 },
      "В очередь поставлено: 2. Повторено: 1. Проверено: 4. Ошибок: 1. Ждут утверждения, в очередь не ставятся: 3."],
  ])("%s", (_name, result, expected) => { expect(audioBackfillNotice(result)).toBe(expected); });
});

describe("draft clipboard text", () => {
  const draft = {
    placeId: "osm:node:4142950214", name: "Мишка с мячом", address: null, location: { lat: 55.7370823, lon: 37.6084488 }, research: "plain",
    text: { id: "t1", title: "Скульптура «Мишка с мячом»", paragraphs: ["Её создала скульптор Воробьева.", "Медведь стоит на передних лапах."], verification: "automatic", createdAt: "2026-09-28T17:00:00Z" },
  } satisfies Parameters<typeof draftClipboardText>[0];
  it("lists the point with coordinates and then every paragraph by number", () => {
    expect(draftClipboardText(draft)).toBe([
      "Место: Мишка с мячом", "Координаты: 55.7370823, 37.6084488", "OSM: osm:node:4142950214", "Заголовок: Скульптура «Мишка с мячом»", "",
      "Абзац 1: Её создала скульптор Воробьева.", "Абзац 2: Медведь стоит на передних лапах.",
    ].join("\n"));
  });
  it("adds the address when the place has one", () => {
    expect(draftClipboardText({ ...draft, address: "Москва, Крымский Вал, 2" }).split("\n")[1]).toBe("Адрес: Москва, Крымский Вал, 2");
  });
});
