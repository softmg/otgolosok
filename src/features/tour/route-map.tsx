import Image from "next/image";
import { ExploreMap } from "../explore/explore-map";
import type { Route } from "./types";
import "./route-map.css";

export function RouteMap({ route, universal = false }: { route: Route; universal?: boolean }) {
  const steps = route.walk?.steps ?? [];
  const geometry = route.walk?.path.coordinates.map(([lon, lat]) => ({ lat, lon })) ?? [];
  const items = steps.map((step, index) => ({ id: step.id, title: `${index + 1}. ${step.title}`, location: step.location, number: index + 1 }));
  const start = route.walk?.start.address ?? route.pois[0]?.eyebrow ?? "Начало маршрута";
  const finish = (route.walk?.finish.address ?? route.pois.at(-1)?.eyebrow ?? "Финиш маршрута").replace(/^Финиш:\s*/i, "");
  const isBundledMap = !universal && route.id === "msk-kozhevniki-zindel-short";
  if (!isBundledMap) return <figure className="route-visual" aria-labelledby="route-map-title">
    <div className="route-map-heading">
      <h2 id="route-map-title">Карта прогулки</h2>
      <p>{route.city} · {steps.length} {chapterWord(steps.length)}</p>
    </div>
    {geometry.length > 1 ? <div className="route-map-live"><ExploreMap items={items} geometry={geometry} focus={null} user={null} onSelect={() => {}} onPoint={() => {}}
      mapLabel={`Карта прогулки «${route.title}»: маршрут от ${start} до ${finish}.`} /></div> : <p className="route-map-empty">Маршрут ещё не построен. Остановки появятся после проверки пути.</p>}
    <figcaption className="route-map-caption">
      <span className="route-map-number" aria-hidden="true">{steps.length ? `1–${steps.length}` : "—"}</span>
      <div><p>{start}</p><a href="#walk-plan">{steps.length ? `${steps.length} ${chapterWord(steps.length)} одной прогулки` : "Остановки прогулки"}</a><p>Финиш: {finish}</p></div>
    </figcaption>
    <div className="route-map-links"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a></div>
  </figure>;
  return <figure className="route-visual" aria-labelledby="route-map-title">
    <div className="route-map-heading">
      <h2 id="route-map-title">Места прогулки</h2>
      <p>Кожевники · около 650 м</p>
    </div>
    <Image
      className="route-map-image"
      src="/data/maps/paveletskaya.svg"
      width={400} height={400} unoptimized
      alt="Карта пешеходного пути от 2-го Кожевнического переулка, 12с10 до Дербеневской набережной, 7с22. Четыре части прогулки отмечены по порядку. Москва-река восточнее, переходить её не нужно. Север сверху."
    />
    <figcaption className="route-map-caption">
      <span className="route-map-number" aria-hidden="true">1–4</span>
      <div>
        <p>{route.walk?.start.address}</p>
        <a href="#walk-plan">Четыре части одной прогулки</a>
        <p>Финиш: {route.walk?.finish.address}</p>
        <p>Проходы во дворах ещё не проверены на месте.</p>
      </div>
    </figcaption>
    <div className="route-map-links">
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a>
      <a href="https://www.openstreetmap.org/#map=18/55.7240/37.6500" target="_blank" rel="noreferrer">Открыть карту ↗</a>
    </div>
  </figure>;
}

function chapterWord(value: number) {
  const remainder = value % 10;
  const tens = value % 100;
  return tens >= 11 && tens <= 14 ? "частей" : remainder === 1 ? "часть" : remainder >= 2 && remainder <= 4 ? "части" : "частей";
}
