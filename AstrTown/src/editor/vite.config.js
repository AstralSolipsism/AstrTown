import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    allowedHosts: ['town.outlune.com', 'localhost'],
    hmr: {
      protocol: 'wss',
      host: 'town.outlune.com',
      clientPort: 443,
    },
  },
})
