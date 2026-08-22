import { chromium } from '../../dotrino-store/node_modules/playwright/index.mjs'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'

const pkgRoot = fileURLToPath(new URL('..', import.meta.url))

const html = `<!doctype html><html lang="es"><body>
<dotrino-back id="chev"></dotrino-back>
<script type="module">
  import { createBackNav, getBackNav } from '/src/index.js'
  // Lo que ve hadPrev: el largo del historial ANTES del centinela. Despues ya
  // no se puede distinguir "pestana nueva" de "pestana con pagina anterior".
  window.lenPrevio = history.length
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
// Esta pestaña SÍ tiene página anterior (`about:blank`, la inicial de Playwright):
// el paso 7 depende de eso, así que se deja afirmado y no supuesto.
results.conPaginaAnterior = await page.evaluate(() => window.lenPrevio)

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

// 6c. CARRERAS con history.back() (asíncrono). Visto en eco (2026-08-22): abrir un
//     enlace en una pestaña con historial rebotaba a la página anterior. El
//     controlador ya no cuenta popstates: lee `history.state` y encola lo que llega
//     mientras un back() nuestro está en vuelo. Cada secuencia termina en la app,
//     con la pila vacía y el historial en el centinela base.
const seq = async (name, fn) => {
  await page.evaluate(() => { window.calls = [] })
  await page.evaluate(fn)
  await page.waitForTimeout(250)
  results['race_' + name] = [page.url() === baseUrl, await page.evaluate(() => window.nav.size()), await page.evaluate(() => history.state && history.state.ccNav)]
}
await seq('closeThenOpen', () => { window.openLayer('a') })
await page.waitForTimeout(40)
await page.evaluate(() => { window.closeLayer('a'); window.openLayer('b') })
await page.waitForTimeout(60)
await page.evaluate(() => window.closeLayer('b'))
await page.waitForTimeout(250)
results.race_closeThenOpen = [page.url() === baseUrl, await page.evaluate(() => window.nav.size()), await page.evaluate(() => history.state && history.state.ccNav)]
await seq('oneTick', () => { window.openLayer('a'); window.closeLayer('a'); window.openLayer('b'); window.closeLayer('b') })
await seq('closeLowerFirst', () => { window.openLayer('a'); window.openLayer('b'); window.closeLayer('a') })
//     Un popstate de varias entradas (history.go(-2)) cierra las dos capas de golpe.
await page.evaluate(() => { window.calls = []; window.openLayer('a'); window.openLayer('b') })
await page.waitForTimeout(40)
await page.evaluate(() => history.go(-2))
await page.waitForTimeout(250)
results.race_go2 = [page.url() === baseUrl, await page.evaluate(() => window.nav.size()), await page.evaluate(() => window.calls.slice())]
//     Si alguien ajeno movió el historial (un hash), cerrar la capa NO retira
//     entradas a ciegas: la app no se va.
await page.evaluate(() => { window.openLayer('a') })
await page.waitForTimeout(40)
await page.evaluate(() => { location.hash = '#otra' })
await page.waitForTimeout(60)
await page.evaluate(() => window.closeLayer('a'))
await page.waitForTimeout(250)
results.race_foreignHash = [page.url() === baseUrl, await page.evaluate(() => window.nav.size()), await page.evaluate(() => history.state && history.state.ccNav)]

// 7. Pestaña SIN página anterior propia (abierta con window.open / target=_blank,
//    o PWA standalone): history.length === 1 y no hay adónde volver DENTRO de la
//    pestaña. El pedido es "cerrarla si se puede, o ir a dotrino.com".
//
//    Esta condición hay que montarla a propósito, y ahí estaba el fallo: una
//    pestaña abierta con `page.goto()` arranca en `about:blank`, así que su
//    `history.length` ya es 2 cuando carga la app → `hadPrev` es true. El test
//    afirmaba `wentHome: true` sobre esa pestaña y fallaba siempre, porque pedía
//    el camino de "pestaña nueva" en una que sí tenía página anterior. Con
//    `window.open()` la pestaña arranca directamente en la app: history.length 1.
const ctx = page.context()
const abrirEnPestanaNueva = async (prep) => {
  const [nueva] = await Promise.all([
    ctx.waitForEvent('page'),
    page.evaluate((u) => window.open(u, '_blank'), baseUrl),
  ])
  await nueva.waitForLoadState()
  if (prep) await nueva.evaluate(prep)
  await nueva.waitForFunction(() => window.nav, null, { timeout: 5000 })
  return nueva
}

//    7a. La abrió un script, así que window.close() SÍ funciona: al volver se
//        cierra, y el usuario aterriza en la pestaña de origen.
const pestanaNueva = await abrirEnPestanaNueva(null)
results.sinPaginaAnterior = await pestanaNueva.evaluate(() => window.lenPrevio)   // 1
await pestanaNueva.evaluate(() => history.back()).catch(() => {})
await page.waitForTimeout(400)
results.pestanaCerrada = pestanaNueva.isClosed()

//    7b. Mismo caso con window.close() bloqueado: es best-effort y el navegador
//        puede negarse SIN lanzar, así que entra el fallback a `home`. Sin este
//        caso, la rama que de verdad lleva a dotrino.com no la prueba nadie.
const pestanaBloqueada = await abrirEnPestanaNueva(() => { window.close = () => {} })
await pestanaBloqueada.evaluate(() => history.back())
await pestanaBloqueada.waitForURL(/\/home\.html$/, { timeout: 5000 }).catch(() => {})
results.wentHome = pestanaBloqueada.url().endsWith('/home.html')
await pestanaBloqueada.close()

// 8. Sin capas y CON página anterior en esta pestaña (es el caso de `page`, ver
//    arriba): el volver sale de la app hacia ella, ni se queda atrapado ni se va
//    a `home`. Va el último porque abandona la página.
await back()
await page.waitForTimeout(200)
results.saleDeLaApp = page.url() !== baseUrl

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
  conPaginaAnterior: 2,
  sinPaginaAnterior: 1,
  pestanaCerrada: true,
  wentHome: true,
  saleDeLaApp: true,
  race_closeThenOpen: [true, 0, 'base'],
  race_oneTick: [true, 0, 'base'],
  race_closeLowerFirst: [true, 0, 'base'],
  race_go2: [true, 0, ['b', 'a']],
  race_foreignHash: [true, 0, 'base'],
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
