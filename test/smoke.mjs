import { chromium } from '../../dotrino-store/node_modules/playwright/index.mjs'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'

const pkgRoot = fileURLToPath(new URL('..', import.meta.url))

const html = `<!doctype html><html lang="es"><body>
<dotrino-back id="chev"></dotrino-back>
<script type="module">
  import { createBackNav, getBackNav } from '/src/index.js'
  window.calls = []
  window._handles = {}
  // home en el mismo server para poder afirmar la navegación de fallback.
  const nav = createBackNav({ home: location.origin + '/home.html' })
  window.nav = nav
  window.getBackNav = getBackNav
  window.openLayer = (name) => { window._handles[name] = nav.open(() => window.calls.push(name)) }
  window.openLayerUrl = (name, url) => { window._handles[name] = nav.open(() => window.calls.push(name), { url }) }
  window.closeLayer = (name) => { window._handles[name].close() }
  window.cancelOnce = () => document.addEventListener('cc-back', (e) => e.preventDefault(), { once: true })
</script>
</body></html>`

const server = createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.setHeader('content-type', 'text/html')
    return res.end(html)
  }
  if (req.url === '/home.html') {
    res.setHeader('content-type', 'text/html')
    return res.end('<!doctype html><title>home</title><body>HOME</body>')
  }
  try {
    const body = await readFile(pkgRoot + req.url.replace(/^\//, ''))
    res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
    res.end(body)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
})
await new Promise((r) => server.listen(0, r))
const baseUrl = `http://localhost:${server.address().port}/`

const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(baseUrl, { waitUntil: 'networkidle' })
await page.waitForFunction(
  () => customElements.get('dotrino-back') && document.querySelector('#chev')?.shadowRoot?.querySelector('button') && window.nav,
  null,
  { timeout: 5000 },
)

const back = async () => { await page.evaluate(() => history.back()); await page.waitForTimeout(60) }
const results = {}

// 1. custom element registrado + aria-label en español (auto desde <html lang="es">)
results.defined = await page.evaluate(() => !!customElements.get('dotrino-back'))
results.chevLabel = await page.evaluate(() =>
  document.querySelector('#chev').shadowRoot.querySelector('button').getAttribute('aria-label'),
)
results.singletonLinked = await page.evaluate(() => window.getBackNav() === window.nav)

// 2. abrir una capa la pone en la pila; el botón físico de volver la cierra
//    (llama onClose) y NO sale de la app.
await page.evaluate(() => window.openLayer('a'))
results.sizeAfterOpen = await page.evaluate(() => window.nav.size())
await back()
results.callsAfterBack = await page.evaluate(() => window.calls.slice())
results.sizeAfterBack = await page.evaluate(() => window.nav.size())
results.stillOnApp = page.url() === baseUrl

// 3. dos capas: el volver las cierra en orden LIFO
await page.evaluate(() => { window.calls = []; window.openLayer('a'); window.openLayer('b') })
results.sizeTwo = await page.evaluate(() => window.nav.size())
await back()
await back()
results.lifoOrder = await page.evaluate(() => window.calls.slice())
results.sizeAfterTwoBacks = await page.evaluate(() => window.nav.size())

// 4. cierre programático (handle.close()): saca la capa + su entrada de history
//    sin disparar un cierre extra; tras él, el volver real va a home.
await page.evaluate(() => { window.calls = []; window.openLayer('x') })
await page.evaluate(() => window.closeLayer('x'))
await page.waitForTimeout(60)
results.closeCalls = await page.evaluate(() => window.calls.slice())
results.sizeAfterClose = await page.evaluate(() => window.nav.size())
results.stillOnAppAfterClose = page.url() === baseUrl

// 5. el chevron es cancelable: si una app hace preventDefault, no vuelve
await page.evaluate(() => { window.calls = []; window.openLayer('c'); window.cancelOnce() })
await page.evaluate(() => document.querySelector('#chev').shadowRoot.querySelector('button').click())
await page.waitForTimeout(60)
results.cancelKeptLayer = await page.evaluate(() => window.nav.size())   // sigue en 1

// 6. el chevron (sin cancelar) cierra la capa igual que el botón físico
await page.evaluate(() => document.querySelector('#chev').shadowRoot.querySelector('button').click())
await page.waitForTimeout(60)
results.chevClosedLayer = await page.evaluate(() => window.nav.size())   // baja a 0
results.chevCalls = await page.evaluate(() => window.calls.slice())

// 6b. routing real: abrir una capa con { url } refleja esa URL en la barra;
//     el volver la cierra Y restaura la URL anterior automáticamente.
await page.evaluate(() => { window.calls = []; window.openLayerUrl('r', '/que-es') })
await page.waitForTimeout(40)
results.routeUrlOpen = await page.evaluate(() => location.pathname)
await back()
results.routeUrlBackCalls = await page.evaluate(() => window.calls.slice())
results.routeUrlRestored = page.url() === baseUrl
results.routeUrlSize = await page.evaluate(() => window.nav.size())

// 7. sin capas y sin página anterior (referrer vacío) → el volver navega a home
await back()
await page.waitForTimeout(120)
results.wentHome = page.url().endsWith('/home.html')

await browser.close()
server.close()

const expect = {
  defined: true,
  chevLabel: 'Volver',
  singletonLinked: true,
  sizeAfterOpen: 1,
  callsAfterBack: ['a'],
  sizeAfterBack: 0,
  stillOnApp: true,
  sizeTwo: 2,
  lifoOrder: ['b', 'a'],
  sizeAfterTwoBacks: 0,
  closeCalls: ['x'],
  sizeAfterClose: 0,
  stillOnAppAfterClose: true,
  cancelKeptLayer: 1,
  chevClosedLayer: 0,
  chevCalls: ['c'],
  routeUrlOpen: '/que-es',
  routeUrlBackCalls: ['r'],
  routeUrlRestored: true,
  routeUrlSize: 0,
  wentHome: true,
}

let ok = true
for (const [k, v] of Object.entries(expect)) {
  const got = JSON.stringify(results[k])
  const want = JSON.stringify(v)
  const pass = got === want
  if (!pass) ok = false
  console.log(`${pass ? '✓' : '✗'} ${k}: ${got}${pass ? '' : ` (esperado ${want})`}`)
}
if (errors.length) {
  ok = false
  console.log('Errores de página:', errors)
}
console.log(ok ? '\nTODOS LOS TESTS PASARON' : '\nFALLARON TESTS')
process.exit(ok ? 0 : 1)
