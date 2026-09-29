export type Draft = { title: string; paragraphs: { text: string; factIds: string[] }[] };
export type AdminApi = <T>(path: string, signal: AbortSignal, body?: unknown) => Promise<T>;
export type AdminRun = (label: string, action: (signal: AbortSignal) => Promise<void>) => Promise<void>;
export type OpenAdminJob = (id: string, reload?: boolean) => void;
export type Fact = { id: string; claim: string; interesting: boolean; evidence: { sourceId: string; quote: string }[] };
export type Audio = {
  url: string; durationSec: number; voice: string | null; provider: TtsProvider; model: string;
};
export type Summary = {
  id: string; address: string; stage: string; revision: number; updatedAt: string; irrelevant: boolean;
  ttsProvider?: TtsProvider; ttsVoice?: string | null; audio?: Audio | null;
  error: { code?: string; message: string } | null;
};
export type TtsProvider = "openai" | "yandex" | "elevenlabs";
export const ttsProviderLabels: Record<TtsProvider, string> = { openai: "OpenAI", yandex: "Яндекс", elevenlabs: "ElevenLabs" };
export type ContentBatch = {
  id: string; name: string; state: string; mode: string; textProfile: string; ttsProfile: string | null;
  /** "weak_identity" marks a triage pilot: stricter evidence and publication only after an editor approves. */
  identityPolicy?: "standard" | "weak_identity";
  createdAt: string; updatedAt: string;
  counts: { total: number; queued: number; working: number; ready: number; failed: number };
};
export type ContentBatchItem = {
  placeId: string; name: string; address: string | null; state: string; error: { code?: string; message?: string } | null;
};
/** One found page: `sourceId` is set once it was fetched, `failure` holds the fetch error code otherwise. */
export type ContentItemSource = {
  url: string; title: string | null; sourceId: string | null; publisher: string | null; chars: number; failure: string | null;
  /** A data.mos.ru record matched to the place offline, not a search result. */
  openData?: { datasetId: number; recordId: string; datasetVersion: string } | null;
  /** Which search found the page when the job also asked Perplexity; null otherwise. */
  origin?: "perplexity" | "search" | null;
};
export type ContentItemFact = {
  claim: string; kind: string | null; subjectRelation: string | null; evidence: { sourceId: string; quote: string }[];
};
/** Why a batch item stopped: where the object is, what was read, and what the model took it to be. */
export type ContentBatchItemDetail = ContentBatchItem & {
  location: { lat: number; lon: number }; tags: Record<string, string>;
  job: { state: string; attempts: number; maxAttempts: number; updatedAt: string };
  sources: ContentItemSource[];
  /** Outcome of the Perplexity search for a weak_identity job; null when it was not asked. */
  perplexity?: { status: "ok" | "failed"; code: string | null; count: number } | null;
  model: {
    outcome: "rejected" | "accepted"; identityConfirmed: boolean | null; addressConfirmed: boolean;
    placeName: string | null; resolvedAddress: string | null; identityNote: string | null; facts: ContentItemFact[];
  } | null;
};
/** `errors` counts the codes present under the status filter alone, so the error filter can list them without reloading. */
export type ContentBatchItemPage = {
  items: ContentBatchItem[]; total: number; hasMore: boolean; errors: { code: string | null; count: number }[];
};
export type ContentStatusFilter = "all" | "ready" | "working" | "waiting" | "stopped";
/** "all" — no filter, "none" — items without an error, anything else — a concrete error code such as ADDRESS_UNCLEAR. */
export type ContentErrorFilter = string;

export const batchStates: Record<string, string> = {
  running: "Выполняется", paused: "На паузе", cancelled: "Отменена",
};

/** Every state a batch item can hold; the four status buckets below partition this set. */
export const batchItemStates: Record<string, string> = {
  queued: "В очереди", retry_wait: "Ждёт повтора", working: "В работе", ready: "Готово",
  failed: "Ошибка", review_required: "Нужна редактура", insufficient_evidence: "Недостаточно источников", cancelled: "Отменено",
};

/** Mirrors BATCH_ITEM_STATES in backend/content-store.mjs — the server filters items by the same buckets. */
export const contentStatusStates: Record<Exclude<ContentStatusFilter, "all">, string[]> = {
  ready: ["ready"],
  working: ["working"],
  waiting: ["queued", "retry_wait"],
  stopped: ["failed", "review_required", "insufficient_evidence", "cancelled"],
};

/** Labels spell out which item states a bucket covers, so the filter needs no separate legend. */
export const contentStatusOptions: { value: ContentStatusFilter; label: string }[] = [
  { value: "all", label: "Любой статус" },
  { value: "ready", label: "Готово" },
  { value: "working", label: "В работе" },
  { value: "waiting", label: "Ждут очереди или повтора" },
  { value: "stopped", label: "Остановлены: ошибка, редактура, нет источников, отмена" },
];

