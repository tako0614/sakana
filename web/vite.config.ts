import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

function copyOrtRuntime(): Plugin {
  return {
    name: 'copy-ort-runtime',
    configureServer(server) {
      server.middlewares.use('/ort', async (request, response, next) => {
        const name = path.basename(request.url?.split('?')[0] ?? '');
        if (!/^ort-wasm.*\.(?:wasm|mjs)$/.test(name)) {
          next();
          return;
        }
        try {
          const content = await readFile(path.resolve('node_modules/onnxruntime-web/dist', name));
          response.statusCode = 200;
          response.setHeader(
            'Content-Type',
            name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
          );
          response.end(content);
        } catch {
          next();
        }
      });
    },
    async writeBundle(options) {
      const output = path.resolve(String(options.dir ?? 'dist'), 'ort');
      const source = path.resolve('node_modules/onnxruntime-web/dist');
      await mkdir(output, { recursive: true });
      for (const name of await readdir(source)) {
        if (/^ort-wasm.*\.(?:wasm|mjs)$/.test(name)) {
          await copyFile(path.join(source, name), path.join(output, name));
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), copyOrtRuntime()],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
});
