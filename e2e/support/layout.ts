import { expect, type Page } from "@playwright/test";

export type Viewport = { width: number; height: number };
export type SafeArea = { top: number; right: number; bottom: number; left: number };
export type LayoutCase = { name: string; viewport: Viewport; safeArea?: SafeArea };

const NO_SAFE_AREA: SafeArea = { top: 0, right: 0, bottom: 0, left: 0 };

/** Portrait phones, landscape phones, the 699/700 mode boundary, tablets and desktops. */
export const VIEWPORTS: Viewport[] = [
  { width: 320, height: 568 }, { width: 360, height: 640 }, { width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 },
  { width: 568, height: 320 }, { width: 667, height: 375 }, { width: 844, height: 390 }, { width: 932, height: 430 },
  { width: 699, height: 800 }, { width: 700, height: 800 },
  { width: 768, height: 1024 }, { width: 1024, height: 500 }, { width: 1280, height: 640 }, { width: 1440, height: 900 },
];

/** Notched phones: the insets are emulated through CDP, so these cases run only in Chromium. */
export const SAFE_AREA_CASES: LayoutCase[] = [
  { name: "390×844 с вырезом", viewport: { width: 390, height: 844 }, safeArea: { top: 47, right: 0, bottom: 34, left: 0 } },
  { name: "844×390 с вырезом", viewport: { width: 844, height: 390 }, safeArea: { top: 0, right: 47, bottom: 21, left: 47 } },
];

export const WEBKIT_VIEWPORTS: Viewport[] = [
  { width: 320, height: 568 }, { width: 390, height: 844 }, { width: 667, height: 375 }, { width: 1024, height: 500 },
];

export function layoutCases(browserName: string): LayoutCase[] {
  const plain = (browserName === "webkit" ? WEBKIT_VIEWPORTS : VIEWPORTS).map(viewport => ({ name: `${viewport.width}×${viewport.height}`, viewport }));
  return browserName === "chromium" ? [...plain, ...SAFE_AREA_CASES] : plain;
}

export async function applyLayoutCase(page: Page, layout: LayoutCase) {
  await page.setViewportSize(layout.viewport);
  if (layout.safeArea) {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setSafeAreaInsetsOverride", { insets: layout.safeArea });
  }
}

export type Invariant =
  | "viewport" // a region leaves the viewport or enters a safe-area inset
  | "overlap" // two regions intersect, or regions of different kinds are closer than 8 px
  | "target" // a control is covered at its centre or is smaller than 44×44
  | "hscroll" // the page or the sheet scrolls horizontally
  | "footer" // the sheet footer is not fully visible
  | "body" // an overflowing sheet body keeps less than 48 px visible
  | "free" // the uncovered map has no 160×72 rectangle
  | "focus" // the selected marker or the route is under a region or outside the viewport
  | "content"; // a content page puts its last control under the navigation or under the top inset

export type Violation = { invariant: Invariant; detail: string };

export type LayoutOptions = {
  /** Map screens keep a usable uncovered area. */
  map?: boolean;
  /** The selected marker or the route must stay in the uncovered area. */
  focus?: "marker" | "route";
  /** Content pages: the last control must not end under the navigation. */
  content?: boolean;
};

export type KnownFailure = {
  screen: string;
  state: string;
  /** Case ids (see caseId); every listed case must still fail. */
  cases: string[];
  invariant: Invariant;
  reason: string;
};

type Box = { left: number; top: number; right: number; bottom: number };

