"use client";

import Link from "next/link";
import { formatRatingSummary } from "../reviews/model";
import { formatTopWalkMeta } from "../walks/top-model";
import { formatFinish, formatStartDistance, isOwnNearbyWalk, nearbyWalkHref, type NearbyWalk } from "../walks/nearby-model";
import styles from "./nearby-walks.module.css";

/**
 * Ready walks starting near the chosen start, or near the user before a start is chosen: the user
 * can go on one instead of building a new walk. Collapsed by default so the creation sheet stays
 * low; the summary shows how many there are.
 */
export function NearbyWalks({ walks, origin }: { walks: NearbyWalk[]; origin: "start" | "you" }) {
  return <details className={styles.section} data-creation="nearby">
    <summary className={styles.summary}>{origin === "you" ? "Близко к вам" : "Прогулки рядом"} · {walks.length}</summary>
    <ol className={styles.list}>
      {walks.map(walk => <li key={`${walk.kind}:${walk.id}`}>
        <Link className={styles.card} href={nearbyWalkHref(walk)}>
          <span className={styles.titleRow}>
            <strong className={styles.title}>{walk.title}</strong>
            {isOwnNearbyWalk(walk) && <span className={styles.badge}>Ваша</span>}
          </span>
          <span className={styles.finish}>{formatFinish(walk.finish)}</span>
          <span className={styles.rating}>{formatRatingSummary(walk.rating) || "Пока без оценок"}</span>
          <span className={styles.meta}>{formatTopWalkMeta(walk)} · {formatStartDistance(walk.startDistanceM, origin)}</span>
        </Link>
      </li>)}
    </ol>
  </details>;
}
