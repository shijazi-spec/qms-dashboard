/** @type {import('tailwindcss').Config} */
module.exports = {
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
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