export const retryableItemStates = ["failed", "review_required", "insufficient_evidence", "retry_wait"];

/**
 * Options for the error filter: what the current page reports, plus the selected code even when a retry
 * has just emptied it, so the select never falls back to a blank value.
 */
export function contentErrorOptions(errors: ContentBatchItemPage["errors"], selected: ContentErrorFilter) {
  const options = [{ value: "all", label: "Любая ошибка" }];
  for (const { code, count } of errors) {
    options.push(code === null
      ? { value: "none", label: `Без ошибки (${count})` }
      : { value: code, label: `${code} (${count})` });
  }
  if (!options.some(option => option.value === selected)) {
    options.push({ value: selected, label: selected === "none" ? "Без ошибки (0)" : `${selected} (0)` });
  }
  return options;
}

/** Human range for a server-paged list: "51–100 из 6107". */
export function pageRange(offset: number, count: number, total: number) {
  if (!total || !count) return "0";
  return `${offset + 1}–${offset + count} из ${total}`;
}

export function pageCount(total: number, size: number) {
  return Math.max(1, Math.ceil(total / size));
}
export type ContentPlace = {
  id: string; name: string; address: string | null; location: { lat: number; lon: number };
  text: null | { id: string; profile: string; story: Draft; draft: Draft; verification: string; audio: Audio | null; createdAt: string };
};
/** Catalog rows come from listPlaces, which reports text presence instead of the full text record. */
export type ContentPlaceSummary = {
  id: string; name: string; address: string | null; textStatus: "none" | "draft" | "approved"; audio: Audio | null;
};
export type ContentPlaceStatusFilter = "all" | "ready" | "draft" | "missing";
export const placeTextStatuses: Record<ContentPlaceSummary["textStatus"], string> = {
  none: "Нет текста", draft: "Черновик", approved: "Утверждён",
};
export const placeStatusOptions: { value: ContentPlaceStatusFilter; label: string }[] = [
  { value: "all", label: "Все места" },
  { value: "ready", label: "Только с утверждённым текстом" },
  { value: "draft", label: "Только черновики" },
  { value: "missing", label: "Только без текста" },
];
export type AudioBackfillResult = {
  queued: number; retried: number; alreadyQueued: number; failed: number; inspected: number; hasMore: boolean; awaitingApproval: number;
};

/** Explains the bulk voicing outcome, including why nothing was queued: only approved texts are voiced. */
export function audioBackfillNotice(result: AudioBackfillResult) {
  const waiting = result.awaitingApproval > 0 ? ` Ждут утверждения, в очередь не ставятся: ${result.awaitingApproval}.` : "";
  if (!result.inspected) return `Утверждённых текстов без аудио нет — ставить в очередь нечего.${waiting}`;
  const failed = result.failed ? ` Ошибок: ${result.failed}.` : "";
  return `В очередь поставлено: ${result.queued}. Повторено: ${result.retried}. Проверено: ${result.inspected}${result.hasMore ? " — нажмите ещё раз для продолжения" : ""}.${failed}${waiting}`;
}

export type ContentWorker = { id: string; name: string; profiles: string[]; createdAt: string; lastSeenAt: string | null; revokedAt: string | null };
export type ContentHeartbeat = { credentialId: string; workerName: string; version: string | null; profileIds: string[]; currentJobId: string | null; progress: {stage?:string;percent?:number}|null; seenAt: string };
export type ContentAudioJob = { id:string; state:string; profileId:string; attempts:number; maxAttempts:number; updatedAt:string; placeId:string|null; placeName:string|null; error:{message?:string;code?:string}|null };
export type Job = Summary & {
  canApprove: boolean; canRegenerate: boolean; canRevoice: boolean; canRetry: boolean;
  ttsProviders: { id: TtsProvider; label: string; available: boolean; defaultVoice: string; voices: { id: string; label: string }[] }[];
  data: {
    ttsProvider: TtsProvider;
    ttsVoice: string | null;
    editorDraft: Draft | null; draft: Draft | null; draftCandidate: Draft | null; story: Draft | null;
    audio: Audio | null; revoice: { requestedAt: string } | null;
    evidence: {
      placeName: string; resolvedAddress: string; facts: Fact[];
      sources: { id: string; url: string | null; title: string; publisher: string }[];
    } | null;
    review: { approved: boolean; issues: string[] } | null;
    factReview: { addressConfirmed: boolean; identityNote: string; placeName: string; resolvedAddress: string; facts: Fact[] } | null;
  };
};

export function initialDraft(job: Job): Draft {
  return job.data.editorDraft ?? job.data.story ?? job.data.draft ?? job.data.draftCandidate ?? {
    title: "", paragraphs: [{ text: "", factIds: [] }, { text: "", factIds: [] }],
  };
}

