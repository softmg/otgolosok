const messages = {
  WALK_INVALID: "Проверьте начало, остановки и параметры прогулки.",
  WALK_BUSY: "Планировщик занят. Повторите через пару секунд.",
  WALK_RATE_LIMITED: "Слишком частые запросы маршрута. Повторите через пару секунд.",
  WALK_NOT_FOUND: "Не удалось построить пешеходную прогулку в выбранное время. Измените точки или длительность.",
  WALK_START_UNREACHABLE: "Сюда не дойти пешком. Выберите начало на улице рядом.",
  WALK_DESTINATION_UNREACHABLE: "Сюда не дойти пешком. Выберите финиш на улице рядом.",
  WALK_STOPS_NOT_FOUND: "Рядом со стартом недостаточно достопримечательностей в каталоге. Добавьте остановки вручную или выберите другое начало прогулки.",
  WALK_DISCOVERY_UNAVAILABLE: "Не удалось автоматически подобрать остановки. Попробуйте позже или добавьте остановки вручную.",
  WALK_UNAVAILABLE: "Пешеходный маршрутизатор временно недоступен. Попробуйте позже.",
};
const statuses = { WALK_INVALID: 400, WALK_BUSY: 429, WALK_RATE_LIMITED: 429, WALK_NOT_FOUND: 404, WALK_START_UNREACHABLE: 404, WALK_DESTINATION_UNREACHABLE: 404, WALK_STOPS_NOT_FOUND: 404, WALK_DISCOVERY_UNAVAILABLE: 503, WALK_UNAVAILABLE: 503 };

/** Shared mapping of planner failures for /api/walk-plan and the promo-walks service. */
export function walkPlanErrorResponse(error) {
  const code = error?.code === "BAD_REQUEST" ? "WALK_INVALID" : Object.hasOwn(messages, error?.code) ? error.code : "WALK_UNAVAILABLE";
  return { status: statuses[code], headers: statuses[code] === 429 ? { "Retry-After": "2" } : {}, body: { error: { code, message: messages[code] } } };
}
