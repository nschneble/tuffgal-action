import { defineConfig } from 'tuffgal';

export default defineConfig({
  baseUrl: 'http://localhost:8080',
  paths: {
    actions: 'tuffgal/actions',
    stories: 'tuffgal/stories',
    baselines: 'tuffgal/baselines',
    report: 'tuffgal/report',
  },
  devServers: {
    command: 'npm run serve',
    healthCheck: [{ url: 'http://localhost:8080', timeoutMs: 30_000 }],
  },
  viewport: { width: 1024, height: 640 },
});
