// PulseOS palette: blue / white / cool neutrals only. Amber and red exist for
// operational status (never brand decoration); teal is the single accent.
//
// The primary scale is the brand-950..50 azure ramp shifted one step so that
// step 600 (#0873DD, white text 4.9:1) is the safe solid fill for buttons and
// links, 500 (#1685F8) is the bright chart / focus blue, and 700..900 are the
// deep blues for text-on-tint and the cobalt glass navigation.
export const colors = {
  primary: {
    50: "#f4faff",
    100: "#e5f3ff",
    200: "#c9e5ff",
    300: "#9dd0ff",
    400: "#3b9cff",
    500: "#1685f8",
    600: "#0873dd",
    700: "#075fbc",
    800: "#074c9b",
    900: "#063b79",
  },
  accent: {
    100: "#d7f5f2",
    300: "#8fe3da",
    500: "#2bb8ab",
    700: "#1c8a80",
  },
  neutral: {
    0: "#ffffff",
    50: "#f6fafe",
    100: "#edf4fb",
    200: "#dce7f3",
    300: "#c3d3e4",
    400: "#98adc3",
    500: "#5c728a",
    600: "#4a6078",
    700: "#34485e",
    800: "#22344a",
    900: "#102a43",
  },
  slate: {
    500: "#4a6078",
    700: "#243b53",
    900: "#102a43",
  },
  warning: {
    100: "#fdf1d8",
    500: "#c98a1f",
    700: "#8f5f0e",
  },
  danger: {
    100: "#fbe1de",
    500: "#c14634",
    700: "#8f2f22",
  },
  // Page background behind everything: icy blue base with a brighter centre.
  // The layered ambient gradient itself lives in globals.css (.app-shell).
  canvas: {
    base: "#eef7ff",
    bright: "#f8fcff",
  },
  chart: {
    blue: "#1685f8",
    teal: "#2bb8ab",
    amber: "#c98a1f",
  },
  // Semantic roles. Components should prefer these over raw scale steps so a
  // re-brand is a token edit, not a codebase sweep. Mirrored 1:1 in
  // apps/web/app/globals.css (@theme) as --color-brand, --color-surface, etc.
  brand: {
    DEFAULT: "#0873dd",
    deep: "#074c9b",
    soft: "#e5f3ff",
  },
  surface: {
    DEFAULT: "#ffffff",
    elevated: "#ffffff",
    muted: "#f4faff",
    info: "#eaf5ff",
    glass: "rgba(255, 255, 255, 0.66)",
    glassStrong: "rgba(255, 255, 255, 0.82)",
  },
  border: {
    DEFAULT: "rgba(63, 146, 229, 0.18)",
    strong: "#b5c9df",
    glass: "rgba(255, 255, 255, 0.64)",
  },
  text: {
    primary: "#102a43",
    secondary: "#5c728a",
  },
  focusRing: "#1685f8",
} as const;

// Non-colour shell tokens (CSS-variable mirrors live in globals.css).
export const shell = {
  // Radius hierarchy: shell 20, large panel 16, card 14, control 10, chip 8.
  radiusShell: "1.25rem",
  radiusPanel: "1rem",
  radiusCard: "0.875rem",
  radiusControl: "0.625rem",
  radiusChip: "0.5rem",
  // Shadows are tokens: no per-page ad-hoc shadows.
  shadowGlass: "0 10px 30px rgba(34, 91, 145, 0.1)",
  shadowPanel: "0 3px 10px rgba(35, 74, 113, 0.05)",
  // The one glass material's filter.
  glassBlur: "blur(18px) saturate(140%)",
} as const;

export type ColorToken = typeof colors;
