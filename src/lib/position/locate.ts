import type { PositionFix } from "../geo/types";

// Разовое определение «где я»: быстрая грубая точка (Wi-Fi, вышки) и параллельное
// уточнение по GPS. Ошибка — только если не пришло ни одной точки.

export type LocateErrorCode = "unsupported" | "permission-denied" | "position-unavailable" | "timeout";

export type LocateUpdate =
  | { type: "fix"; fix: PositionFix; final: boolean }
  | { type: "error"; code: LocateErrorCode };

export type LocateOptions = {
  geolocation?: Geolocation | null;
  permissions?: Pick<Permissions, "query"> | null;
  /** Точность, при которой уточнение прекращается. */
  goodAccuracyM?: number;
  /** Сколько ждать уточнения после первой точки. */
  refineMs?: number;
  /** Предельное ожидание после выдачи разрешения: время на окне разрешения не считается. */
  deadlineMs?: number;
  /** Предельное ожидание, когда состояние разрешения узнать нельзя. */
  unknownPermissionDeadlineMs?: number;
};

// Коды GeolocationPositionError зафиксированы спецификацией.
const PERMISSION_DENIED = 1;
const POSITION_UNAVAILABLE = 2;

const COARSE_OPTIONS: PositionOptions = { enableHighAccuracy: false, maximumAge: 60_000, timeout: 10_000 };
const PRECISE_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 };

const errorMessages: Record<LocateErrorCode, string> = {
  "unsupported": "Геолокация недоступна в этом браузере.",
  "permission-denied": "Нет доступа к геолокации.",
  "position-unavailable": "Устройство не смогло определить положение. Проверьте, что геолокация включена в настройках устройства.",
  "timeout": "Не удалось вовремя определить положение.",
};

export function describeLocateError(code: LocateErrorCode): string {
  return errorMessages[code];
}

function toFix(position: GeolocationPosition): PositionFix {
  const accuracy = position.coords.accuracy;
  return {
    lat: position.coords.latitude,
    lon: position.coords.longitude,
    accuracyM: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : Number.POSITIVE_INFINITY,
    timestampMs: position.timestamp,
  };
}

/**
 * Присылает улучшающиеся точки (`final: false`) и ровно одно итоговое событие:
 * лучшую точку с `final: true` или ошибку. Возвращает функцию отмены.
 */
export function locateOnce(listener: (update: LocateUpdate) => void, options: LocateOptions = {}): () => void {
  const geolocation = Object.hasOwn(options, "geolocation")
    ? (options.geolocation ?? null)
    : (typeof navigator === "undefined" ? null : navigator.geolocation ?? null);
  const permissions = Object.hasOwn(options, "permissions")
    ? (options.permissions ?? null)
    : (typeof navigator === "undefined" ? null : navigator.permissions ?? null);
  const goodAccuracyM = options.goodAccuracyM ?? 30;
  const refineMs = options.refineMs ?? 6_000;
  const deadlineMs = options.deadlineMs ?? 20_000;
  const unknownPermissionDeadlineMs = options.unknownPermissionDeadlineMs ?? 45_000;

  let done = false;
  let best: PositionFix | null = null;
  let failure: LocateErrorCode | null = null;
  let coarseSettled = false;
  let preciseFailed = false;
  let watchId: number | null = null;
  let refineTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let permissionStatus: PermissionStatus | null = null;

  const stopWatch = () => {
    if (watchId !== null) geolocation?.clearWatch(watchId);
    watchId = null;
  };
  const onPermissionChange = () => {
    if (permissionStatus && permissionStatus.state !== "prompt") startDeadline(deadlineMs);
  };
  const cleanup = () => {
    done = true;
    stopWatch();
    clearTimeout(refineTimer);
    clearTimeout(deadlineTimer);
    permissionStatus?.removeEventListener("change", onPermissionChange);
  };
  const finish = (update: LocateUpdate) => {
    if (done) return;
    cleanup();
    listener(update);
  };
  const settle = () => {
    if (best) finish({ type: "fix", fix: best, final: true });
    else finish({ type: "error", code: failure ?? "timeout" });
  };
  function startDeadline(ms: number) {
    if (done || deadlineTimer !== undefined) return;
    deadlineTimer = setTimeout(settle, ms);
  }
  // Уточнять больше нечем: грубый запрос завершён, а слежение сломалось.
  const settleIfExhausted = () => {
    if (coarseSettled && preciseFailed) settle();
  };

  const onPosition = (position: GeolocationPosition) => {
    if (done) return;
    const fix = toFix(position);
    if (best && !(fix.accuracyM < best.accuracyM)) return;
    const first = best === null;
    best = fix;
    if (fix.accuracyM <= goodAccuracyM) {
      settle();
      return;
    }
    listener({ type: "fix", fix, final: false });
    if (first) refineTimer = setTimeout(settle, refineMs);
  };
  const onError = (channel: "coarse" | "precise") => (error: GeolocationPositionError) => {
    if (done) return;
    if (error.code === PERMISSION_DENIED) {
      finish({ type: "error", code: "permission-denied" });
      return;
    }
    if (failure !== "position-unavailable") {
      failure = error.code === POSITION_UNAVAILABLE ? "position-unavailable" : "timeout";
    }
    if (channel === "coarse") coarseSettled = true;
    else {
      preciseFailed = true;
      stopWatch();
    }
    settleIfExhausted();
  };

  if (!geolocation) {
    listener({ type: "error", code: "unsupported" });
    return () => undefined;
  }

  // Оба запроса уходят сразу, в обработчике нажатия: часть браузеров показывает окно
  // разрешения только в ответ на действие пользователя.
  try {
    geolocation.getCurrentPosition((position) => {
      if (done) return;
      coarseSettled = true;
      onPosition(position);
      settleIfExhausted();
    }, onError("coarse"), COARSE_OPTIONS);
    const id = geolocation.watchPosition(onPosition, onError("precise"), PRECISE_OPTIONS);
    if (done) geolocation.clearWatch(id);
    else watchId = id;
  } catch {
    finish({ type: "error", code: "position-unavailable" });
    return () => undefined;
  }

  // Свой предельный таймер защищает от браузеров, которые молча не отвечают,
  // но не должен срабатывать, пока пользователь думает над окном разрешения.
  if (!permissions) startDeadline(unknownPermissionDeadlineMs);
  else {
    permissions.query({ name: "geolocation" }).then((status) => {
      if (done) return;
      if (status.state !== "prompt") {
        startDeadline(deadlineMs);
        return;
      }
      permissionStatus = status;
      status.addEventListener("change", onPermissionChange);
    }, () => startDeadline(unknownPermissionDeadlineMs));
  }

  return () => {
    if (!done) cleanup();
  };
}
