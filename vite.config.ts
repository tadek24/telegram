import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/eprom-icon-192.png', 'icons/eprom-icon-512.png', 'icons/apple-touch-icon.png'],
      workbox: {
        importScripts: ['/push-sw.js'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      manifest: {
        name: 'Komunikatr E-Prom',
        short_name: 'E-Prom',
        lang: 'pl',
        description: 'Prywatny komunikator mobilny do bezpiecznych rozmów',
        theme_color: '#703a08',
        background_color: '#fff7e8',
        display: 'standalone',
        id: '/',
        start_url: '/',
        scope: '/',
        orientation: 'portrait-primary',
        categories: ['social', 'communication'],
        prefer_related_applications: false,
        icons: [
          { src: '/icons/eprom-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/eprom-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/eprom-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
    })
  ]
})