/** Evaluates every invariant in one frame and returns the violations. */
export async function collectViolations(page: Page, options: LayoutOptions, safeArea: SafeArea = NO_SAFE_AREA): Promise<Violation[]> {
  return page.evaluate(({ options, safeArea }) => {
    const violations: { invariant: string; detail: string }[] = [];
    const add = (invariant: string, detail: string) => violations.push({ invariant, detail });
    // The Next.js dev indicator is not part of the app and sits over the bottom-left corner.
    for (const portal of document.querySelectorAll<HTMLElement>("nextjs-portal")) portal.style.display = "none";
    const width = document.documentElement.clientWidth;
    const height = window.innerHeight;
    const round = (box: Box) => `${Math.round(box.left)},${Math.round(box.top)}–${Math.round(box.right)},${Math.round(box.bottom)}`;
    const toBox = (rect: DOMRect): Box => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    const visible = (element: Element) => {
      if (!element.getClientRects().length) return false;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const describe = (element: Element) => element.getAttribute("aria-label") || element.textContent?.trim().replace(/\s+/g, " ").slice(0, 40) || element.tagName.toLowerCase();

    const regions = [...document.querySelectorAll("[data-region]")]
      .filter(element => element.getAttribute("data-region") !== "map" && visible(element))
      .map(element => ({ element, name: element.getAttribute("data-region")!, box: toBox(element.getBoundingClientRect()) }));

    // viewport: every region stays inside the viewport minus the safe-area insets.
    const safe: Box = { left: safeArea.left, top: safeArea.top, right: width - safeArea.right, bottom: height - safeArea.bottom };
    for (const region of regions) {
      const { box } = region;
      if (box.left < safe.left - 0.5 || box.top < safe.top - 0.5 || box.right > safe.right + 0.5 || box.bottom > safe.bottom + 0.5)
        add("viewport", `${region.name} «${describe(region.element)}» ${round(box)} вне ${round(safe)}`);
    }

    // overlap: regions never intersect; regions of different kinds keep an 8 px gap.
    for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i], b = regions[j];
      if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
      const gap = a.name === b.name ? 0 : 8;
      const apart = a.box.right + gap <= b.box.left + 0.5 || b.box.right + gap <= a.box.left + 0.5 || a.box.bottom + gap <= b.box.top + 0.5 || b.box.bottom + gap <= a.box.top + 0.5;
      if (!apart) add("overlap", `${a.name} ${round(a.box)} и ${b.name} ${round(b.box)}`);
    }

    // target: every enabled control inside a region is hit-testable and at least 44×44.
    const scrollParent = (element: Element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (/(auto|scroll|hidden)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 1) return parent;
      }
      return null;
    };
    const controls = new Set<Element>();
    for (const region of regions) for (const control of region.element.querySelectorAll("button, a[href], input:not([type=hidden]), select, summary, [role=button]")) controls.add(control);
    for (const control of controls) {
      if (!visible(control) || (control as HTMLButtonElement).disabled) continue;
      if (getComputedStyle(control).display === "inline") continue; // links inside a sentence
      const input = control as HTMLInputElement;
      const target = input.type === "checkbox" || input.type === "radio" ? control.closest("label") ?? control : control;
      const box = toBox(target.getBoundingClientRect());
      const x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2;
      const scroller = scrollParent(target);
      if (scroller) {
        const clip = scroller.getBoundingClientRect();
        if (y < clip.top || y > clip.bottom) continue; // scrolled away: the user scrolls to it
      }
      const hit = x >= 0 && y >= 0 && x <= width && y <= height ? document.elementFromPoint(x, y) : null;
      if (!hit || !(target.contains(hit) || hit.contains(target))) add("target", `«${describe(control)}» закрыт: в центре ${hit ? describe(hit) : "ничего"}`);
      const exempt = control.closest("[data-region=attribution]");
      if (!exempt && (box.right - box.left < 43.5 || box.bottom - box.top < 43.5)) add("target", `«${describe(control)}» ${Math.round(box.right - box.left)}×${Math.round(box.bottom - box.top)} меньше 44×44`);
    }

    // hscroll: neither the page nor a sheet scrolls sideways.
    const page = document.scrollingElement!;
    if (page.scrollWidth > page.clientWidth + 1) add("hscroll", `страница ${page.scrollWidth} > ${page.clientWidth}`);
    for (const region of regions.filter(item => item.name === "sheet"))
      for (const element of [region.element, ...region.element.querySelectorAll("*")])
        if (element.scrollWidth > element.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(element).overflowX))
          add("hscroll", `в панели «${describe(element)}» ${element.scrollWidth} > ${element.clientWidth}`);

    // footer / body: the main action is visible without scrolling; the scrolling body stays usable.
    for (const region of regions.filter(item => item.name === "sheet")) {
      for (const footer of region.element.querySelectorAll("[data-sheet-part=footer]")) {
        if (!visible(footer)) continue;
        const box = toBox(footer.getBoundingClientRect());
        const clips = [region.box, safe];
        const scroller = scrollParent(footer);
        if (scroller) clips.push(toBox(scroller.getBoundingClientRect()));
        if (clips.some(clip => box.top < clip.top - 0.5 || box.bottom > clip.bottom + 0.5)) add("footer", `«${describe(footer)}» ${round(box)} обрезано`);
      }
      for (const body of region.element.querySelectorAll("[data-sheet-part=body]")) {
        if (!visible(body) || body.scrollHeight <= body.clientHeight + 1) continue;
        if (body.clientHeight < 48) add("body", `прокручиваемая часть «${describe(body)}» высотой ${body.clientHeight}`);
      }
    }

    // free: the uncovered map keeps a 160×72 rectangle (checked on a 4 px grid).
    if (options.map) {
      const step = 4, columns = Math.floor((safe.right - safe.left) / step), rows = Math.floor((safe.bottom - safe.top) / step);
      const heights = new Array<number>(columns).fill(0);
      let found = false;
      for (let row = 0; row < rows && !found; row++) {
        const y = safe.top + row * step + step / 2;
        let run = 0;
        for (let column = 0; column < columns; column++) {
          const x = safe.left + column * step + step / 2;
          const covered = regions.some(({ box }) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom);
          heights[column] = covered ? 0 : heights[column] + 1;
          run = heights[column] * step >= 72 ? run + 1 : 0;
          if (run * step >= 160) { found = true; break; }
        }
      }
      if (!found) add("free", "на карте нет свободного места 160×72");
    }

    // focus: the selected marker or the route line stays in the uncovered map.
    if (options.focus) {
      const element = options.focus === "marker" ? document.querySelector("[data-marker][data-selected=true]") : document.querySelector("[data-route]");
      if (!element) add("focus", options.focus === "marker" ? "нет выбранной отметки" : "нет линии маршрута");
      else {
        const box = toBox(element.getBoundingClientRect());
        if (box.left < safe.left || box.top < safe.top || box.right > safe.right || box.bottom > safe.bottom) add("focus", `${options.focus} ${round(box)} за краем окна`);
        for (const region of regions) {
          const apart = box.right <= region.box.left || region.box.right <= box.left || box.bottom <= region.box.top || region.box.bottom <= box.top;
          if (!apart) add("focus", `${options.focus} ${round(box)} под ${region.name}`);
        }
      }
    }

    // content: after scrolling to the end the last control is not under the navigation or the top inset.
    if (options.content) {
      const main = document.querySelector("main");
      const all = main ? [...main.querySelectorAll("button, a[href], input:not([type=hidden]), select, summary")].filter(visible) : [];
      const last = all.at(-1);
      if (last) {
        last.scrollIntoView({ block: "end", behavior: "instant" });
        window.scrollTo({ top: document.scrollingElement!.scrollHeight, behavior: "instant" });
        const box = toBox(last.getBoundingClientRect());
        const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
        if (!hit || !(last.contains(hit) || hit.contains(last))) add("content", `последний элемент «${describe(last)}» закрыт: в центре ${hit ? describe(hit) : "ничего"}`);
      }
      window.scrollTo({ top: 0, behavior: "instant" });
      const first = main ? [...main.querySelectorAll("h1, button, a[href]")].find(visible) : undefined;
      if (first && first.getBoundingClientRect().top < safeArea.top) add("content", `«${describe(first)}» заходит под верхний вырез`);
    }

    return violations;
  }, { options, safeArea }) as Promise<Violation[]>;
}