export function draftCheck(draft: Draft, facts: Fact[]) {
  const script = draft.paragraphs.map(p => p.text.trim()).join(" ").trim();
  const words = script ? script.split(/\s+/).length : 0;
  const used = new Set(draft.paragraphs.flatMap(p => p.factIds));
  const valid = Boolean(draft.title.trim()) && draft.title.length <= 140 &&
    draft.paragraphs.length >= 2 && draft.paragraphs.length <= 6 &&
    draft.paragraphs.every(p => p.text.trim() && p.text.length <= 2000 && p.factIds.length &&
      p.factIds.every(id => facts.some(f => f.id === id))) &&
    words >= 100 && words <= 250 && used.size >= 5;
  return { words, facts: used.size, valid };
}

export function safeSourceLink(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export const stages: Record<string, string> = {
  review_required: "Нужна редактура", queued: "В очереди", researching: "Поиск источников",
  verifying: "Проверка фактов", writing: "Подготовка текста",
  voicing: "Озвучивание", ready: "Готово", failed: "Ошибка", insufficient_evidence: "Недостаточно источников",
};

/** Triage of places the regular filter skips with weak_identity; see backend/identity-triage.mjs. */
export type IdentityTier = "auto" | "enrich" | "manual";
export type IdentityTierFilter = "all" | IdentityTier;
export type IdentityQueueFilter = "all" | "none" | "queued";
export type IdentityLocation = {
  status: string;
  building?: { address: string; relation: string } | null;
  nearestAddress?: { address: string; distanceMeters: number } | null;
  street?: { name: string; distanceMeters: number } | null;
  district?: string | null;
};
export type IdentityCandidate = {
  placeId: string; name: string; address: string | null; tier: IdentityTier; score: number; category: string;
  reasons: string[]; signals: string[]; location: IdentityLocation; assessedAt: string;
  job: { state: string; identityPolicy: string } | null;
};
export type IdentityCandidatePage = {
  items: IdentityCandidate[]; total: number; hasMore: boolean; tiers: Record<IdentityTier, number>;
  categories: { category: string; count: number }[]; stale: number; rulesVersion: string; assessedAt: string | null; pilotLimit: number;
};

export const identityTiers: Record<IdentityTier, { label: string; hint: string }> = {
  auto: { label: "Автогенерация", hint: "Надёжно привязаны к месту; можно включать в ограниченный пилот." },
  enrich: { label: "Нужно обогащение", hint: "Сначала нужен адрес или внешний идентификатор." },
  manual: { label: "Только вручную", hint: "Название или тип не позволяют автоматически определить объект." },
};
export const identityQueueOptions: { value: IdentityQueueFilter; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "none", label: "Без задания" },
  { value: "queued", label: "С заданием" },
];
export const identityReasons: Record<string, string> = {
  uninformative_name: "Название из инициалов или слишком короткое",
  missing_specific_type: "Нет конкретного типа объекта",
  short_name: "Короткое название",
  duplicate_name: "Такое же название у других мест",
  toponym_name: "Название совпадает с улицей или площадью",
  no_address_anchor: "Нет адресного здания рядом",
  no_location_context: "Нет адресных ориентиров OSM",
};
export const identitySignals: Record<string, string> = {
  informative_name: "Содержательное название",
  specific_type: "Конкретный тип",
  typed_name: "Тип в названии",
  distinctive_name: "Развёрнутое название",
  unique_name: "Уникальное название",
  inside_address_building: "Внутри адресного здания",
  on_address_building_edge: "На контуре адресного здания",
  nearby_address_50m: "Адрес в пределах 50 м",
  street_100m: "Улица в пределах 100 м",
  district: "Известен район",
  area_geometry: "Контур объекта",
  extra_tags: "Дополнительные теги OSM",
};

export type ContentDraft = {
  placeId: string; name: string; address: string | null; location: { lat: number; lon: number };
  text: { id: string; title: string; paragraphs: string[]; verification: string; createdAt: string };
};
/** `unresearched` counts drafts the bulk re-research would still pick; `researchAvailable` says the server has a search model. */
export type ContentDraftPage = { total: number; hasMore: boolean; items: ContentDraft[]; unresearched?: number; researchAvailable?: boolean };
export type DraftResearchResult = { batch: { id: string; name: string }; count: number };
export const DRAFT_RESEARCH_LIMIT = 50;

/** Plain text for the editor's clipboard: the point with its coordinates, then every paragraph numbered. */
export function draftClipboardText(draft: ContentDraft) {
  const { lat, lon } = draft.location;
  return [
    `Место: ${draft.name}`,
    ...(draft.address ? [`Адрес: ${draft.address}`] : []),
    `Координаты: ${lat}, ${lon}`,
    `OSM: ${draft.placeId}`,
    `Заголовок: ${draft.text.title}`,
    "",
    ...draft.text.paragraphs.map((paragraph, index) => `Абзац ${index + 1}: ${paragraph}`),
  ].join("\n");
}
