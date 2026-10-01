import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Отголосок — аудиопрогулки по Москве",
    short_name: "Отголосок",
    description:
      "Городские истории с источниками, которые начинаются рядом с местом событий.",
    // A stable id keeps one installed app even if start_url changes.
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#eee9df",
    theme_color: "#b52d20",
    lang: "ru",
    orientation: "portrait",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Full-bleed: the launcher crops it to its own shape (scripts/build-app-icons.mjs).
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
