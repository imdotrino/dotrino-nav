/**
 * @dotrino/nav
 *
 * Navegación "volver" unificada y reutilizable por CUALQUIER app del ecosistema
 * Dotrino (Vue o vanilla). Resuelve el problema de que en iOS/PWA no hay
 * forma de volver a dotrino.com, y unifica el botón físico de Android / el
 * gesto de volver de iOS / el botón atrás del navegador con un chevron de UI.
 *
 * Dos piezas:
 *
 *  1. createBackNav() — un controlador JS con una PILA de "capas" (modales,
 *     vistas/pestañas) que intercepta `popstate` (que es lo que dispara el
 *     botón físico de Android, el gesto de volver de iOS y el botón atrás del
 *     navegador) mediante el truco del centinela de history. La cascada al
 *     volver es SIEMPRE la misma en todas las apps:
 *
 *        modal abierto  →  ciérralo
 *        historial de pestañas/vistas  →  vuelve a la anterior
 *        página anterior en ESTA pestaña  →  vuelve a ella
 *        sin página anterior (pestaña nueva target="_blank" / PWA standalone)
 *              →  cierra la pestaña si el navegador lo permite (vuelve a la
 *                 pestaña de origen), o va a dotrino.com
 *
 *  2. <dotrino-back> — un Web Component (custom element, Shadow DOM, sin
 *     JS de terceros) con el chevron de volver para poner arriba a la izquierda
 *     del header de cualquier app. Al hacer click hace lo mismo que el botón
 *     físico de volver (history.back()), así que comparte el código del punto 1.
 *
 * Filosofía Dotrino: sin JS de terceros, sin cookies, autohosteado.
 *
 * Uso del controlador (vanilla o Vue):
 *   import { createBackNav } from '@dotrino/nav'
 *   const nav = createBackNav({ home: 'https://dotrino.com' })
 *   // al abrir un modal:
 *   const layer = nav.open(() => { cerrarModalEnElDOM() })
 *   // al cerrarlo desde su propio botón X / backdrop:
 *   layer.close()
 *   // navegación entre pestañas (deja "miga" para volver a la anterior):
 *   nav.open(() => { setTab(tabAnterior) })
 *
 * Uso del chevron (vanilla):
 *   import '@dotrino/nav'   // registra el custom element
 *   <dotrino-back></dotrino-back>
 *
 * Uso del chevron (Vue 3): el tag funciona tal cual tras importar el paquete.
 *   import '@dotrino/nav'
 *   <dotrino-back lang="es" />
 *
 * Helper Vue para sincronizar un ref de modal con la pila (sin cablear a mano):
 *   import { useBackLayer } from '@dotrino/nav/vue'
 *   useBackLayer(showModal)   // showModal es un ref(false)
 */

const HOME_DEFAULT = 'https://dotrino.com'

// Singleton: el Web Component <dotrino-back> y cualquier código que quiera
// "volver" programáticamente encuentran el controlador activo por aquí.
let _active = null

/** Devuelve el controlador de back activo (o null si no se creó ninguno). */
export function getBackNav () {
  return _active
}

/**
 * Crea (e instala) el controlador de navegación "volver".
 *
 * @param {object}  [opts]
 * @param {string}  [opts.home='https://dotrino.com']  A dónde ir cuando no hay
 *                  ni capas internas ni página anterior del navegador.
 * @param {boolean} [opts.trap=true]  Si intercepta el botón físico/gesto/atrás
 *                  del navegador vía history. Ponlo en false solo para tests.
 * @returns {{ open:Function, back:Function, size:Function, destroy:Function, home:string }}
 */
