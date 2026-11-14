const $ = (selector) => document.querySelector(selector);
const state = {
  runs: [],
  detail: null,
  selected: null,
  stage: "",
  kind: "",
  eventSearch: "",
  eventLimit: 80,
  busy: false,
  request: 0,
  updatedAt: null,
};
const dateFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
});
const timeFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const stageStatuses = {
  complete: "Пройден",
  current: "В работе",
  blocked: "Остановлен",
  pending: "Впереди",
  unknown: "Нет данных",
};
const stageLabels = {
  selection: "Выбор истории",
  script: "Сценарий и материалы",
  preproduction: "Ранние проверки",
  voice: "Озвучка и звук",
  composition: "Композиция",
  render: "Рендер",
  review: "Итоговый аудит",
  publication: "Публикация",
};
const statusLabels = {
  published: "Опубликован",
  approved: "Одобрен",
  running: "В работе",
  blocked: "Остановлен",
  waiting: "Ожидание",
  unknown: "Нет данных",
  failed: "Ошибка",
  scheduled: "Запланирован",
  uploaded: "Загружен",
};
const symbols = {
  success: "✓",
  error: "!",
  warning: "!",
  info: "·",
  repair: "↺",
  render: "▷",
};
const kindLabels = {
  success: "Успех",
  error: "Ошибка",
  warning: "Предупреждение",
  info: "Событие",
  repair: "Ремонт",
  render: "Рендер",
};
let toastTimer;

