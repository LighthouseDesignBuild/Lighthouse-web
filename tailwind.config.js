import forms from '@tailwindcss/forms';
import typography from '@tailwindcss/typography';
import aspectRatio from '@tailwindcss/aspect-ratio';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./pages/**/*.html",
    "./src/**/*.{html,js}",
  ],
  darkMode: 'class', // Enable class-based dark mode
  theme: {
    extend: {
      colors: {
        'lighthouse': {
          // Primary Blue - Main brand color
          'navy': '#152D45',        // Coastal Navy (darkened) - primary brand color for headers, navigation
          'dark-navy': '#0f172a',   // Dark Slate - footer, dark sections, primary text

          // Accent Blue
          'ocean-mist': '#5C88A0',  // Ocean Mist - Our core values section
          'accent-blue': '#5C88A0', // Alias for Ocean Mist

          // Accent Gold - All buttons
          'teal': '#D6B86A',        // Beacon Gold - primary CTA buttons and accents
          'gold': '#D6B86A',        // Alias for Beacon Gold
          'accent-gold': '#D6B86A', // Beacon Gold - all buttons throughout site
          'light-gold': '#E8D4A0',  // Lighter variant for hover states

          // Neutrals
          'white': '#F5F7F8',       // Lighthouse White - neutral light backgrounds
          'warm-gray': '#F5F7F8',   // Alias for Lighthouse White
          'gray': '#B8BFC6',        // Driftwood Gray - neutral mid tones
          'driftwood': '#B8BFC6',   // Driftwood Gray - borders, secondary text
          'charcoal': '#0f172a',    // Dark Slate - text color (matches dark-navy)
        },
      },
      fontFamily: {
        'display': ['Playfair Display', 'Georgia', 'serif'],
        'heading': ['Montserrat', 'sans-serif'],
        'body': ['Lato', 'sans-serif'],
      },
      spacing: {
        '128': '32rem',
        '144': '36rem',
      },
      animation: {
        'fade-in': 'fadeIn 0.8s ease-in-out',
        'slide-up': 'slideUp 0.6s ease-out',
        'slide-down': 'slideDown 0.6s ease-out',
        'scale-in': 'scaleIn 0.5s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        slideDown: {
          '0%': { transform: 'translateY(-20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.9)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'hero-pattern': "url('/src/assets/images/hero-pattern.svg')",
      },
    },
  },
  plugins: [
    forms,
    typography,
    aspectRatio,
  ],
}
