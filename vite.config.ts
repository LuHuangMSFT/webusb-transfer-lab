import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  base: '/webusb-transfer-lab/',
  plugins: command === 'serve' ? [{
    name: 'development-csp',
    transformIndexHtml: (html) => html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
  }] : [],
  define: {
    __SITE_COMMIT__: JSON.stringify(process.env.GITHUB_SHA ?? 'local-development'),
  },
}))
