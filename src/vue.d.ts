import type { Ref } from 'vue'
import type { BackLayerHandle, BackNavController } from './index'

export interface UseBackLayerOptions {
  /** Cómo cerrar la capa (default: `openRef.value = false`). */
  onClose?: () => void
  /** Controlador a usar (default: el activo, `getBackNav()`). */
  nav?: BackNavController | null
  /**
   * Routing real (opcional): URL/path a reflejar mientras la capa esté abierta.
   * String o función que lo devuelva (se evalúa al abrir). Sin `url` = modal
   * clásico (no toca la barra de direcciones).
   */
  url?: string | (() => string)
}

/**
 * Sincroniza un ref booleano (u objeto|null, se observa su veracidad) de "modal
 * abierto" con la pila de back del controlador. Devuelve `{ nav }` (o
 * `{ nav: null }` si no hay controlador instalado: no-op seguro).
 */
export function useBackLayer (
  openRef: Ref<unknown>,
  opts?: UseBackLayerOptions
): { nav: BackNavController | null }
