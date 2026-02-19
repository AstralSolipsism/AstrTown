import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  base: '/ai-town',
  plugins: [react()],
  server: {
    allowedHosts: true,
    hmr: {
      protocol: 'wss',
      host: 'town.outlune.com',
      clientPort: 443,
    },
  },
});
