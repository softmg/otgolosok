/**
 * Basemap icons: a white glyph on a category-coloured disc, drawn on demand when MapLibre asks for a missing image.
 * Glyphs are Pinhead map icons (CC0, https://github.com/waysidemapping/pinhead) on a 15×15 grid; being generated
 * in the browser, they need no sprite download and no extra CSP source.
 */
export const MAP_ICONS = {
  // A plain bold "М" like the Yandex metro sign; not the Moscow Metro logo, which is a trademark.
  station: { color: "#d8262c", glyph: "M1.5 13.5L1.5 1.5L4.5 1.5L7.5 8L10.5 1.5L13.5 1.5L13.5 13.5L11 13.5L11 6.2L8.6 11.5L6.4 11.5L4 6.2L4 13.5Z" },
  orthodox: { color: "#8c7358", glyph: "M8.5 0L8.5 2L10.5 2L10.5 3.5L8.5 3.5L8.5 5L12.5 5L12.5 7L8.5 7L8.5 10.54L11 11.5L10.5 13L8.5 12.23L8.5 15L6.5 15L6.5 11.46L4 10.5L4.5 9L6.5 9.77L6.5 7L2.5 7L2.5 5L6.5 5L6.5 3.5L4.5 3.5L4.5 2L6.5 2L6.5 0z" },
  church: { color: "#8c7358", glyph: "M6 0L6 4L2 4L2 7L6 7L6 15L9 15L9 7L13 7L13 4L9 4L9 0z" },
  synagogue: { color: "#8c7358", glyph: "M7.5 0.5L9.67 4L14 4L11.83 7.5L14 11L9.67 11L7.5 14.5L5.33 11L1 11L3.17 7.5L1 4L5.33 4L7.5 0.5ZM8.49 11L6.51 11L7.5 12.6L8.49 11ZM3.76 8.45L2.8 10L4.71 10L3.76 8.45ZM9.11 5L5.89 5L4.34 7.5L5.89 10L9.11 10L10.66 7.5L9.11 5ZM11.25 8.45L10.29 10L12.2 10L11.25 8.45ZM4.71 5L2.8 5L3.76 6.55L4.71 5ZM12.2 5L10.29 5L11.25 6.55L12.2 5ZM7.5 2.4L6.51 4L8.49 4L7.5 2.4Z" },
  mosque: { color: "#8c7358", glyph: "M12.1 12.1C9.56 14.63 5.44 14.63 2.9 12.1C0.37 9.56 0.37 5.44 2.9 2.9C5.44 0.37 9.56 0.37 12.1 2.9C12.27 3.08 12.43 3.25 12.58 3.44C10.56 1.86 7.63 2 5.78 3.86C3.77 5.87 3.77 9.13 5.78 11.14C7.63 13 10.56 13.14 12.58 11.56C12.43 11.75 12.27 11.92 12.1 12.1ZM10.1 6.5H8L9.7 8L9 10.5L11 9L13 10.5L12.3 8L14 6.5H11.9L11 4.5L10.1 6.5Z" },
  theatre: { color: "#b0527a", glyph: "M2 1c0 0 -1 0 -1 1v5.16C1 8.89 1.35 11 4.5 11H5V8L2.5 9c0 0 0 -2.5 2.5 -2.5V5c0 -0.71 0.09 -1.32 0.5 -1.78C5.88 2.81 6.5 1.97 8.16 2.75L9 3.3V2c0 0 0 -1 -1 -1C7.29 1 6.02 2 5 2S2.79 1 2 1zM3 3c0.55 0 1 0.45 1 1S3.55 5 3 5S2 4.55 2 4S2.45 3 3 3zM7 4c0 0 -1 0 -1 1v5c0 2 1 4 4 4s4 -2 4 -4V5c0 -1 -1 -1 -1 -1c-0.71 0 -1.98 1 -3 1S7.79 4 7 4zM8 6c0.55 0 1 0.45 1 1S8.55 8 8 8S7 7.55 7 7S7.45 6 8 6zM12 6c0.55 0 1 0.45 1 1s-0.45 1 -1 1s-1 -0.45 -1 -1S11.45 6 12 6zM7.5 10H10h2.5c0 0 0 2.5 -2.5 2.5S7.5 10 7.5 10z" },
  viewpoint: { color: "#3d9160", glyph: "M11 2.5C12 4 12 4 12.5 5.34C13 6.5 13 10.5 13 10.5C13 11 9 11 9 10.5C9 9.5 9 9.5 9 9.5C9 9 8.5 8.5 8.5 8L8.5 7.5L6.5 7.5L6.5 8C6.5 8.5 6 9 6 9.5L6 10.5C6 11 2 11 2 10.5C2 10.5 2 6.5 2.5 5.34C3 4 3 4 4 2.5C4 2 6 2 6 2.5L6 3.5L9 3.5C9 3.5 9 3 9 2.5C9 2 11 2 11 2.5zM2.5 11.5C1 11.5 1 14 2.5 14C2.5 14 5.5 14 5.5 14C7 14 7 11.5 5.5 11.5C5.5 11.5 2.5 11.5 2.5 11.5zM9.5 11.5C8 11.5 8 14 9.5 14C9.5 14 12.5 14 12.5 14C14 14 14 11.5 12.5 11.5C12.5 11.5 9.5 11.5 9.5 11.5zM4.5 1C3.75 1 3.75 2 4.5 2L5.5 2C6.25 2 6.25 1 5.5 1C5.5 1 4.5 1 4.5 1zM9.5 1C8.75 1 8.75 2 9.5 2C9.5 2 10.5 2 10.5 2C11.25 2 11.25 1 10.5 1C10.5 1 9.5 1 9.5 1z" },
  monument: { color: "#9a7a4c", glyph: "M9 9L9 11.5L6 11.5L6 9L4.73 9C4.45 9 4.23 8.78 4.23 8.5C4.23 8.44 4.24 8.38 4.26 8.32L5.86 5.03C5.95 4.86 6.12 4.75 6.31 4.75L8.69 4.75C8.88 4.75 9.05 4.86 9.14 5.03L10.74 8.32C10.84 8.58 10.71 8.87 10.45 8.97C10.4 8.99 10.34 9 10.27 9L9 9ZM11 12L11 13L12 13L12 14L3 14L3 13L4 13L4 12L11 12ZM7.5 1C8.33 1 9 1.67 9 2.5C9 3.33 8.33 4 7.5 4C6.67 4 6 3.33 6 2.5C6 1.67 6.67 1 7.5 1Z" },
  memorial: { color: "#9a7a4c", glyph: "M13.5 13L14 15L1 15L1.5 13L13.5 13ZM7.5 0C9.5 0 11 1 12 3L12 12.5L3 12.5L3 3C4 1 5.5 0 7.5 0ZM9.5 8L5.5 8L5.5 9L9.5 9L9.5 8ZM10.5 6L4.5 6L4.5 7L10.5 7L10.5 6ZM9 4L6 4L6 5L9 5L9 4Z" },
  toilets: { color: "#7a8591", glyph: "M5.67 3.46L3.33 3.46L1 11.54L3.33 11.54L3.33 15L5.67 15L5.67 11.54L8 11.54L5.67 3.46ZM4.73 2.31L4.27 2.31C3.68 2.31 3.33 1.96 3.33 1.38L3.33 0.92C3.33 0.35 3.68 0 4.27 0L4.85 0C5.32 0 5.67 0.35 5.67 0.92L5.67 1.5C5.67 1.96 5.32 2.31 4.73 2.31ZM12.83 3.53L8.21 3.53L8.21 9.3L9.36 9.3L9.36 15.07L11.67 15.07L11.67 9.3L12.83 9.3L12.83 3.53ZM10.73 2.31L10.27 2.31C9.68 2.31 9.33 1.96 9.33 1.38L9.33 0.92C9.33 0.35 9.68 0 10.27 0L10.85 0C11.32 0 11.67 0.35 11.67 0.92L11.67 1.5C11.67 1.96 11.32 2.31 10.73 2.31Z" },
  water: { color: "#3a9fcf", glyph: "M14 9L13.16 14.2C13.07 14.66 12.66 15 12.18 15L8.82 15C8.34 15 7.93 14.66 7.84 14.2L7 9L14 9ZM12.78 10L8.22 10L8.64 12.09C9.22 12.57 9.81 12.54 10.38 12.03L10.66 11.77C11.3 11.19 11.92 10.97 12.56 11.1L12.78 10ZM9 2C10.66 2 12 3.34 12 5L12 7C12.28 7 12.5 7.22 12.5 7.5C12.5 7.75 12.32 7.95 12.09 7.99L12 8L9 8C8.72 8 8.5 7.78 8.5 7.5C8.5 7.25 8.68 7.05 8.91 7.01L9 7L9 5L0 5L0 2L9 2Z" },
} as const satisfies Record<string, { color: string; glyph: string }>;

