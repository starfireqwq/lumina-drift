/** @type {import('tailwindcss').Config} */
import plugin from 'tailwindcss/plugin';
import palette from 'tailwindcss/colors';

const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
// Every colour is read through a CSS variable so one theme switch recolours the whole UI.
// Light themes keep 500-700 (saturated buttons stay saturated) and flip the rest, so
// "text-rose-300 on bg-rose-950" stays readable as "rose-700 on rose-50".
const LIGHT_MAP = { 50: 950, 100: 900, 200: 800, 300: 700, 400: 600, 500: 500, 600: 600, 700: 700, 800: 200, 900: 100, 950: 50 };
const SEMANTIC = ['red', 'rose', 'pink', 'fuchsia', 'purple', 'violet', 'blue', 'sky', 'cyan', 'teal', 'emerald', 'green', 'lime', 'yellow', 'amber', 'orange'];

const channels = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};
const varScale = (name) => Object.fromEntries(SHADES.map((s) => [s, `rgb(var(--${name}-${s}) / <alpha-value>)`]));

const semanticVars = (light) => Object.fromEntries(
  SEMANTIC.flatMap((c) => SHADES.map((s) => [`--${c}-${s}`, channels(palette[c][light ? LIGHT_MAP[s] : s])])),
);

export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        neutral: varScale('n'),
        slate: varScale('n'),
        gray: varScale('n'),
        zinc: varScale('n'),
        stone: varScale('n'),
        indigo: varScale('a'),
        ...Object.fromEntries(SEMANTIC.map((c) => [c, varScale(c)])),
        atelier: {
          dark: 'rgb(var(--n-950) / <alpha-value>)',
          panel: 'rgb(var(--n-900) / <alpha-value>)',
          border: 'rgb(var(--n-700) / <alpha-value>)',
          accent: 'rgb(var(--a-500) / <alpha-value>)',
          hover: 'rgb(var(--n-800) / <alpha-value>)',
        }
      },
      // Only text: bg-white swatches and white borders must stay white in every theme.
      textColor: {
        white: 'rgb(var(--text-strong) / <alpha-value>)',
      },
      keyframes: {
        jelly: {
          '0%': { transform: 'scale(1, 1)' },
          '20%': { transform: 'scale(1.28, 0.75)' },
          '40%': { transform: 'scale(0.82, 1.22)' },
          '60%': { transform: 'scale(1.12, 0.92)' },
          '80%': { transform: 'scale(0.96, 1.04)' },
          '100%': { transform: 'scale(1, 1)' },
        },
        springPop: {
          '0%': { transform: 'scale(0.8)', opacity: '0' },
          '60%': { transform: 'scale(1.12)' },
          '80%': { transform: 'scale(0.95)' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        voiceWave: {
          '0%, 100%': { transform: 'scaleY(0.35)' },
          '50%': { transform: 'scaleY(1)' },
        },
        slideUpSmooth: {
          '0%': { transform: 'translateY(100%)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        }
      },
      animation: {
        jelly: 'jelly 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
        springPop: 'springPop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)',
        slideUpSmooth: 'slideUpSmooth 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
      }
    },
  },
  plugins: [
    plugin(function({ addVariant, addBase }) {
      addVariant('light', ':is(html.light &)');
      // In light themes text-white means "strongest text" (dark); on solid/high-opacity saturated fills it must stay white.
      // Exclude translucent fills (/10../60) like bg-indigo-600/20 so badges & toolbar buttons keep dark readable text.
      const saturated = [...SEMANTIC, 'indigo'].flatMap((c) =>
        [500, 600, 700].flatMap((s) => [
          `[class~="bg-${c}-${s}"]`,
          `[class~="bg-${c}-${s}/95"]`,
          `[class~="bg-${c}-${s}/90"]`,
          `[class~="bg-${c}-${s}/85"]`,
          `[class~="bg-${c}-${s}/80"]`,
          `[class~="from-${c}-${s}"]`,
        ])
      );
      addBase({
        ':root': semanticVars(false),
        'html.light': semanticVars(true),
        // ...and light tinted text on them (text-sky-100 on bg-sky-700) keeps its light shade
        [`html.light :is(${[...saturated].join(',')})`]: {
          '--text-strong': '255 255 255',
          ...Object.fromEntries(SEMANTIC.flatMap((c) => [50, 100, 200, 300].map((s) => [`--${c}-${s}`, channels(palette[c][s])]))),
          ...Object.fromEntries([50, 100, 200, 300].map((s) => [`--a-${s}`, `var(--a-raw-${s})`])),
        },
      });
    }),
  ],
};
