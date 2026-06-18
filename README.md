# @dotrino/nav

Navegación **"volver"** unificada para todo el ecosistema [Dotrino](https://dotrino.com).

Resuelve un problema real: en iOS / PWA standalone no había forma de volver a
`dotrino.com`, y cada app inventaba (o no) su propio botón atrás. Este paquete
unifica el **botón físico de volver de Android**, el **gesto de volver de iOS** y
el **botón atrás del navegador** con un **chevron de UI**, y aplica la misma
cascada en todas las apps:

```
modal abierto            →  ciérralo
historial de pestañas    →  vuelve a la vista anterior
sin historial interno    →  página anterior del navegador
sin página anterior      →  dotrino.com
```

Sin JS de terceros, sin cookies, autohosteado (Shadow DOM). Funciona en apps
Vue y vanilla.

## Por qué un paquete y no copiar el código

El chevron es trivial; lo que **no** lo es —y por eso se centraliza— es la
lógica de `popstate`: el botón físico de Android/iOS en una PWA no dispara un
evento propio, sino `popstate`. Para interceptarlo hay que mantener un
**centinela de history** (`pushState` base + uno por capa) y contar entradas
para no salirse de la app antes de tiempo ni quedar atrapado. Reimplementado por
app, son 15 variantes con bugs sutiles distintos. Aquí está en un solo lugar y
testeado (`npm test`, Playwright).

## Dos piezas

### 1. Controlador `createBackNav()`

```js
import { createBackNav } from '@dotrino/nav'

const nav = createBackNav({ home: 'https://dotrino.com' }) // crea e instala el singleton

// Modal: empuja una capa; onClose define cómo cerrarlo.
const layer = nav.open(() => { mostrarModal.value = false })
// …y al cerrarlo desde su propio botón X / backdrop:
layer.close()

// Pestaña/vista: deja "miga" para volver a la anterior.
nav.open(() => setTab(tabAnterior))

// Routing real (opcional): refleja una URL/path enlazable mientras la capa
// esté abierta. Al cerrar (volver físico o layer.close()) el navegador
// restaura la URL anterior automáticamente.
const vista = nav.open(() => cerrarVista(), { url: '/que-es' })
```

API: `open(onClose, opts?) → { close(), active }` —con `opts.url` opcional para
**routing real** (URL enlazable/indexable por capa; sin `url` = modal clásico que
no toca la barra de direcciones)—, `back()` (volver programático, idéntico al
físico), `size()`, `home`, `destroy()`. `getBackNav()` devuelve el controlador
activo.

> Routing real en GitHub Pages: para que un deep-link a `/que-es` cargue, genera
> una página estática real (p. ej. copia `index.html` → `que-es.html`, que Pages
> sirve con 200) y, al arrancar, deriva la vista inicial de `location.pathname`.

### 2. Web Component `<dotrino-back>` (el chevron)

```html
<!-- vanilla -->
<script type="module" src=".../@dotrino/nav/src/index.js"></script>
<dotrino-back></dotrino-back>
```

```js
// Vue: importa el paquete una vez y usa el tag en el header.
import '@dotrino/nav'
```
```html
<header class="topbar">
  <dotrino-back lang="es" />
  <div class="brand">…</div>
</header>
```

Al hacer click hace lo mismo que el botón físico de volver. Atributos: `lang`
(`es`|`en`|auto), `label` (override), `floating` (posición fija arriba-izquierda
para apps sin header donde anclar), `home` (fallback si no hay controlador).
Emite el evento cancelable `cc-back`. Variables CSS: `--cc-back-size`,
`--cc-back-color`, `--cc-back-bg`, `--cc-back-radius`, `--cc-back-icon`, …

### Helper Vue (opcional)

Sincroniza un `ref` de modal con la pila sin cablear `open`/`close` a mano:

```js
import { useBackLayer } from '@dotrino/nav/vue'

const showNotifs = ref(false)
useBackLayer(showNotifs) // el volver cierra el modal en vez de salir de la app

// Con routing real: la vista pasa a tener URL propia enlazable/indexable.
const aboutOpen = ref(false)
useBackLayer(aboutOpen, { url: '/que-es' }) // string o función que lo devuelva
```

## Test

```
npm test   # smoke con Playwright: cascada popstate, LIFO, cierre programático, fallback a home
```