export type MapIcon = keyof typeof MAP_ICONS;

const PREFIX = "poi-";
/** The image id a style layer uses for an icon. */
export const mapIconId = (icon: MapIcon) => `${PREFIX}${icon}`;

/** Device pixels per CSS pixel the icons are drawn at; MapLibre scales them for other screens. */
export const MAP_ICON_PIXEL_RATIO = 2;
const SIZE = 24 * MAP_ICON_PIXEL_RATIO;
const GLYPH = 13 * MAP_ICON_PIXEL_RATIO;

/**
 * Draw the image MapLibre reported missing, or null if it is not one of ours (or the browser cannot draw),
 * so the basemap simply leaves that symbol without an icon.
 */
export function drawMapIcon(id: string): ImageData | null {
  if (!id.startsWith(PREFIX)) return null;
  const icon = MAP_ICONS[id.slice(PREFIX.length) as MapIcon] as (typeof MAP_ICONS)[MapIcon] | undefined;
  if (!icon) return null;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const border = 1.5 * MAP_ICON_PIXEL_RATIO;
  context.beginPath();
  context.arc(SIZE / 2, SIZE / 2, SIZE / 2 - border, 0, 2 * Math.PI);
  context.fillStyle = icon.color;
  context.fill();
  context.lineWidth = border;
  context.strokeStyle = "#ffffff";
  context.stroke();
  context.translate((SIZE - GLYPH) / 2, (SIZE - GLYPH) / 2);
  context.scale(GLYPH / 15, GLYPH / 15);
  context.fillStyle = "#ffffff";
  context.fill(new Path2D(icon.glyph));
  return context.getImageData(0, 0, SIZE, SIZE);
}