export function createBackNav (opts = {}) {
  const home = opts.home || HOME_DEFAULT
  const trap = opts.trap !== false

  /** @type {{ onClose: Function, depth: number }[]} pila LIFO de capas. */
  const layers = []
  // Traversals que disparamos nosotros (history.back() al cerrar una capa) y cuyo
  // popstate aún no llegó. Mientras haya uno en vuelo, abrir/cerrar se ENCOLA:
  // history.back() es asíncrono y un pushState en medio corrompe la pila (la capa
  // nueva queda "adelante" y el siguiente back sale de la app).
  let inflight = 0
  const queued = []

  // ¿Hay una página real anterior EN ESTA PESTAÑA a la que volver (req. 3), o hay
  // que cerrar la pestaña / ir a dotrino.com (req. 4)? Se mide el largo del
  // historial ANTES de empujar el centinela: una pestaña recién abierta (nueva
  // pestaña con target="_blank" / window.open, o PWA standalone) arranca su
  // historial en 1 → no hay adónde volver dentro de la pestaña.
  // Ojo: `document.referrer` NO sirve para esto — una pestaña abierta con
  // target="_blank" SÍ trae referrer (la página que la abrió), pero su historial
  // propio no tiene página anterior, así que `history.back()` sería un no-op y el
  // botón de volver "no haría nada" (el bug de la pestaña nueva).
  const hadPrev = (() => {
    try { return history.length > 1 } catch (_) { return false }
  })()

  // Pestaña sin página anterior propia (abierta con target="_blank"/window.open, o
  // PWA standalone). Al "volver": intentar CERRARLA —así se vuelve a la pestaña de
  // origen—, y si el navegador no lo permite (no la abrió un script, o el centinela
  // dejó más de una entrada), ir a `home` (dotrino.com). El orden respeta el pedido:
  // cerrar si se puede, o a dotrino.com.
  function goHomeOrClose () {
    try { window.close() } catch (_) {}
    // window.close() es best-effort y NO lanza si el navegador lo bloquea: si la
    // pestaña sigue viva tras un instante, salimos a `home`.
    setTimeout(() => { try { location.href = home } catch (_) {} }, 150)
  }

  function runClose (layer) {
    try {
      if (typeof layer.onClose === 'function') layer.onClose()
    } catch (e) {
      // Nunca dejes que el handler de una app rompa la navegación.
      try { console.error('[dotrino-nav] onClose error:', e) } catch (_) {}
    }
  }

  /** Profundidad que dice la entrada de history en la que estamos: 0 = centinela
   *  base, n = capa n, -1 = por debajo del centinela (fuera de lo nuestro). */
  function depthOf (state) {
    const v = state && state.ccNav
    if (v === 'base') return 0
    if (typeof v === 'number' && v > 0) return v
    return -1
  }

  /** Cierra (sin tocar history) todas las capas por encima de `depth`. */
  function closeAbove (depth) {
    while (layers.length > Math.max(0, depth)) runClose(layers.pop())
  }

  function onPop (ev) {
    const depth = depthOf(ev && ev.state)
    if (inflight > 0) {
      // Llegó el popstate de un back() nuestro. La pila ya se ajustó al cerrar; solo
      // se vacía la cola de lo que quedó esperando a que el historial se asentara.
      inflight--
      if (inflight === 0) { while (queued.length) queued.shift()() }
      return
    }
    if (depth >= 0) {
      // Seguimos dentro de lo nuestro: la entrada dice cuántas capas quedan vivas
      // (un gesto de volver = una capa; una traversal de varias entradas, las que
      // toque). Con estado y no contando eventos no hay manera de desfasarse.
      closeAbove(depth)
      return
    }
    // Entrada sin estado nuestro. Si la URL no es la del centinela, no es la página
    // de abajo: es una entrada que alguien empujó ENCIMA (un `location.hash = …` de
    // la app, por ejemplo). Se adopta como una capa más, transparente, para que el
    // historial siga casando con la pila y el siguiente volver no salga de la app.
    if (trap && baseHref && location.href !== baseHref) {
      const layer = { onClose: null, depth: layers.length + 1 }
      layers.push(layer)
      try { history.replaceState({ ccNav: layer.depth }, '') } catch (_) {}
      return
    }
    // Por debajo del centinela base: el usuario quiere SALIR. Decidimos req. 3 / 4.
    closeAbove(0)
    if (hadPrev) {
      // Hay página anterior real en esta pestaña: sal hacia ella.
      try { history.back() } catch (_) { goHomeOrClose() }
    } else {
      // Pestaña nueva (target="_blank") o standalone, sin página anterior propia:
      // cerrarla si se puede (volver a la pestaña de origen), o ir a dotrino.com.
      goHomeOrClose()
    }
  }

  // URL del centinela: sirve para distinguir "la página de abajo" (misma URL que
  // la nuestra) de una entrada ajena empujada encima (ver onPop).
  let baseHref = ''
  if (trap) {
    // Centinela base: una entrada extra para atrapar el PRIMER "volver" cuando
    // no hay capas, y así poder enrutar a dotrino.com en vez de quedar atrapado
    // (el bug de iOS). Misma URL → es una entrada same-document, no recarga.
    try { history.pushState({ ccNav: 'base' }, ''); baseHref = location.href } catch (_) {}
    window.addEventListener('popstate', onPop)
  }

  /** Ejecuta ya, o cuando se asiente el back() que está en vuelo. */
  function settled (fn) {
    if (trap && inflight > 0) queued.push(fn)
    else fn()
  }

  /**
   * Empuja una capa (modal o vista/pestaña). Devuelve un handle con close().
   * @param {Function} onClose  Cómo cerrar esta capa (cerrar modal, volver a la
   *                            pestaña anterior, etc.). Se llama tanto si el
   *                            usuario pulsa volver como si llamas handle.close().
   * @param {object}   [opts]
   * @param {string}   [opts.url]  Routing real (opcional): URL/path a reflejar
   *                   mientras esta capa esté abierta (p. ej. '/que-es' para una
   *                   vista). Se escribe en la entrada de history de la capa, así
   *                   la vista es enlazable/indexable y compartible. Al cerrarla
   *                   (volver físico o handle.close()) el navegador restaura la
   *                   URL anterior automáticamente. Sin `url` se mantiene la URL
   *                   actual (comportamiento clásico de modal).
   */
  function open (onClose, opts = {}) {
    const layer = { onClose, depth: 0 }
    settled(() => {
      layer.depth = layers.length + 1
      layers.push(layer)
      if (trap) {
        // url='' (o ausente) = misma URL (entrada same-document para atrapar el
        // volver sin tocar la barra de direcciones). Con url → routing real.
        const url = opts.url == null ? '' : String(opts.url)
        try { history.pushState({ ccNav: layer.depth }, '', url) } catch (_) {}
      }
    })
    return {
      close () { settled(() => dismiss(layer)) },
      get active () { return layers.indexOf(layer) !== -1 }
    }
  }

  // Cierre programático de una capa (botón X del modal, backdrop, etc.).
  function dismiss (layer) {
    const idx = layers.indexOf(layer)
    if (idx === -1) return // ya estaba cerrada (p.ej. por el botón físico)
    // Se cierra esta y todo lo que tuviera encima (cerrar por debajo deja capas
    // huérfanas cuyas entradas de history ya no casan con nada).
    const above = layers.length - idx
    while (layers.length > idx) runClose(layers.pop())
    if (!trap) return
    // Solo se retiran entradas de history si de verdad ESTAMOS sobre la de la capa
    // de arriba. Si el historial está en otra parte (un back() ajeno, un hash que
    // cambió alguien), retirar a ciegas es lo que saca de la app.
    let cur = -1
    try { cur = depthOf(history.state) } catch (_) {}
    if (cur !== idx + above) return
    inflight++
    try { history.go(-above) } catch (_) { inflight-- }
  }

  /** Volver programático (lo usa el chevron): idéntico al botón físico. */
  function back () {
    if (trap) {
      try { history.back() } catch (_) { onPop({ state: null }) }
    } else {
      // Sin trampa (tests): simula el gesto sobre la pila, sin history.
      if (layers.length) runClose(layers.pop())
      else if (hadPrev) { try { history.back() } catch (_) { goHomeOrClose() } } else goHomeOrClose()
    }
  }

  function destroy () {
    if (trap) window.removeEventListener('popstate', onPop)
    if (_active === controller) _active = null
  }

  const controller = {
    open,
    back,
    home,
    size: () => layers.length,
    destroy
  }
  _active = controller
  return controller
}

