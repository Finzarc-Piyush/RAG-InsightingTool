/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      borderRadius: {
        // Legacy scale kept so existing rounded-sm/md/lg classes do not
        // shift mid-migration. UX-2 begins switching primitives onto the
        // new brand-* ladder below, one component at a time.
        lg: ".5625rem", /* 9px legacy */
        md: ".375rem",  /* 6px legacy */
        sm: ".1875rem", /* 3px legacy */
        // UX-0 · canonical radius ladder (see docs/brand/brand-guidebook.md §4)
        // chip → brand-full, input → brand-md, button → brand-md,
        // card → brand-lg, dialog → brand-xl, hero → brand-2xl.
        "brand-sm": "0.375rem",  /* 6px  */
        "brand-md": "0.625rem",  /* 10px */
        "brand-lg": "0.75rem",   /* 12px */
        "brand-xl": "1rem",      /* 16px */
        "brand-2xl": "1.25rem",  /* 20px */
      },
      colors: {
        // Flat / base colors (regular buttons)
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          foreground: "hsl(var(--card-foreground) / <alpha-value>)",
          border: "hsl(var(--card-border) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "hsl(var(--popover) / <alpha-value>)",
          foreground: "hsl(var(--popover-foreground) / <alpha-value>)",
          border: "hsl(var(--popover-border) / <alpha-value>)",
        },
        primary: {
          DEFAULT: "hsl(var(--primary) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
          border: "var(--primary-border)",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary) / <alpha-value>)",
          foreground: "hsl(var(--secondary-foreground) / <alpha-value>)",
          border: "var(--secondary-border)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
          border: "var(--muted-border)",
        },
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
          border: "var(--accent-border)",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
          border: "var(--destructive-border)",
        },
        ring: "hsl(var(--ring) / <alpha-value>)",
        chart: {
          "1": "hsl(var(--chart-1) / <alpha-value>)",
          "2": "hsl(var(--chart-2) / <alpha-value>)",
          "3": "hsl(var(--chart-3) / <alpha-value>)",
          "4": "hsl(var(--chart-4) / <alpha-value>)",
          "5": "hsl(var(--chart-5) / <alpha-value>)",
        },
        sidebar: {
          ring: "hsl(var(--sidebar-ring) / <alpha-value>)",
          DEFAULT: "hsl(var(--sidebar) / <alpha-value>)",
          foreground: "hsl(var(--sidebar-foreground) / <alpha-value>)",
          border: "hsl(var(--sidebar-border) / <alpha-value>)",
        },
        "sidebar-primary": {
          DEFAULT: "hsl(var(--sidebar-primary) / <alpha-value>)",
          foreground: "hsl(var(--sidebar-primary-foreground) / <alpha-value>)",
          border: "var(--sidebar-primary-border)",
        },
        "sidebar-accent": {
          DEFAULT: "hsl(var(--sidebar-accent) / <alpha-value>)",
          foreground: "hsl(var(--sidebar-accent-foreground) / <alpha-value>)",
          border: "var(--sidebar-accent-border)"
        },
        status: {
          online: "rgb(34 197 94)",
          away: "rgb(245 158 11)",
          busy: "rgb(239 68 68)",
          offline: "rgb(156 163 175)",
        },
        // UX-0 · Brand signature accent (single-use per view) + semantic additions.
        "accent-gold": {
          DEFAULT: "hsl(var(--accent-gold) / <alpha-value>)",
        },
        success: {
          DEFAULT: "hsl(var(--success) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "hsl(var(--warning) / <alpha-value>)",
        },
      },
      // UX-0 · Motion primitives consumed via Tailwind utilities
      // (`duration-base`, `ease-entrance`, `animate-brand-settle`, …).
      transitionDuration: {
        instant: "100ms",
        quick: "160ms",
        base: "220ms",
        slow: "320ms",
        decisive: "420ms",
      },
      transitionTimingFunction: {
        entrance: "cubic-bezier(0.16, 1, 0.3, 1)",
        exit: "cubic-bezier(0.7, 0, 0.84, 0)",
        standard: "cubic-bezier(0.4, 0, 0.2, 1)",
        emphasized: "cubic-bezier(0.2, 0, 0, 1)",
      },
      // UX-0 · Named elevation ladder alias to the CSS shadow scale.
      boxShadow: {
        "elev-1": "var(--shadow-xs)",
        "elev-2": "var(--shadow-sm)",
        "elev-3": "var(--shadow-md)",
        "elev-4": "var(--shadow-lg)",
        "elev-5": "var(--shadow-2xl)",
      },
      // UX-0 · Background-image token aliases for the brand gradients.
      backgroundImage: {
        "gradient-canvas": "var(--gradient-canvas)",
        "gradient-ink-soft": "var(--gradient-ink-soft)",
        "gradient-elevate": "var(--gradient-elevate)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        serif: ["var(--font-serif)"],
        mono: ["var(--font-mono)"],
        // UX-0 · Brand roles (see docs/brand/brand-guidebook.md §3).
        display: ["var(--font-display)"],
        metric: ["var(--font-metric)"],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        // UX-0 · Brand keyframes. Every consumer must wrap them in a
        // `@media (prefers-reduced-motion: no-preference)` selector — the
        // `.animate-brand-*` utilities in index.css do that by default.
        "brand-settle": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "brand-shimmer": {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "brand-breathe": {
          "0%, 100%": { opacity: "0.75" },
          "50%": { opacity: "1" },
        },
        "brand-underline": {
          from: { transform: "scaleX(0)" },
          to: { transform: "scaleX(1)" },
        },
        "brand-ring": {
          "0%": { boxShadow: "0 0 0 0 hsl(var(--primary) / 0.40)" },
          "100%": { boxShadow: "0 0 0 6px hsl(var(--primary) / 0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "brand-settle": "brand-settle 320ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "brand-shimmer": "brand-shimmer 1500ms linear infinite",
        "brand-breathe": "brand-breathe 3000ms ease-in-out infinite",
        "brand-underline": "brand-underline 260ms cubic-bezier(0.2, 0, 0, 1) both",
        "brand-ring": "brand-ring 900ms cubic-bezier(0.4, 0, 0.2, 1) both",
      },
    },
  },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/typography")],
}
