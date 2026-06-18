/**
 * @dotrino/nav/vue
 *
 * Helper opcional para apps Vue 3: sincroniza un ref booleano de "modal abierto"
 * con la pila de back del controlador, sin cablear open()/close() a mano.
 *
 * Cuando el ref pasa a true → empuja una capa (history) cuyo cierre pone el ref
 * en false. Cuando el ref vuelve a false por CUALQUIER vía (botón X, backdrop,
 * o el propio volver) → la capa se retira de forma consistente. Así el botón de
 * volver de Android/iOS/navegador cierra el modal en lugar de salir de la app.
 *
 *   import { useBackLayer } from '@dotrino/nav/vue'
 *   const showNotifs = ref(false)
 *   useBackLayer(showNotifs)
 *
 * Para pestañas/vistas (volver a la anterior en vez de cerrar), usa el
 * controlador directamente: nav.open(() => goToPrevTab()).
 */

import { watch, onScopeDispose } from 'vue'
import { getBackNav } from './index.js'

/**
 * @param {import('vue').Ref} openRef  ref que controla el modal (booleano u
 *                                     objeto|null; se observa su veracidad).
 * @param {object}   [opts]
 * @param {Function} [opts.onClose]  Cómo cerrar (default: openRef.value = false).
 * @param {object}   [opts.nav]      Controlador a usar (default: el activo).
 * @param {string|Function} [opts.url]  Routing real (opcional): URL/path a
 *                   reflejar mientras la capa esté abierta (p. ej. '/que-es'
 *                   para una vista/pestaña enlazable). String o función que lo
 *                   devuelva (se evalúa al abrir). Al cerrar, el navegador
 *                   restaura la URL anterior. Sin `url` = modal clásico.
 *
 * No crea un controlador si no hay ninguno instalado (p. ej. en un iframe
 * embebido donde no se llamó createBackNav): en ese caso es un no-op seguro.
 */
export function useBackLayer (openRef, opts = {}) {
  const nav = opts.nav || getBackNav()
  if (!nav) return { nav: null }
  const onClose = opts.onClose || (() => { openRef.value = false })
  let handle = null

  const stop = watch(openRef, (open) => {
    if (open && !handle) {
      const url = typeof opts.url === 'function' ? opts.url() : opts.url
      handle = nav.open(onClose, { url })
    } else if (!open && handle) {
      // Cerrado por la app (X / backdrop): retira la capa de history.
      // Si fue el botón físico de volver, la capa ya no está activa y close()
      // es un no-op seguro.
      handle.close()
      handle = null
    }
  }, { flush: 'post' })

  onScopeDispose(() => {
    stop()
    if (handle) { handle.close(); handle = null }
  })

  return { nav }
}