/** Chromium cases go by their name; other browsers prefix it, e.g. "webkit 390×844". */
export function caseId(browserName: string, layout: LayoutCase) {
  return browserName === "chromium" ? layout.name : `${browserName} ${layout.name}`;
}

/**
 * Checks the layout invariants for one screen state. Violations listed in `known`
 * for this case are tolerated, but each of them must still occur — a fixed defect
 * fails the run until its entry is removed.
 */
export async function expectLayout(page: Page, { screen, state, layout, browserName, options, known }: {
  screen: string; state: string; layout: LayoutCase; browserName: string; options: LayoutOptions; known: KnownFailure[];
}) {
  const id = caseId(browserName, layout);
  const expected = known.filter(item => item.screen === screen && item.state === state && item.cases.includes(id));
  const allowed = new Set(expected.map(item => item.invariant));
  let last: Violation[] = [];
  // Layout settles after fonts, map tiles, route fitting and ResizeObserver callbacks: poll until stable.
  await expect.poll(async () => {
    last = await collectViolations(page, options, layout.safeArea);
    const unexpected = last.filter(item => !allowed.has(item.invariant)).map(item => `${item.invariant}: ${item.detail}`);
    const fixed = [...allowed].filter(invariant => !last.some(item => item.invariant === invariant)).map(invariant => `исправлено, уберите из KNOWN_LAYOUT_FAILURES: ${invariant}`);
    return [...unexpected, ...fixed];
  }, { message: `инварианты раскладки: ${screen} / ${state} / ${id}`, timeout: 8_000 }).toEqual([]);
  return last;
}
