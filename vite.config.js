import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  root: 'src',
  publicDir: 'public',
  plugins: [
    viteSingleFile({
      removeViteModuleLoader: false,
      useRecommendedBuildConfig: false,
      inlinePattern: ['!**/*.wasm', '!**/cimbar/**']
    }),
    // Installable offline app. This is what makes a PHONE receiver work
    // without a network: opening dist/index.html from local storage gives an
    // opaque origin (no camera on iOS/Android, no sibling-wasm fetch), while
    // the hosted site installed to a home screen keeps a real https origin
    // with everything precached — camera and WASM decode work offline.
    // The single-file dist remains the desktop/USB-stick distribution.
    VitePWA({
      registerType: 'autoUpdate',
      // No separate registerSW.js file — keeps the single-file build single.
      injectRegister: 'inline',
      manifest: {
        name: 'Beam Me Up',
        short_name: 'BeamMeUp',
        description: 'Air-gapped file transfer over light — QR, CIMBAR, and HDMI-UVC, no network.',
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
        display: 'standalone',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        // Precache the app and every runtime-loaded sibling (cimbar glue+wasm,
        // hdmi-uvc kernel, zxing reader) so all modes work offline.
        globPatterns: ['**/*.{html,js,wasm,png}'],
        // cimbar_js.wasm (~2MB) exceeds workbox's 2MiB default.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024
      }
    })
  ],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2020',
    minify: 'terser',
    copyPublicDir: true
  },
  worker: {
    format: 'es'
  }
})