/* ────────────────────────────────────────────────────────────────────────────
   Web Component: <dotrino-back>
   Chevron de volver para el header. Al hacer click se comporta EXACTAMENTE
   como el botón físico de volver (dispara el controlador / history.back()).
   ──────────────────────────────────────────────────────────────────────────── */

const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>'

const BACK_I18N = { es: 'Volver', en: 'Back' }

const BACK_STYLE = `
  :host {
    all: initial;
    display: inline-flex;
    vertical-align: middle;
    font-family: inherit;
  }
  :host([hidden]) { display: none; }
  /* Modo flotante para apps sin header donde anclar (canvas a pantalla completa). */
  :host([floating]) {
    position: fixed;
    top: max(10px, env(safe-area-inset-top, 0px));
    left: max(10px, env(safe-area-inset-left, 0px));
    z-index: 2147483000;
  }
  button {
    all: unset;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--cc-back-size, 38px);
    height: var(--cc-back-size, 38px);
    border-radius: var(--cc-back-radius, 12px);
    color: var(--cc-back-color, currentColor);
    background: var(--cc-back-bg, transparent);
    cursor: pointer;
    transition: background .15s ease, transform .1s ease, opacity .15s ease;
    -webkit-tap-highlight-color: transparent;
  }
  button:hover { background: var(--cc-back-bg-hover, rgba(127,127,127,.16)); }
  button:active { transform: translateX(-1px) scale(.94); }
  button:focus-visible { outline: 2px solid var(--cc-back-focus, currentColor); outline-offset: 2px; }
  svg { width: var(--cc-back-icon, 22px); height: var(--cc-back-icon, 22px); display: block; }
`

