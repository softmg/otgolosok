import type { ContentBatchItemDetail } from "./model";

const sourceFailures: Record<string, string> = {
  SOURCE_EMPTY: "на странице меньше 300 знаков текста о месте",
  TIMEOUT: "страница не ответила вовремя",
  BAD_STATUS: "сайт вернул ошибку",
  BAD_CONTENT_TYPE: "не текст и не PDF",
  SOURCE_TOO_LARGE: "страница слишком большая",
  DNS_REJECTED: "адрес сайта запрещён или не найден",
  INVALID_URL: "некорректная ссылка",
  REDIRECT_LIMIT: "слишком много перенаправлений",
  NETWORK_ERROR: "сетевая ошибка",
  ABORTED: "загрузка прервана",
};
const factKinds: Record<string, string> = { identity: "опознание", address: "адрес", content: "история" };
const factRelations: Record<string, string> = { object: "о самом объекте", site_context: "об окружении", nearby: "о соседнем месте" };

/** `osm:node:123` → the object page on openstreetmap.org, which draws the node, way outline or relation. */
export function osmObjectUrl(placeId: string) {
  const match = /^osm:(node|way|relation):(\d+)$/.exec(placeId);
  return match ? `https://www.openstreetmap.org/${match[1]}/${match[2]}` : null;
}

export function yandexMapUrl({ lat, lon }: { lat: number; lon: number }) {
  return `https://yandex.ru/maps/?pt=${lon},${lat}&z=18&l=map`;
}

function verdict(model: NonNullable<ContentBatchItemDetail["model"]>) {
  if (model.outcome === "accepted") return "Модель опознала объект";
  return model.identityConfirmed === false ? "Модель не подтвердила, что источники о нём" : "Цитата-опознание не нашлась в источниках";
}

export function BatchItemDetail({ item }: { item: ContentBatchItemDetail }) {
  const { lat, lon } = item.location;
  const osm = osmObjectUrl(item.placeId);
  const tags = Object.entries(item.tags);
  const publishers = new Map(item.sources.flatMap(source => source.sourceId ? [[source.sourceId, source.publisher ?? source.url]] : []));
  return <div className="content-item-detail">
    <section aria-label="Где находится">
      <h4>Где находится</h4>
      <p><span className="content-coords">{lat}, {lon}</span>
        {osm && <> · <a href={osm} target="_blank" rel="noopener noreferrer">OpenStreetMap</a></>}
        {" · "}<a href={yandexMapUrl(item.location)} target="_blank" rel="noopener noreferrer">Яндекс Карты</a></p>
      {item.address && <p className="admin-meta">Адрес из OSM: {item.address}</p>}
      {tags.length > 0 && <details>
        <summary>Теги OSM ({tags.length})</summary>
        <dl className="content-tags">{tags.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
      </details>}
    </section>

    <section aria-label="Вывод модели">
      <h4>Вывод модели</h4>
      {item.model ? <>
        <p><b>{verdict(item.model)}.</b>{item.model.placeName && <> Модель считает, что это «{item.model.placeName}»
          {item.model.resolvedAddress && item.model.resolvedAddress !== item.model.placeName ? `, ${item.model.resolvedAddress}` : ""}.</>}</p>
        {item.model.identityNote && <blockquote>{item.model.identityNote}</blockquote>}
        {item.model.facts.length > 0 && <ol className="content-facts">{item.model.facts.map((fact, index) => <li key={index}>
          {fact.claim}
          <span className="admin-row-id">{[fact.kind && (factKinds[fact.kind] ?? fact.kind), fact.subjectRelation && (factRelations[fact.subjectRelation] ?? fact.subjectRelation)].filter(Boolean).join(" · ")}</span>
          {fact.evidence.map((proof, proofIndex) => <q key={proofIndex}>{proof.quote}<span className="admin-row-id"> — {publishers.get(proof.sourceId) ?? proof.sourceId}</span></q>)}
        </li>)}</ol>}
      </> : <p className="admin-meta">Модель ещё не разбирала источники: задание остановилось раньше или его перезапустили.</p>}
    </section>

    <section aria-label="Источники">
      <h4>Источники</h4>
      {item.perplexity && <p className="admin-meta">{item.perplexity.status === "ok"
        ? `Perplexity нашёл ссылок: ${item.perplexity.count}.`
        : `Perplexity недоступен (${item.perplexity.code ?? "причина не записана"}), использован только обычный поиск.`}</p>}
      {item.sources.length ? <ol className="content-sources">{item.sources.map((source, index) => <li key={index}>
        <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a>
        <span className="admin-row-id">{source.openData
          ? `${source.sourceId} · Открытые данные Москвы · набор ${source.openData.datasetId}, версия ${source.openData.datasetVersion}`
          : source.sourceId
          ? `${source.sourceId} · ${source.publisher ?? ""} · ${source.chars.toLocaleString("ru-RU")} знаков`
          : `не прочитан: ${source.failure ? sourceFailures[source.failure] ?? source.failure : "причина не записана"}`}{source.origin === "perplexity" ? " · найдено Perplexity" : ""}</span>
      </li>)}</ol> : <p className="admin-meta">Поиск ещё не выполнялся или ничего не нашёл.</p>}
    </section>

    <p className="admin-meta">Задание: попыток {item.job.attempts} из {item.job.maxAttempts}, обновлено {new Date(item.job.updatedAt).toLocaleString("ru-RU")}.</p>
  </div>;
}
