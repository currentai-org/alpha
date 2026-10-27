import { mkdirSync } from 'node:fs'
import { generateFonts } from 'fantasticon'

/** Builds the shared icon font from the unified (filled, single-path) icons in `svg/`. */
const common = {
  inputDir: './svg',
  name: 'aipotluck-icons',
  fontTypes: ['woff2'],
  assetTypes: ['css', 'json'],
}

const targets = [
  {
    outputDir: '../../payload/public/fonts/icons',
    fontsUrl: '/fonts/icons',
    pathOptions: {
      json: '../../payload/src/fields/components/IconSelect/icons.json',
      // Written under src/ (not public/) so custom.scss can @import it as a real relative
      // dependency — a root-relative `@import url('/fonts/...')` gets resolved as a module path
      // by the bundler and fails; the font's own `url()` inside @font-face is just a literal
      // string, unaffected either way.
      css: '../../payload/src/app/(payload)/icons.generated.css',
    },
  },
  {
    outputDir: '../../web/static/fonts/icons',
    fontsUrl: '/fonts/icons',
    pathOptions: {
      json: '../../web/src/lib/icons/icons.json',
      css: '../../web/src/lib/icons/icons.generated.css',
    },
  },
]

for (const target of targets) {
  mkdirSync(target.outputDir, { recursive: true })
  const results = await generateFonts({ ...common, ...target })
  console.log(`[${target.outputDir}] codepoints:`, results.codepoints)
  console.log(
    `[${target.outputDir}] writeResults:`,
    results.writeResults.map((r) => r.writePath),
  )
}
