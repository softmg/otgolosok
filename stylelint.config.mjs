/**
 * CSS conventions that keep the layout from drifting. See docs/agents/layout-architecture.md.
 * Global styles live in src/styles (tokens, base, ui layers); components use CSS Modules.
 */

/** Files not yet moved into CSS Modules. Each migration phase removes its entries; the list must end empty. */
export const legacyUnmigrated = [
  "src/styles/legacy.css",
  "src/features/account/account.css",
  "src/features/admin/admin.css",
  "src/features/admin/content-admin.css",
  "src/features/admin/walk-admin.css",
  "src/features/auth/auth.css",
  "src/features/tour/walk-session.css",
  "src/features/walks/history.css",
  "src/features/walks/walks.css",
];

const camelCase = "^[a-z][a-zA-Z0-9]*$";

/** @type {import("stylelint").Config} */
const config = {
  extends: ["stylelint-config-standard", "stylelint-config-css-modules"],
  ignoreFiles: legacyUnmigrated,
  rules: {
    "selector-class-pattern": [camelCase, { message: "Classes in CSS Modules are camelCase (styles.sheetBody)" }],
    "custom-property-pattern": null,
    "value-keyword-case": ["lower", { ignoreProperties: ["/^--font-/", "font-family", "font"] }],
    "keyframes-name-pattern": [camelCase, { message: "Keyframes in CSS Modules are camelCase" }],
    // Colours and safe areas exist only as tokens in src/styles/tokens.css.
    "color-no-hex": true,
    "color-named": "never",
    "function-disallowed-list": [["env", "rgb", "rgba", "hsl", "hsla"], { message: "Use a token from src/styles/tokens.css" }],
    "declaration-property-value-allowed-list": {
      "z-index": ["/^var[(]--z-/", "auto"],
      "font-size": ["/^var[(]--text-/", "inherit", "/^clamp[(]/"],
    },
    // Only the shell and the navigation island may be positioned against the viewport.
    "declaration-property-value-disallowed-list": { position: ["fixed"] },
    "unit-disallowed-list": [["vh", "svh", "dvh", "lvh", "vw"], { message: "Viewport units belong to the map shell and base styles" }],
    // Components adapt through container queries and intrinsic sizing; screen modes live in the map shell.
    "media-feature-name-allowed-list": [["prefers-reduced-motion", "hover", "pointer"], { message: "Use a container query; screen modes belong to map-shell.module.css" }],
    "selector-disallowed-list": [["/\.leaflet-/", "/\.maplibregl-/"], { message: "Leaflet internals are styled only in explore-map.module.css" }],
    "declaration-no-important": true,
  },
  overrides: [
    {
      files: ["src/styles/tokens.css"],
      rules: { "color-no-hex": null, "color-named": null, "function-disallowed-list": null, "unit-disallowed-list": null },
    },
    {
      files: ["src/styles/*.css"],
      rules: { "selector-class-pattern": null, "keyframes-name-pattern": null },
    },
    {
      files: ["src/styles/base.css"],
      rules: { "declaration-no-important": null, "unit-disallowed-list": null },
    },
    {
      files: ["src/features/shell/**/*.css", "src/features/navigation/**/*.css"],
      rules: { "declaration-property-value-disallowed-list": null },
    },
    {
      files: ["src/features/shell/**/*.css"],
      rules: { "unit-disallowed-list": null, "media-feature-name-allowed-list": null },
    },
    {
      files: ["src/features/admin/**/*.css"],
      rules: { "media-feature-name-allowed-list": null },
    },
    {
      files: ["src/features/explore/explore-map.module.css"],
      rules: {
        "selector-disallowed-list": null,
        "selector-class-pattern": ["^([a-z][a-zA-Z0-9]*|leaflet-[a-z-]+)$", { message: "camelCase, or a Leaflet class inside :global()" }],
      },
    },
  ],
};

export default config;
