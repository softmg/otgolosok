import http from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listRuns, loadRun } from "./data.mjs";
import { enrichRun, reportMarkdown } from "./analysis.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "../../../otgolosok-creative");
const STATIC = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.mjs", ["app.mjs", "text/javascript"]],
  ["/styles.css", ["styles.css", "text/css"]],
]);
const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self' https://*.getbb.app",
};

/** @param {{root?: string, now?: string}} options */
export function createObserverServer({ root = DEFAULT_ROOT, now } = {}) {
  const reads = new Map();
  // Объединяем одновременные чтения, но не кешируем старое состояние запуска.
  function coalesce(key, read) {
    if (!reads.has(key))
      reads.set(
        key,
        Promise.resolve()
          .then(read)
          .finally(() => reads.delete(key)),
      );
    return reads.get(key);
  }
  return http.createServer(async (request, response) => {
    const send = (status, body, type = "application/json", extra = {}) => {
      response.writeHead(status, {
        ...HEADERS,
        "Content-Type": `${type}; charset=utf-8`,
        ...extra,
      });
      response.end(
        typeof body === "string" || Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body),
      );
    };
    try {
      const host = request.headers.host ?? "";
      if (
        !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host) &&
        !/^[a-z0-9-]+(?:\.next)?\.getbb\.app(?::\d+)?$/i.test(host)
      )
        return send(403, { error: "Недопустимый адрес локального сервера." });
      if (request.method !== "GET" && request.method !== "HEAD")
        return send(
          405,
          { error: "Доступно только чтение." },
          "application/json",
          { Allow: "GET, HEAD" },
        );
      // Защита от чтения локальных журналов сторонней страницей браузера.
      if (
        request.headers["sec-fetch-site"] === "cross-site" &&
        request.headers["sec-fetch-mode"] !== "navigate"
      )
        return send(403, {
          error: "Откройте страницу инструмента для чтения данных.",
        });
      const url = new URL(request.url ?? "/", "http://localhost");
      if (STATIC.has(url.pathname)) {
        const [file, type] = STATIC.get(url.pathname);
        return send(
          200,
          request.method === "HEAD"
            ? ""
            : await readFile(path.join(HERE, "web", file)),
          type,
        );
      }
      if (url.pathname === "/api/runs")
        return send(200, await coalesce("list", () => listRuns({ root, now })));
      const match =
        /^\/api\/runs\/(\d{4}-\d{2}-\d{2})(?:\/(report\.json|report\.md))?$/.exec(
          url.pathname,
        );
      if (!match)
        return send(404, { error: "Страница или запуск не найдены." });
      const run = await coalesce(match[1], async () =>
        enrichRun(await loadRun({ root, id: match[1], now })),
      );
      if (!match[2]) return send(200, run);
      const filename = `video-run-${match[1]}.${match[2] === "report.md" ? "md" : "json"}`;
      return send(
        200,
        match[2] === "report.md"
          ? reportMarkdown(run)
          : JSON.stringify(run, null, 2),
        match[2] === "report.md" ? "text/markdown" : "application/json",
        { "Content-Disposition": `attachment; filename="${filename}"` },
      );
    } catch (error) {
      const missing = ["ENOENT", "RUN_NOT_FOUND", "ROOT_UNAVAILABLE"].includes(
        error?.code,
      );
      const invalid = error?.code === "INVALID_RUN_ID";
      send(missing ? 404 : invalid ? 400 : 500, {
        error: missing
          ? "Каталог данных или запуск не найдены. Проверьте --root и наличие data/daily."
          : invalid
            ? "Некорректная дата запуска."
            : "Не удалось прочитать данные. Проверьте доступ к каталогу и повторите обновление.",
      });
    }
  });
}

export async function main(argv = process.argv.slice(2)) {
  let root = DEFAULT_ROOT,
    port = 4317,
    exportDir,
    id;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") {
      console.log(
        "Локальная история создания роликов\nnode scripts/video-observer/server.mjs [--root <otgolosok-creative>] [--port 4317]\nЭкспорт для ИИ: --run YYYY-MM-DD --export artifacts/video-observer",
      );
      return;
    }
    if (
      !["--root", "--port", "--run", "--export"].includes(arg) ||
      !argv[i + 1] ||
      argv[i + 1].startsWith("--")
    )
      throw new Error(
        "Неизвестный аргумент или нет значения. Используйте --help.",
      );
    const value = argv[++i];
    if (arg === "--root") root = path.resolve(value);
    if (arg === "--port") port = Number(value);
    if (arg === "--run") id = value;
    if (arg === "--export") exportDir = path.resolve(value);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Порт должен быть целым числом от 1 до 65535.");
  if (exportDir || id) {
    if (!exportDir || !id)
      throw new Error("Для экспорта укажите и --run, и --export.");
    const run = enrichRun(await loadRun({ root, id }));
    await mkdir(exportDir, { recursive: true });
    await writeFile(
      path.join(exportDir, `${run.id}.json`),
      JSON.stringify(run, null, 2) + "\n",
      { mode: 0o600 },
    );
    await writeFile(path.join(exportDir, `${run.id}.md`), reportMarkdown(run), {
      mode: 0o600,
    });
    console.log(`Отчёты запуска ${run.id} сохранены.`);
    return;
  }
  // Проверяем источник до запуска сервера, не загружаем .env или код соседнего проекта.
  await listRuns({ root });
  const server = createObserverServer({ root });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(undefined));
  });
  server.on("error", () => {
    console.error("Ошибка локального сервера. Перезапустите инструмент.");
    process.exitCode = 1;
  });
  console.log(`История создания роликов: http://127.0.0.1:${port}`);
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const known = ["ENOENT", "EACCES", "EPERM"].includes(error?.code);
    console.error(
      known
        ? "Нет доступа к источнику данных или файлам отчёта. Проверьте пути и права."
        : error?.code === "EADDRINUSE"
          ? "Порт занят. Укажите другой --port."
          : "Не удалось запустить инструмент. Проверьте аргументы (--help), доступ к данным и порт.",
    );
    process.exitCode = 1;
  });
}
