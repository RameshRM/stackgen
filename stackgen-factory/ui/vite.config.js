import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    server: {
        port: 5173,
        // the control plane is the only thing the browser talks to
        proxy: {
            '/api': 'http://localhost:4000',
        },
    },
    plugins: [react()],
});
