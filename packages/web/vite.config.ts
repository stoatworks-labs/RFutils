import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const SERVER_PORT = process.env.RFUTILS_SERVER_PORT ?? '8420';

// The React app talks to the RFutils server over REST (/api) and a
// WebSocket (/ws). In dev, Vite proxies both to the Node server so the
// browser only ever sees one origin.
//
// The static build (`npm run build:static`) has no server at all: it runs the
// conversion and coordination code from @rfutils/shared in the browser. It is
// published to Cloudflare Pages, which serves a project at the root of its own
// domain — hence a root base path. Set RFUTILS_BASE to host it under a
// subdirectory instead (e.g. '/RFutils/').
const isStatic = process.env.VITE_RFUTILS_STATIC === '1';
const base = process.env.RFUTILS_BASE ?? '/';

/**
 * Copy pdfjs's worker into the static build at a fixed path, so localApi can
 * point `GlobalWorkerOptions.workerSrc` at it. Deliberately not a `?url` import
 * in the source: that emits the 2.3 MB worker into the server build too, where
 * PDFs are converted server-side and the code that needs it is dead.
 */
function pdfWorkerPlugin(): Plugin {
  const require = createRequire(import.meta.url);
  return {
    name: 'rfutils-pdf-worker',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'pdf.worker.mjs',
        source: readFileSync(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')),
      });
    },
  };
}

/**
 * Fail the server build if it emits more than one JS chunk. The tabs are
 * imported directly and localApi is aliased out, so a second chunk means
 * something heavy came back in — as pdfjs did, silently, when Vite 8 arrived.
 * Loud on purpose: `ls dist/assets` after a Vite bump is easy to forget.
 */
function singleServerChunk(): Plugin {
  return {
    name: 'rfutils-single-server-chunk',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((f) => f.type === 'chunk');
      if (chunks.length > 1) {
        throw new Error(
          `the server build should be one JS chunk, got ${chunks.length}: ` +
            chunks.map((c) => c.fileName).join(', ')
        );
      }
    },
  };
}

/**
 * Stamp the version this build produced onto the support-footer script tag.
 *
 * The tag itself stays in index.html — it is the same document in dev — but the
 * version cannot be written in beside it: a literal goes stale the moment a
 * release is tagged, and a feedback report naming the wrong build is worse than
 * one naming no build at all. Same string as __APP_VERSION__ below, which is
 * what the About dialog shows.
 */
function supportFooterVersion(): Plugin {
  // Not anchored to a leading slash: this runs after Vite has rewritten public
  // asset paths, and an app built with a relative `base` has ./support-footer.js
  // by the time we see it.
  const tag = /<script\s[^>]*\bsrc="[^"]*support-footer\.js"/
  return {
    name: 'stoatworks-support-footer-version',
    transformIndexHtml: {
      order: 'post',
      handler(html: string) {
        // Loud on purpose. The tag is hand-written markup, so a rename or a
        // tidy-up could silently detach the version from every report filed
        // afterwards, and nothing downstream would look wrong.
        if (!tag.test(html)) {
          throw new Error('no support-footer.js tag in index.html — nothing to stamp')
        }
        return html.replace(tag, (m) => `${m} data-version="v${pkg.version}"`)
      }
    }
  }
}

export default defineConfig({
  // The About dialog shows the version the build actually produced. about-data.js
  // carries one baked at sync time as a fallback, and it goes stale the moment a
  // release is tagged; this is the one that is always right.
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.version}`) },
  base,
  plugins: [
    react(),
    supportFooterVersion(),
    ...(isStatic ? [pdfWorkerPlugin()] : [singleServerChunk()]),
  ],
  resolve: {
    // The server build gets a stand-in for the module that loads localApi, so
    // localApi and pdfjs are never in its module graph. See loadLocalApi.ts.
    alias: isStatic
      ? []
      : [
          {
            find: /^\.\/loadLocalApi\.js$/,
            replacement: fileURLToPath(new URL('./src/loadLocalApi.server.ts', import.meta.url)),
          },
        ],
  },
  server: {
    port: Number(process.env.PORT) || 5273,
    strictPort: false,
    proxy: {
      '/api': { target: `http://localhost:${SERVER_PORT}`, changeOrigin: true },
      '/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true },
    },
  },
  build: {
    outDir: isStatic ? 'dist-static' : 'dist',
  },
});
