/** @type {import('tailwindcss').Config} */
module.exports = {
  // Dark mode is driven by a `.dark` class on the <html> element (not the
  // OS media query). ExampleOrgNav.applyTheme in dashboard/js/navigation.js
  // adds/removes it based on localStorage("ExampleOrg_theme"). Kept as a
  // class so the operator can override the OS preference.
  darkMode: ["class"],
  content: [
    "./dashboard/**/*.html",
    "./dashboard/**/*.js",
    "./src/**/*.{ts,tsx,js,jsx,html}",
  ],
  safelist: [
    { pattern: /^(bg|text|border|ring|from|to|via)-(red|green|blue|yellow|orange|amber|purple|pink|indigo|gray|slate|zinc|emerald|teal|cyan|sky|violet|fuchsia|rose|lime)-(50|100|200|300|400|500|600|700|800|900|950)$/ },
    { pattern: /^(bg|text|border)-(red|green|blue|yellow|orange|amber|purple|pink|indigo|gray|slate|zinc|emerald|teal|cyan|sky|violet|fuchsia|rose|lime)-(50|100|200|300|400|500|600|700|800|900|950)\/(10|20|25|30|40|50|60|70|75|80|90)$/ },
    { pattern: /^(grid-cols|col-span|row-span)-(1|2|3|4|5|6|7|8|9|10|11|12)$/ },
    { pattern: /^(w|h|min-w|min-h|max-w|max-h)-(0|0\.5|1|1\.5|2|2\.5|3|3\.5|4|5|6|7|8|9|10|11|12|14|16|20|24|28|32|36|40|44|48|52|56|60|64|72|80|96|auto|full|screen|min|max|fit)$/ },
    { pattern: /^(p|m|px|py|pt|pr|pb|pl|mx|my|mt|mr|mb|ml|gap|space-x|space-y)-(0|0\.5|1|1\.5|2|2\.5|3|3\.5|4|5|6|7|8|9|10|11|12|14|16|20|24|28|32|36|40|44|48|52|56|60|64)$/ },
    { pattern: /^(rounded|rounded-t|rounded-b|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br)(-(none|sm|md|lg|xl|2xl|3xl|full))?$/ },
    { pattern: /^(text)-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)$/ },
    { pattern: /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/ },
    { pattern: /^opacity-(0|5|10|20|25|30|40|50|60|70|75|80|90|95|100)$/ },
    'hidden', 'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid',
    'animate-pulse', 'animate-spin', 'animate-bounce', 'animate-ping',
    // Semantic-token utilities — safe-listed so a future full rebuild picks
    // them up even when they only appear on pages that add them dynamically.
    'bg-background', 'text-foreground',
    'bg-card', 'text-card-foreground',
    'bg-popover', 'text-popover-foreground',
    'bg-primary', 'text-primary-foreground',
    'bg-secondary', 'text-secondary-foreground',
    'bg-muted', 'text-muted-foreground',
    'bg-accent', 'text-accent-foreground',
    'bg-destructive', 'text-destructive-foreground',
    'border-border', 'border-input', 'ring-ring',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
      // Semantic color tokens sourced from CSS custom properties defined in
      // dashboard/css/theme.css. HSL triplets (no `hsl()` wrapper in the
      // variable) so opacity modifiers like `bg-primary/50` work out of the
      // box. To rebuild colors for both modes, edit theme.css — the config
      // here just plumbs the variables into Tailwind's class generator.
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [],
};
