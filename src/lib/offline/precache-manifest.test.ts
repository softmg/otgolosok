import { describe, expect, it } from "vitest";
import { precacheUrl, selectPrecacheFiles } from "../../../scripts/service-worker-manifest.mjs";

describe("precache manifest", () => {
  it("сохраняет оболочку истории для открытия без сети", () => {
    expect(selectPrecacheFiles(["history.html"]).map(precacheUrl)).toEqual(["/history"]);
  });
  it("normalizes Windows and POSIX output paths before selecting assets", () => {
    const files = selectPrecacheFiles([
      "index.html", "walk.html", "admin.html", "_next\\static\\chunks\\app.js", "_next/static/app.css",
      "audio\\walk\\chapter.mp3", "data/maps/map.json", "server.txt",
    ]);
    expect(files).toEqual(["_next/static/app.css", "_next/static/chunks/app.js", "audio/walk/chapter.mp3", "data/maps/map.json", "index.html", "walk.html"]);
    expect(files.map(precacheUrl)).toEqual(["/_next/static/app.css", "/_next/static/chunks/app.js", "/audio/walk/chapter.mp3", "/data/maps/map.json", "/", "/walk"]);
  });
});
