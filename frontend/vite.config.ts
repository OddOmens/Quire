import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

import { launchScreensPlugin } from './launch-screens.ts'

// Every Lucide icon, loadable by name without putting them in the main bundle
// (space icons can be any of them):
//   virtual:lucide-icons        every icon once, as "name alias alias…", for the picker
//   virtual:lucide-icon-loaders name or alias → () => import() of that icon
//   virtual:lucide-icon/<name>  one icon's drawing data, a chunk of its own
// The per-icon modules hold only data, rendered with lucide-react's <Icon>.
// Lazy-importing lucide-react's own icon modules instead would split every
// icon the app already imports statically into a chunk of its own too.
function lucideIcons(): Plugin {
  const dir = path.resolve(__dirname, 'node_modules/lucide-react/dist/esm')
  const listFile = path.join(dir, 'dynamicIconImports.mjs')
  const listId = 'virtual:lucide-icons'
  const loadersId = 'virtual:lucide-icon-loaders'
  const iconPrefix = 'virtual:lucide-icon/'
  let cache: Map<string, string[]> | undefined

  // icon name → its aliases, from lucide-react's own name → module map.
  const icons = () => {
    if (cache) return cache
    const found = new Map<string, string[]>()
    for (const [, name, target] of readFileSync(listFile, 'utf8').matchAll(/"([a-z0-9-]+)": \(\) => import\('\.\/icons\/([a-z0-9-]+)\.mjs'\)/g)) {
      const aliases = found.get(target) ?? []
      if (name !== target) aliases.push(name)
      found.set(target, aliases)
    }
    if (found.size < 1000) throw new Error(`lucide-icons: only found ${found.size} icons in ${listFile}`)
    return (cache = found)
  }

  return {
    name: 'quire:lucide-icons',
    resolveId(source) {
      if (source === listId || source === loadersId) return '\0' + source
      if (source.startsWith(iconPrefix) && icons().has(source.slice(iconPrefix.length))) return '\0' + source
      return null
    },
    async load(id) {
      if (!id.startsWith('\0')) return null
      id = id.slice(1)
      if (id === listId || id === loadersId) {
        this.addWatchFile(listFile)
        const sorted = [...icons()].sort(([a], [b]) => a.localeCompare(b))
        if (id === listId) return `export default ${JSON.stringify(sorted.map(([name, aliases]) => [name, ...aliases].join(' ')))}`
        const lines = sorted.map(([name]) => `${JSON.stringify(name)}: () => import(${JSON.stringify(iconPrefix + name)})`)
        const aliases = sorted.flatMap(([name, aliases]) => aliases.map((a) => [a, name]))
        return `const loaders = {\n${lines.join(',\n')}\n}\nfor (const [alias, name] of ${JSON.stringify(aliases)}) loaders[alias] = loaders[name]\nexport default loaders`
      }
      if (id.startsWith(iconPrefix)) {
        const file = path.join(dir, 'icons', id.slice(iconPrefix.length) + '.mjs')
        this.addWatchFile(file)
        const { __iconData: data } = await import(pathToFileURL(file).href)
        if (!data?.node) throw new Error(`lucide-icons: no icon data in ${file}`)
        return `export default ${JSON.stringify({ name: data.name, size: data.size, node: data.node })}`
      }
      return null
    },
  }
}

// offline-files.json: every file of the build a device needs to run every
// screen with no connection (src/lib/offline.ts fetches the ones it doesn't
// have yet). The ~2,000 one-icon chunks are left out; the icons in use are
// kept as they're shown.
function offlineFiles(): Plugin {
  return {
    name: 'quire:offline-files',
    apply: 'build',
    // Once the files are written: a chunk the build ends up dropping isn't listed.
    writeBundle(options, bundle) {
      const dir = options.dir ?? path.resolve(__dirname, 'dist')
      const files = Object.values(bundle)
        .filter((f) => !(f.type === 'chunk' && f.moduleIds.length > 0 && f.moduleIds.every((id) => id.includes('virtual:lucide-icon/'))))
        .map((f) => '/' + f.fileName)
        // Every browser that can run Quire reads .woff2: the older font formats aren't needed.
        .filter((f) => f.startsWith('/assets/') && !/\.(map|ttf|woff)$/.test(f) && existsSync(path.join(dir, f)))
        .sort()
      writeFileSync(path.join(dir, 'offline-files.json'), JSON.stringify(files))
    },
  }
}

// components/ui and the libraries under it, except the few that only one or
// two screens use (they load with those screens).
function uiPrimitive(id: string) {
  if (/[\\/]src[\\/]components[\\/]ui[\\/]/.test(id)) return !/[\\/](command|input-otp|select|context-menu|radio-group)\.tsx$/.test(id)
  if (/node_modules[\\/]@radix-ui[\\/]react-(select|context-menu|radio-group)[\\/]/.test(id)) return false
  return /node_modules[\\/](@radix-ui|radix-ui|@floating-ui|react-remove-scroll|react-remove-scroll-bar|react-style-singleton|use-sidecar|use-callback-ref|aria-hidden|class-variance-authority|cn)[\\/]/.test(id)
}

export default defineConfig({
  plugins: [react(), tailwindcss(), lucideIcons(), launchScreensPlugin(), offlineFiles()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // prosemirror-markdown builds its default *parser* when it's imported,
      // which drags in all of markdown-it. Quire only uses its serializer
      // (pages are parsed with marked), so the parser gets an empty stand-in.
      'markdown-it': path.resolve(__dirname, './src/lib/markdown-it-stub.ts'),
    },
  },
  server: {
    host: true,
    proxy: { '/api': process.env.QUIRE_API ?? 'http://localhost:8196' },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // The framework every screen needs. It changes far less often than
            // the app, so browsers keep it across updates.
            {
              name: 'react',
              test: /node_modules[\\/](react|react-dom|scheduler|react-router|@tanstack[\\/](query-core|react-query))[\\/]/,
              priority: 30,
            },
            // Icons imported by name, in one file rather than one request each.
            // (The icon picker's full set stays one tiny file per icon, above.)
            { name: 'icons', test: /node_modules[\\/]lucide-react[\\/]/, priority: 20 },
            // The UI primitives nearly every screen shares.
            { name: 'ui', test: uiPrimitive, priority: 10 },
          ],
        },
      },
    },
  },
})