function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined && value !== null)
    element.textContent = String(value);
  return element;
}
function append(parent, ...children) {
  for (const child of children) if (child) parent.append(child);
  return parent;
}
function text(value, fallback = "Нет данных") {
  return value === undefined || value === null || value === ""
    ? fallback
    : String(value);
}
function date(value, full = false) {
  const parsed = new Date(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? `${value}T12:00:00`
      : value,
  );
  return value && Number.isFinite(parsed.getTime())
    ? (full ? timeFormat : dateFormat).format(parsed)
    : "Время неизвестно";
}
function duration(value) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0
  )
    return "Нет замера";
  const seconds = Math.round(Number(value) / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes} мин ${seconds % 60} с`
    : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}
function tone(status) {
  if (
    [
      "published",
      "scheduled",
      "uploaded",
      "approved",
      "complete",
      "fixed",
      "success",
      "passed",
    ].includes(status)
  )
    return "good";
  if (["blocked", "failed", "error"].includes(status)) return "bad";
  if (["waiting", "timeout", "warning"].includes(status)) return "warning";
  return status === "running" || status === "current" ? "active" : "neutral";
}
function badge(status, label) {
  const element = node(
    "span",
    "status",
    label || statusLabels[status] || status || "Нет данных",
  );
  element.dataset.tone = tone(status);
  return element;
}
function notice(messages, error = false) {
  const values = (Array.isArray(messages) ? messages : [messages]).filter(
    Boolean,
  );
  if (!values.length) return null;
  const element = node("div", "notice");
  if (error) element.dataset.tone = "error";
  for (const message of values)
    element.append(
      node(
        "p",
        "",
        typeof message === "string"
          ? message
          : message.message || message.detail || JSON.stringify(message),
      ),
    );
  return element;
}
function evidence(values) {
  const list = (Array.isArray(values) ? values : [values]).filter(Boolean);
  if (!list.length) return null;
  const details = node("details", "evidence");
  details.append(node("summary", "", `Свидетельства · ${list.length}`));
  const items = node("ul");
  for (const item of list)
    items.append(
      node(
        "li",
        "mono",
        typeof item === "string"
          ? item
          : `${item.path || item.file || item.source || "Запись"}${item.line ? `:${item.line}` : ""}`,
      ),
    );
  details.append(items);
  return details;
}
function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, 4500);
}
function connection(message, isError = false) {
  const element = $("#connection-status");
  element.textContent = message;
  element.dataset.error = String(isError);
}
async function json(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    let message = `Не удалось прочитать данные (${response.status})`;
    try {
      const result = await response.json();
      if (result.error)
        message =
          typeof result.error === "string"
            ? result.error
            : result.error.message || message;
    } catch {
      /* The HTTP status is still actionable when an error body is unavailable. */
    }
    throw new Error(message);
  }
  return response.json();
}
function selectedFromUrl() {
  const url = new URL(location.href);
  const hash = url.hash.slice(1);
  return /^\d{4}-\d{2}-\d{2}$/.test(hash) ? hash : url.searchParams.get("run");
}

function renderRuns() {
  const search = $("#run-search").value.toLocaleLowerCase("ru");
  const runs = state.runs.filter((run) =>
    `${run.id} ${run.date} ${run.title} ${run.statusLabel || statusLabels[run.status] || ""}`
      .toLocaleLowerCase("ru")
      .includes(search),
  );
  $("#run-count").textContent = String(state.runs.length);
  const list = $("#run-list");
  list.replaceChildren();
  if (!runs.length) {
    list.append(
      node(
        "p",
        "inline-empty",
        state.runs.length
          ? "По этому запросу запусков нет."
          : "Запуски пока не найдены. Проверьте путь к локальному каталогу конвейера.",
      ),
    );
    return;
  }
  for (const run of runs) {
    const button = node("button", "run-button");
    button.type = "button";
    button.setAttribute("aria-current", String(run.id === state.selected));
    append(
      button,
      append(
        node("span", "run-date"),
        node("time", "", date(run.date)),
        Number(run.issueCount) > 0
          ? node("span", "issue-count", `${run.issueCount} замеч.`)
          : null,
      ),
      node("span", "run-title", text(run.title, run.id)),
      append(
        node("span", "run-subtitle"),
        badge(run.status, run.statusLabel),
        node("span", "muted", stageLabels[run.stage] || text(run.stage, "")),
      ),
    );
    button.addEventListener("click", () =>
      selectRun(run.id, { recordHistory: true }),
    );
    list.append(button);
  }
}

function section(id, title, description) {
  const result = node("section", "section");
  result.id = id;
  const heading = node("h2", "", title);
  heading.id = `${id}-heading`;
  result.setAttribute("aria-labelledby", heading.id);
  result.append(append(node("div", "section-heading"), heading));
  if (description) result.append(node("p", "section-description", description));
  return result;
}
function stageName(id) {
  return (
    (state.detail?.stages || []).find((stage) => stage.id === id)?.label ||
    stageLabels[id] ||
    text(id, "Этап неизвестен")
  );
}
function link(label, href, quiet = true) {
  const element = node("a", `button${quiet ? " button-quiet" : ""}`, label);
  element.href = href;
  element.download = "";
  return element;
}
async function copyBrief() {
  const brief = state.detail?.aiBrief;
  if (!brief) {
    toast("В этом запуске пока нет сводки для ИИ.");
    return;
  }
  try {
    await navigator.clipboard.writeText(brief);
    toast("Сводка и инструкция для ИИ скопированы.");
  } catch {
    let fallback = $("#copy-fallback");
    if (!fallback) {
      fallback = node("textarea", "copy-fallback");
      fallback.id = "copy-fallback";
      fallback.readOnly = true;
      fallback.setAttribute(
        "aria-label",
        "Сводка для ИИ: скопируйте текст вручную",
      );
      $(".run-header").append(fallback);
    }
    fallback.value = brief;
    fallback.focus();
    fallback.select();
    toast(
      "Браузер ограничил буфер обмена. Текст выделен для ручного копирования.",
    );
  }
}
function renderHeader(detail) {
  const header = node("header", "run-header");
  append(
    header,
    append(
      node("div", "run-context"),
      node("time", "", date(detail.date)),
      badge(detail.status, detail.statusLabel),
    ),
    node("h1", "", text(detail.title, detail.id)),
    node("p", "run-identifier mono", detail.id),
  );
  const actions = node("div", "run-actions");
  const copy = node("button", "button", "Скопировать для ИИ");
  copy.type = "button";
  copy.addEventListener("click", copyBrief);
  const base = `/api/runs/${encodeURIComponent(detail.id)}`;
  append(
    actions,
    copy,
    link("Отчёт .md", `${base}/report.md`),
    link("Данные .json", `${base}/report.json`),
  );
  header.append(actions);
  return header;
}
function renderOverview(detail) {
  const summary = detail.summary || {};
  const box = node("div", "overview");
  const current = (detail.stages || []).find(
    (stage) => stage.id === detail.currentStage,
  );
  const final = ["published", "approved", "scheduled", "uploaded"].includes(
    detail.status,
  );
  const message = final ? "Результат запуска" : "Текущая точка";
  const stage =
    typeof detail.currentStage === "object"
      ? detail.currentStage.label
      : current?.label || detail.currentStage;
  append(
    box,
    append(
      node("div", "current-state"),
      append(
        node("div"),
        node("p", "state-title", message),
        node(
          "p",
          "current-stage",
          final
            ? detail.statusLabel || statusLabels[detail.status]
            : text(stage, "Недостаточно данных о текущем этапе"),
        ),
        current?.note ? node("p", "state-note", current.note) : null,
      ),
      node(
        "p",
        "small muted",
        `Последнее наблюдение: ${date(detail.updatedAt, true)}`,
      ),
    ),
  );
  const stats = node("dl", "stats");
  for (const [label, value] of [
    ["Время по журналам", duration(summary.elapsedMs)],
    ["Ремонты", text(summary.repairCount)],
    ["Рендеры", text(summary.renderCount)],
    ["Ошибки в истории", text(summary.errorCount)],
  ]) {
    stats.append(
      append(node("div", "stat"), node("dt", "", label), node("dd", "", value)),
    );
  }
  box.append(stats);
  return box;
}
function renderStages(detail) {
  const element = section(
    "stages",
    "Путь ролика",
    "Выберите этап, чтобы отфильтровать события. Пройденные проверки не скрывают ошибки и повторы в истории.",
  );
  const stages = detail.stages || [];
  if (!stages.length) {
    element.append(
      node("p", "inline-empty", "В журнале нет сведений об этапах."),
    );
    return element;
  }
  const list = node("ol", "stage-list");
  stages.forEach((stage, index) => {
    const button = node("button", "stage-button");
    button.type = "button";
    button.dataset.status = stage.status;
    button.setAttribute("aria-pressed", String(state.stage === stage.id));
    button.setAttribute(
      "aria-label",
      `${stage.label}: ${stageStatuses[stage.status] || "Нет данных"}, попыток ${stage.attempts ?? "неизвестно"}`,
    );
    append(
      button,
      node(
        "span",
        "stage-dot",
        stage.status === "complete"
          ? "✓"
          : stage.status === "blocked"
            ? "!"
            : index + 1,
      ),
      node("span", "stage-label", stage.label),
      node("span", "stage-state", stageStatuses[stage.status] || "Нет данных"),
    );
    button.addEventListener("click", () => {
      state.stage = state.stage === stage.id ? "" : stage.id;
      state.eventLimit = 80;
      renderStageSelection();
      renderEvents();
    });
    list.append(append(node("li", "stage-item"), button));
  });
  element.append(list, node("div", "stage-note"));
  return element;
}
function renderStageSelection() {
  document
    .querySelectorAll(".stage-button")
    .forEach((button, index) =>
      button.setAttribute(
        "aria-pressed",
        String(state.stage === state.detail.stages[index]?.id),
      ),
    );
  const note = $(".stage-note");
  if (!note) return;
  note.replaceChildren();
  const stage = state.detail.stages?.find((item) => item.id === state.stage);
  if (stage) {
    append(
      note,
      node("strong", "", `${stage.label}. `),
      node(
        "span",
        "",
        `${text(stage.note, stageStatuses[stage.status])} Попыток: ${text(stage.attempts)}. ${duration(stage.durationMs)}.`,
      ),
    );
    const reset = node("button", "stage-reset", "Все этапы");
    reset.type = "button";
    reset.addEventListener("click", () => {
      state.stage = "";
      renderStageSelection();
      renderEvents();
    });
    note.append(reset);
  } else
    note.append(
      node(
        "span",
        "muted",
        "Показаны события всех этапов. Длительности отражают только то, что можно восстановить из журналов.",
      ),
    );
  const select = $("#event-stage");
  if (select) select.value = state.stage;
}
function renderTime(detail) {
  const element = section(
    "time",
    "Где прошло время",
    "Длительность зарегистрированных операций; параллельные интервалы могут пересекаться. Отсутствие замера не означает, что этап прошёл мгновенно.",
  );
  const chart = node("div", "time-chart");
  const stages = detail.stages || [];
  const max = Math.max(
    1,
    ...stages.map((stage) => Number(stage.durationMs) || 0),
  );
  if (!stages.some((stage) => Number(stage.durationMs) > 0))
    chart.append(
      node(
        "p",
        "muted small",
        "В этих журналах нет достаточных замеров длительности этапов.",
      ),
    );
  else
    for (const stage of stages) {
      const row = node("div", "time-row");
      row.dataset.status = stage.status;
      const track = node("meter", "time-track");
      track.min = 0;
      track.max = max;
      track.value = Math.max(0, Number(stage.durationMs) || 0);
      track.setAttribute(
        "aria-label",
        `${stage.label}: ${duration(stage.durationMs)}`,
      );
      append(
        row,
        node("span", "", stage.label),
        track,
        node("span", "time-value", duration(stage.durationMs)),
      );
      chart.append(row);
    }
  element.append(chart);
  return element;
}
function renderAnalysis(detail) {
  const element = section(
    "analysis",
    "Разбор запуска",
    "Локальные подсказки · гипотезы требуют проверки. Выводы привязаны к сохранённым свидетельствам; они не меняют допуск к публикации.",
  );
  const diagnostics = node("div", "diagnostics");
  for (const [key, title, symbol, empty] of [
    [
      "good",
      "Что сработало",
      "✓",
      "Пока недостаточно данных, чтобы выделить подтверждённые успехи.",
    ],
    [
      "bad",
      "Что мешало",
      "!",
      "Подтверждённые проблемы по доступным данным не найдены.",
    ],
    [
      "improve",
      "Что улучшить",
      "↗",
      "Пока недостаточно данных для конкретных рекомендаций.",
    ],
  ]) {
    const group = node("div", "diagnostic-group");
    group.dataset.kind = key;
    const heading = append(
      node("h3", "diagnostic-group-title"),
      node("span", "diagnostic-icon", symbol),
      node("span", "", title),
    );
    const list = node("div", "diagnostic-list");
    const findings = detail.analysis?.[key] || [];
    if (!findings.length) list.append(node("p", "muted small", empty));
    for (const finding of findings) {
      const item = node("article", "finding");
      append(
        item,
        node("h3", "", text(finding.title)),
        node("p", "", text(finding.detail, "")),
      );
      if (finding.confidence)
        item.append(
          node("p", "finding-meta", `Уверенность: ${text(finding.confidence)}`),
        );
      append(item, evidence(finding.evidence));
      list.append(item);
    }
    append(group, heading, list);
    diagnostics.append(group);
  }
  element.append(diagnostics);
  return element;
}
function table(headers) {
  const wrap = node("div", "table-wrap");
  const element = node("table");
  const row = node("tr");
  for (const label of headers) {
    const cell = node("th", "", label);
    cell.scope = "col";
    row.append(cell);
  }
  element.append(append(node("thead"), row));
  const body = node("tbody");
  element.append(body);
  wrap.append(element);
  return { wrap, body };
}
function renderRules(detail) {
  const element = section(
    "rules",
    "Редакционные проверки",
    "Повторяющийся отказ — повод разобрать правило, его область и входные материалы. Число отказов само по себе не доказывает излишнюю строгость.",
  );
  const rules = detail.rules || [];
  if (!rules.length) {
    element.append(
      node(
        "p",
        "inline-empty",
        "Отказы редакционных проверок в доступных данных не найдены.",
      ),
    );
    return element;
  }
  const { wrap, body } = table([
    "Проверка / причина",
    "Наблюдений отказа",
    "Этап",
    "Что проверить",
  ]);
  for (const rule of rules) {
    const reason = append(
      node("td", "table-description"),
      node("div", "table-main", text(rule.label, rule.code)),
      node("div", "mono muted", rule.code),
    );
    if (rule.failedCheck)
      reason.append(node("p", "mono muted", rule.failedCheck));
    if (rule.corrections?.length) {
      const corrections = node("details", "row-details");
      corrections.append(
        node("summary", "", `Замечания проверки · ${rule.corrections.length}`),
      );
      const list = node("ul");
      for (const correction of rule.corrections)
        list.append(node("li", "", correction));
      corrections.append(list);
      reason.append(corrections);
    }
    append(reason, evidence(rule.evidence));
    body.append(
      append(
        node("tr"),
        reason,
        node("td", "mono", text(rule.count)),
        node("td", "", stageName(rule.stage)),
        node(
          "td",
          "table-description",
          text(
            rule.assessment,
            "Сопоставить замечание с входными материалами и областью проверки.",
          ),
        ),
      ),
    );
  }
  element.append(wrap);
  return element;
}
function renderRepairs(detail) {
  const repairs = detail.repairs || [];
  const element = section(
    "repairs",
    "Попытки исправления",
    "Результат задания, причина и отпечаток входов позволяют отличить новую попытку от повторения прежнего отказа.",
  );
  if (!repairs.length) {
    element.append(
      node(
        "p",
        "inline-empty",
        "Задания на исправление в доступных данных не найдены.",
      ),
    );
    return element;
  }
  const { wrap, body } = table([
    "Попытка",
    "Результат",
    "Длительность",
    "Причина и входы",
  ]);
  for (const repair of repairs) {
    const reason = node("td", "table-description");
    append(
      reason,
      node("div", "table-main mono", text(repair.code, "Код не записан")),
      node("p", "", text(repair.message, "Описание результата отсутствует.")),
    );
    const details = node("details", "row-details");
    append(
      details,
      node("summary", "", "Отпечатки и идентификатор"),
      node("p", "mono", `Задание: ${text(repair.id)}`),
      node("p", "mono", `Причина: ${text(repair.issueKey)}`),
      node("p", "mono", `Входы: ${text(repair.inputFingerprint)}`),
    );
    reason.append(details);
    body.append(
      append(
        node("tr"),
        append(
          node("td"),
          node(
            "div",
            "table-main",
            repair.attempt == null
              ? String(repairs.indexOf(repair) + 1)
              : String(repair.attempt),
          ),
          node("time", "muted", date(repair.createdAt, true)),
        ),
        append(
          node("td"),
          badge(
            repair.status,
            repair.statusLabel ||
              {
                failed: "Ошибка",
                running: "Нет завершения",
                success: "Исправлено",
                fixed: "Исправлено",
                timeout: "Таймаут",
                unknown: "Неизвестен",
                stopped: "Прервано",
                waiting: "Ожидание",
                completed: "Завершено",
                skipped: "Пропущено",
              }[repair.status] ||
              repair.status,
          ),
        ),
        node("td", "mono", duration(repair.durationMs)),
        reason,
      ),
    );
  }
  element.append(wrap);
  return element;
}
function renderEventSection(detail) {
  const element = section(
    "events",
    "Хронология",
    "События восстановлены из сохранённых файлов. Время показано в часовом поясе вашего браузера.",
  );
  const controls = node("div", "timeline-controls");
  const searchLabel = node(
    "label",
    "timeline-control timeline-search",
    "Поиск по событиям",
  );
  const search = node("input");
  search.type = "search";
  search.id = "event-search";
  search.placeholder = "Код ошибки или фрагмент сообщения";
  search.value = state.eventSearch;
  search.addEventListener("input", () => {
    state.eventSearch = search.value;
    state.eventLimit = 80;
    renderEvents();
  });
  searchLabel.append(search);
  const kindLabel = node("label", "timeline-control", "Тип события");
  const kind = node("select");
  kind.id = "event-kind";
  for (const [value, label] of [
    ["", "Все события"],
    ...Object.entries(kindLabels),
  ]) {
    const option = node("option", "", label);
    option.value = value;
    kind.append(option);
  }
  kind.value = state.kind;
  kind.addEventListener("change", () => {
    state.kind = kind.value;
    state.eventLimit = 80;
    renderEvents();
  });
  kindLabel.append(kind);
  const stageLabel = node("label", "timeline-control", "Этап");
  const stageSelect = node("select");
  stageSelect.id = "event-stage";
  for (const stage of [
    { id: "", label: "Все этапы" },
    ...(detail.stages || []),
  ]) {
    const option = node("option", "", stage.label);
    option.value = stage.id;
    stageSelect.append(option);
  }
  stageSelect.value = state.stage;
  stageSelect.addEventListener("change", () => {
    state.stage = stageSelect.value;
    state.eventLimit = 80;
    renderStageSelection();
    renderEvents();
  });
  stageLabel.append(stageSelect);
  append(controls, searchLabel, kindLabel, stageLabel);
  const count = node("span", "small muted");
  count.id = "event-count";
  count.setAttribute("aria-live", "polite");
  element.firstChild.append(count);
  const timeline = node("div", "timeline");
  timeline.id = "event-list";
  append(element, controls, timeline);
  return element;
}
function renderEvents() {
  const target = $("#event-list");
  if (!target || !state.detail) return;
  const search = state.eventSearch.toLocaleLowerCase("ru");
  const events = (state.detail.events || []).filter(
    (event) =>
      (!state.stage || event.stage === state.stage) &&
      (!state.kind || event.kind === state.kind) &&
      `${event.code || ""} ${event.message || ""} ${event.stage || ""}`
        .toLocaleLowerCase("ru")
        .includes(search),
  );
  target.replaceChildren();
  $("#event-count").textContent =
    `${events.length} из ${(state.detail.events || []).length}`;
  if (!events.length)
    target.append(
      node(
        "p",
        "inline-empty",
        "Событий с такими условиями нет. Измените фильтры или выберите другой этап.",
      ),
    );
  for (const event of events.slice(0, state.eventLimit)) {
    const item = node("article", "event");
    item.dataset.kind = event.kind;
    const time = node("time", "event-time", date(event.at, true));
    if (event.at && Number.isFinite(new Date(event.at).getTime()))
      time.dateTime = new Date(event.at).toISOString();
    const symbol = node("span", "event-symbol", symbols[event.kind] || "·");
    symbol.setAttribute("aria-label", kindLabels[event.kind] || "Событие");
    const body = node("div", "event-body");
    append(
      body,
      append(
        node("div", "event-topline"),
        node("span", "event-stage", stageName(event.stage)),
        event.code ? node("span", "event-code mono", event.code) : null,
      ),
      node("p", "event-message", text(event.message, "Описание отсутствует.")),
      evidence(event.evidence),
    );
    append(item, time, symbol, body);
    target.append(item);
  }
  if (events.length > state.eventLimit) {
    const more = node(
      "button",
      "load-more",
      `Ещё события · осталось ${events.length - state.eventLimit}`,
    );
    more.type = "button";
    more.addEventListener("click", () => {
      state.eventLimit += 100;
      renderEvents();
    });
    target.append(more);
  }
}
function renderDetail() {
  const detail = state.detail;
  if (!detail) return;
  const target = $("#detail");
  target.replaceChildren(renderHeader(detail), renderOverview(detail));
  append(target, notice(detail.warnings));
  const nav = node("nav", "section-nav");
  nav.setAttribute("aria-label", "Разделы запуска");
  for (const [id, label] of [
    ["stages", "Этапы"],
    ["analysis", "Разбор"],
    ["rules", "Правила"],
    ["repairs", "Исправления"],
    ["events", "События"],
  ]) {
    const anchor = node("a", "", label);
    anchor.href = `#${id}`;
    nav.append(anchor);
  }
  target.append(
    nav,
    renderStages(detail),
    renderTime(detail),
    renderAnalysis(detail),
    renderRules(detail),
    renderRepairs(detail),
    renderEventSection(detail),
  );
  renderStageSelection();
  renderEvents();
  document.title = `${text(detail.title, detail.id)} · Мастерская роликов`;
}
async function selectRun(id, options = {}) {
  const request = ++state.request;
  const changed = state.selected !== id;
  if (changed) {
    state.stage = "";
    state.kind = "";
    state.eventSearch = "";
    state.eventLimit = 80;
  }
  state.selected = id;
  renderRuns();
  if (!options.background) connection("Читаем журнал запуска…");
  try {
    const detail = await json(`/api/runs/${encodeURIComponent(id)}`);
    if (request !== state.request) return;
    const visualSignature = (value) =>
      JSON.stringify(value, (key, entry) =>
        key === "generatedAt" || key === "aiBrief" ? undefined : entry,
      );
    const unchanged =
      options.background &&
      visualSignature(state.detail) === visualSignature(detail);
    state.detail = detail;
    if (options.background && !unchanged) {
      const activeId = document.activeElement?.id;
      const openDetails = [...document.querySelectorAll("#detail details")]
        .map((element, index) => (element.open ? index : null))
        .filter((index) => index !== null);
      const oldScroll = window.scrollY;
      renderDetail();
      openDetails.forEach((index) => {
        const element = document.querySelectorAll("#detail details")[index];
        if (element) element.open = true;
      });
      if (activeId)
        document.getElementById(activeId)?.focus({ preventScroll: true });
      window.scrollTo({ top: oldScroll, behavior: "instant" });
    } else if (!unchanged) renderDetail();
    const url = new URL(location.href);
    url.searchParams.set("run", id);
    if (changed && /^\d{4}-\d{2}-\d{2}$/.test(id)) url.hash = id;
    if (options.recordHistory && changed) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
    state.updatedAt = new Date().toISOString();
    connection(
      `Данные обновлены ${date(state.updatedAt, true)} · только чтение`,
    );
  } catch (error) {
    if (request !== state.request) return;
    connection(
      `${error.message}. ${state.detail && !changed ? "Показаны последние полученные данные." : "Нажмите «Обновить», чтобы повторить."}`,
      true,
    );
    if (changed) {
      state.detail = null;
      $("#detail").replaceChildren(
        notice(`Не удалось загрузить запуск ${id}: ${error.message}`, true),
      );
    }
  }
}
async function refresh(options = {}) {
  if (state.busy) return;
  state.busy = true;
  $("#refresh").disabled = true;
  try {
    const result = await json("/api/runs");
    if (!Array.isArray(result.runs))
      throw new Error("Сервер вернул некорректный список запусков");
    state.runs = result.runs;
    $("#global-warning").replaceChildren();
    append($("#global-warning"), notice(result.warnings));
    renderRuns();
    const desired = state.selected || selectedFromUrl();
    const selected =
      state.runs.find((run) => run.id === desired) || state.runs[0];
    if (selected)
      await selectRun(selected.id, {
        background:
          options.background &&
          state.selected === selected.id &&
          Boolean(state.detail),
      });
    else {
      state.selected = null;
      state.detail = null;
      connection("Каталог прочитан. Запуски пока не найдены.");
      const empty = node("div", "empty-state");
      append(
        empty,
        node("h2", "", "Запусков пока нет"),
        node(
          "p",
          "",
          "Проверьте каталог данных otgolosok-creative. После появления первого запуска он будет доступен здесь автоматически.",
        ),
      );
      $("#detail").replaceChildren(empty);
    }
  } catch (error) {
    connection(`${error.message}. Нажмите «Обновить», чтобы повторить.`, true);
    if (!state.runs.length)
      $("#run-list").replaceChildren(
        node("p", "inline-empty", "Список запусков недоступен."),
      );
  } finally {
    state.busy = false;
    $("#refresh").disabled = false;
  }
}
$("#run-search").addEventListener("input", renderRuns);
$("#refresh").addEventListener("click", () =>
  refresh({ background: Boolean(state.detail) }),
);
window.addEventListener("popstate", () => {
  const id = selectedFromUrl();
  if (id && id !== state.selected) selectRun(id);
});
window.addEventListener("hashchange", () => {
  const id = selectedFromUrl();
  if (id && id !== state.selected) selectRun(id);
});
setInterval(() => {
  if (
    $("#auto-refresh").checked &&
    document.visibilityState === "visible" &&
    !state.busy
  )
    refresh({ background: true });
}, 15000);
void refresh();
