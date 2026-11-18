import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

// 介面縮放 (src/theme/uiScale.ts): every px in the CSS becomes rem (16px = 1rem), so changing the
// root font size scales the whole interface like the browser's zoom. Media queries keep px (rem
// there means the browser default, not the root size), so the layout breakpoints do not move.
const pxToRem = () => ({
  postcssPlugin: 'atelier-px-to-rem',
  Declaration(decl) {
    if (!decl.value.includes('px')) return;
    decl.value = decl.value.replace(/(?<![\w.-])(-?\d*\.?\d+)px\b/g, (_, n) => {
      const v = Number(n);
      return v === 0 ? '0' : `${+(v / 16).toFixed(5)}rem`;
    });
  },
});
pxToRem.postcss = true;

export default {
  plugins: [tailwindcss(), autoprefixer(), pxToRem()],
};