class DotrinoBack extends HTMLElement {
  static get observedAttributes () { return ['lang', 'label'] }

  constructor () {
    super()
    this.attachShadow({ mode: 'open' })
    this._onClick = this._onClick.bind(this)
  }

  connectedCallback () {
    this._render()
  }

  attributeChangedCallback () {
    if (this.shadowRoot) this._render()
  }

  _resolveLang () {
    const a = (this.getAttribute('lang') || '').toLowerCase()
    if (a === 'es' || a === 'en') return a
    let doc = 'es'
    try { doc = (document.documentElement.lang || navigator.language || 'es').slice(0, 2) } catch (_) {}
    return doc === 'en' ? 'en' : 'es'
  }

  _render () {
    const lang = this._resolveLang()
    const label = this.getAttribute('label') || BACK_I18N[lang]
    this.shadowRoot.innerHTML = `<style>${BACK_STYLE}</style>` +
      `<button type="button" part="button" aria-label="${label}" title="${label}">${CHEVRON}</button>`
    this.shadowRoot.querySelector('button').addEventListener('click', this._onClick)
  }

  _onClick () {
    // Evento cancelable: una app puede prevenirlo para hacer algo propio.
    const ev = new CustomEvent('cc-back', { bubbles: true, composed: true, cancelable: true })
    const proceed = this.dispatchEvent(ev)
    if (!proceed) return

    const nav = getBackNav()
    if (nav) { nav.back(); return }

    // Sin controlador instalado: fallback defensivo razonable.
    const home = this.getAttribute('home') || HOME_DEFAULT
    if (window.history.length > 1) {
      try { window.history.back(); return } catch (_) {}
    }
    window.location.href = home
  }

  /** Volver programático desde JS de la app. */
  back () { this._onClick() }
}

if (typeof customElements !== 'undefined' && !customElements.get('dotrino-back')) {
  customElements.define('dotrino-back', DotrinoBack)
}

export { DotrinoBack }
