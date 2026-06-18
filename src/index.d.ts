export interface BackNavOptions {
  /** A dónde ir cuando no hay capas internas ni página anterior. Default dotrino.com. */
  home?: string
  /** Interceptar el botón físico/gesto/atrás del navegador vía history. Default true. */
  trap?: boolean
}

export interface BackLayerHandle {
  /** Cierra esta capa programáticamente (botón X, backdrop…). */
  close(): void
  /** true mientras la capa siga en la pila. */
  readonly active: boolean
}

export interface BackLayerOptions {
  /**
   * Routing real (opcional): URL/path a reflejar mientras la capa esté abierta
   * (p. ej. '/que-es' para una vista/pestaña enlazable e indexable). Al cerrar
   * la capa el navegador restaura la URL anterior. Sin `url` = modal clásico
   * (no cambia la barra de direcciones).
   */
  url?: string
}

export interface BackNavController {
  /** Empuja una capa (modal o vista/pestaña); onClose define cómo cerrarla. */
  open(onClose: () => void, opts?: BackLayerOptions): BackLayerHandle
  /** Volver programático (idéntico al botón físico de volver). */
  back(): void
  /** Número de capas actualmente en la pila. */
  size(): number
  /** Destino de fallback (dotrino.com por defecto). */
  readonly home: string
  /** Quita el listener de history y libera el singleton. */
  destroy(): void
}

/** Crea (e instala como singleton) el controlador de navegación "volver". */
export function createBackNav(opts?: BackNavOptions): BackNavController

/** Devuelve el controlador activo, o null si no se creó ninguno. */
export function getBackNav(): BackNavController | null

/** Custom element del chevron de volver (`<dotrino-back>`). */
export class DotrinoBack extends HTMLElement {
  back(): void
}

declare global {
  interface HTMLElementTagNameMap {
    'dotrino-back': DotrinoBack
  }
}
