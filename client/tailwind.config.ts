import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Handwriting for the scrap-paper standings and feed.
        scrawl: ['Caveat', 'Kalam', 'cursive'],
        hand: ['Kalam', 'Caveat', 'cursive'],
      },
      colors: {
        ink: '#0f172a',
        mist: '#e2e8f0',
        signal: '#ea580c',
      },
    },
  },
  plugins: [],
} satisfies Config;
