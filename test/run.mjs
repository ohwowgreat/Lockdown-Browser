// Runs every test file in sequence and fails if any of them fails. The browser
// suite needs a fresh production build, so that is made first.
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ROOT } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const files = ['http.test.mjs', 'socket.test.mjs', 'e2e.test.mjs']
const failed = []

for (const f of files) {
  if (f === 'e2e.test.mjs') {
    console.log('\n== build (for browser tests) ==')
    const b = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: ROOT, stdio: 'inherit' })
    if (b.status !== 0) { failed.push('build'); break }
  }
  console.log(`\n== ${f} ==`)
  const r = spawnSync(process.execPath, [path.join(here, f)], { cwd: ROOT, stdio: 'inherit' })
  if (r.status !== 0) failed.push(f)
}

console.log(failed.length ? `\n${failed.length} failed: ${failed.join(', ')}` : '\nAll test files passed')
process.exit(failed.length ? 1 : 0)
