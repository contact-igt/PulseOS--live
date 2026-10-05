export const typography = {
  fontFamily: {
    sans: "'Inter', ui-sans-serif, system-ui, sans-serif",
  },
  scale: {
    xs: { size: "12px", lineHeight: "16px" },
    sm: { size: "13px", lineHeight: "18px" },
    base: { size: "14px", lineHeight: "20px" },
    md: { size: "16px", lineHeight: "24px" },
    lg: { size: "20px", lineHeight: "28px" },
    xl: { size: "24px", lineHeight: "32px" },
  },
  weight: {
    regular: 400,
    medium: 500,
    semibold: 600,
  },
} as const;

export type TypographyToken = typeof typography;
