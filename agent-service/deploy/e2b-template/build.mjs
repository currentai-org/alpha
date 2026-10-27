// Build the `hermes` template on our E2B install from ./Dockerfile (CUR-4482). Run on the E2B host, in the
// node-e2b image Embed ships, the way its own base-template service runs: build-on-host.sh does both.
import { Template } from 'e2b'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const alias = process.env.E2B_TEMPLATE_ALIAS || 'hermes'
if (!process.env.E2B_API_URL || !process.env.E2B_API_KEY) {
  console.error('build-hermes-template: E2B_API_URL and E2B_API_KEY are required')
  process.exit(2)
}
const started = Date.now()
const template = Template({ fileContextPath: here }).fromDockerfile(readFileSync(`${here}/Dockerfile`, 'utf8'))
await Template.build(template, alias, {
  cpuCount: 2,
  // A running sandbox reserves its whole guest memory from the host's hugepage pool (CUR-4496), so this size
  // divides the pool. An agent turn peaked under the 985 MB the bwrap machine had (api/app.py, _rlimit_prefix).
  memoryMB: 1024,
  onBuildLogs: (entry) => console.log(String(entry)),
})
console.log(`build-hermes-template: ${alias} ready in ${Math.round((Date.now() - started) / 1000)}s`)
