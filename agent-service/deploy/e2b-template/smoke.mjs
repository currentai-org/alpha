// After a build: one sandbox from the template proves Hermes and the run-code libraries are there and the guest
// env holds nothing of ours (CUR-4482). The sandbox is killed whatever happens.
import { Sandbox } from 'e2b'

const alias = process.env.E2B_TEMPLATE_ALIAS || 'hermes'
const sbx = await Sandbox.create(alias, { timeoutMs: 120_000, network: { denyOut: ['0.0.0.0/0'] } })
try {
  const run = async (cmd) => {
    const r = await sbx.commands.run(cmd, { timeoutMs: 60_000 })
    console.log(`$ ${cmd}\n${r.stdout.trim()}`)
    return r
  }
  await run('hermes --version')
  await run('hermes acp --check && echo acp-ok')
  // Every library in guest-libraries.txt: a template missing one, or one whose wheel installs but fails to import,
  // fails its build here, not a person's task.
  await run('python3 -c "import numpy, pandas, matplotlib, openpyxl, docx, reportlab, pptx, pypdf, xlsxwriter, scipy, sklearn, skimage, seaborn, plotly, bokeh, cv2, sympy, statsmodels, networkx, bs4, lxml, PIL, spacy, nltk, librosa, xarray, aiohttp, imageio, joblib, numba, pytest, pytz, requests, soundfile, textblob, urllib3, xlrd, tabulate; print(numpy.__version__)"')
  const env = await run('env | cut -d= -f1 | sort | tr "\\n" " "')
  const bad = env.stdout.split(/\s+/).filter((k) => /(TOKEN|SECRET|PASSWORD|API_KEY|ADMIN)/.test(k))
  if (bad.length) throw new Error(`guest env names a credential: ${bad.join(', ')}`)
  console.log('smoke: ok')
} finally {
  await sbx.kill()
}
