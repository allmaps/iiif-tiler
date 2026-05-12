<script lang="ts">
  import { zipSync } from 'fflate'
  import { onDestroy } from 'svelte'
  import vipsHeifWasmUrl from 'wasm-vips/vips-heif.wasm?url'
  import vipsJxlWasmUrl from 'wasm-vips/vips-jxl.wasm?url'
  import vipsWasmUrl from 'wasm-vips/vips.wasm?url'

  type Status =
    | 'idle'
    | 'loading-vips'
    | 'reading'
    | 'tiling'
    | 'done'
    | 'error'

  type TilePlan = {
    scaleFactor: number
    levelWidth: number
    levelHeight: number
    columns: number
    rows: number
  }

  type GeneratedTile = {
    path: string
    bytes: Uint8Array
  }

  type IiifTile = {
    xr: number
    yr: number
    wr: number
    hr: number
    ws: number
    hs: number
  }

  type TileSize = 256 | 512 | 1024
  type TileFormat = 'jpg' | 'webp'

  type VipsRuntime = {
    Image: {
      newFromBuffer(buffer: Uint8Array): VipsImage
    }
  }

  type VipsImage = {
    width: number
    height: number
    resize(scale: number, options?: Record<string, unknown>): VipsImage
    extractArea(
      left: number,
      top: number,
      width: number,
      height: number
    ): VipsImage
    jpegsaveBuffer(options?: Record<string, unknown>): Uint8Array
    webpsaveBuffer(options?: Record<string, unknown>): Uint8Array
  }

  const tileSizes: TileSize[] = [256, 512, 1024]

  let file: File | undefined = $state()
  let status = $state<Status>('idle')
  let progress = $state(0)
  let message = $state(
    'Drop an image to create a static IIIF Image API Level 0 pyramid.'
  )
  let previewUrl: string | undefined = $state()
  let zipUrl: string | undefined = $state()
  let zipName = $state('iiif-level0.zip')
  let sourceWidth = $state(0)
  let sourceHeight = $state(0)
  let tileCount = $state(0)
  let levelCount = $state(0)
  let outputSize = $state(0)
  let quality = $state(90)
  let tileSize = $state<TileSize>(512)
  let includeWebp = $state(false)
  let imageId = $state('')
  let errorMessage = $state('')

  let vipsPromise: Promise<VipsRuntime> | undefined

  const isBusy = $derived(
    status === 'loading-vips' || status === 'reading' || status === 'tiling'
  )
  const canGenerate = $derived(Boolean(file) && !isBusy)
  const canDownload = $derived(Boolean(zipUrl) && status === 'done')
  const progressLabel = $derived(`${Math.round(progress)}%`)

  function resetOutput() {
    if (zipUrl) {
      URL.revokeObjectURL(zipUrl)
    }

    zipUrl = undefined
    sourceWidth = 0
    sourceHeight = 0
    tileCount = 0
    levelCount = 0
    outputSize = 0
    progress = 0
    errorMessage = ''
  }

  async function getVips() {
    vipsPromise ??= import('wasm-vips').then(async ({ default: Vips }) =>
      Vips({
        locateFile: (path: string) => {
          if (path === 'vips.wasm') {
            return vipsWasmUrl
          }

          if (path === 'vips-heif.wasm') {
            return vipsHeifWasmUrl
          }

          if (path === 'vips-jxl.wasm') {
            return vipsJxlWasmUrl
          }

          return path
        }
      })
    )

    return vipsPromise
  }

  function preventDefaults(event: DragEvent) {
    event.preventDefault()
    event.stopPropagation()
  }

  function handleDrop(event: DragEvent) {
    preventDefaults(event)
    const dropped = event.dataTransfer?.files?.[0]

    if (dropped) {
      selectFile(dropped)
    }
  }

  function handlePick(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const picked = input.files?.[0]

    if (picked) {
      selectFile(picked)
    }
  }

  function selectFile(selectedFile: File) {
    if (!selectedFile.type.startsWith('image/')) {
      status = 'error'
      errorMessage =
        'Choose a JPG, PNG, WebP, TIFF, or another browser-readable image file.'
      return
    }

    file = selectedFile
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl)
    }
    previewUrl = URL.createObjectURL(selectedFile)
    resetOutput()
    status = 'idle'
    message =
      'Image loaded. Set an image ID, choose options, then generate the pyramid.'
  }

  onDestroy(() => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl)
    }

    if (zipUrl) {
      URL.revokeObjectURL(zipUrl)
    }
  })

  async function generatePyramid() {
    const selectedFile = file
    const serviceId = imageId.trim()
    const selectedIncludeWebp = includeWebp

    if (!selectedFile) {
      status = 'error'
      errorMessage =
        'Choose or drop an image before generating the tile pyramid.'
      return
    }

    if (!serviceId) {
      status = 'error'
      errorMessage = 'Set an image ID before creating the tile pyramid.'
      return
    }

    resetOutput()
    status = 'loading-vips'
    message = 'Loading libvips in WebAssembly...'

    try {
      const vips = await getVips()
      status = 'reading'
      message = 'Reading image metadata...'

      const buffer = new Uint8Array(await selectedFile.arrayBuffer())
      const image = vips.Image.newFromBuffer(buffer)
      sourceWidth = image.width
      sourceHeight = image.height

      status = 'tiling'
      message = 'Rendering tiles...'

      const result = await buildIiifZip(image, selectedFile.name, serviceId)
      const zipBuffer = new ArrayBuffer(result.byteLength)
      new Uint8Array(zipBuffer).set(result)
      const blob = new Blob([zipBuffer], { type: 'application/zip' })

      zipUrl = URL.createObjectURL(blob)
      zipName = `${fileStem(selectedFile.name)}-iiif-level0${selectedIncludeWebp ? '-webp' : ''}.zip`
      outputSize = blob.size
      progress = 100
      status = 'done'
      message = 'Tile pyramid is ready.'
    } catch (error) {
      status = 'error'
      errorMessage =
        error instanceof Error
          ? error.message
          : 'Could not create the tile pyramid.'
      message = 'Something went wrong while building the pyramid.'
    }
  }

  async function buildIiifZip(
    image: VipsImage,
    originalName: string,
    serviceId: string
  ) {
    const selectedTileSize = tileSize
    const selectedFormats: TileFormat[] = includeWebp
      ? ['jpg', 'webp']
      : ['jpg']
    const plans = createTilePlans(image.width, image.height, selectedTileSize)
    const scaleFactors = plans.map((plan) => plan.scaleFactor)

    const tiles: GeneratedTile[] = []
    const totalRegions = plans.reduce(
      (sum, plan) => sum + plan.columns * plan.rows,
      0
    )
    const totalTiles = totalRegions * selectedFormats.length
    let completedTiles = 0

    tileCount = totalTiles
    levelCount = plans.length

    for (const plan of plans) {
      for (let row = 0; row < plan.rows; row += 1) {
        for (let column = 0; column < plan.columns; column += 1) {
          const tileInfo = calculateIiifTile(
            image.width,
            image.height,
            plan.scaleFactor,
            selectedTileSize,
            selectedTileSize,
            column,
            row
          )
          const sourceRegion = image.extractArea(
            tileInfo.xr,
            tileInfo.yr,
            tileInfo.wr,
            tileInfo.hr
          )
          const tile =
            tileInfo.ws === tileInfo.wr && tileInfo.hs === tileInfo.hr
              ? sourceRegion
              : sourceRegion.resize(tileInfo.ws / tileInfo.wr, {
                  kernel: 'lanczos3',
                  vscale: tileInfo.hs / tileInfo.hr
                })
          const region = `${tileInfo.xr},${tileInfo.yr},${tileInfo.wr},${tileInfo.hr}`
          const size = `${tileInfo.ws},${tileInfo.hs}`

          for (const format of selectedFormats) {
            tiles.push({
              path: `${region}/${size}/0/default.${format}`,
              bytes: encodeTile(tile, format, quality)
            })

            completedTiles += 1
            progress = (completedTiles / totalTiles) * 95
          }

          await tickBrowser()
        }
      }
    }

    const info = {
      '@context': 'http://iiif.io/api/image/3/context.json',
      id: serviceId,
      type: 'ImageService3',
      protocol: 'http://iiif.io/api/image',
      profile: 'level0',
      width: image.width,
      height: image.height,
      extraFormats: selectedFormats.includes('webp') ? ['webp'] : [],
      preferredFormats: selectedFormats.includes('webp')
        ? ['webp', 'jpg']
        : ['jpg'],
      tiles: [
        {
          width: selectedTileSize,
          height: selectedTileSize,
          scaleFactors
        }
      ]
    }

    const files: Record<string, Uint8Array> = {
      'info.json': new TextEncoder().encode(
        `${JSON.stringify(info, null, 2)}\n`
      )
    }

    for (const tile of tiles) {
      files[tile.path] = tile.bytes
    }

    message = 'Packing ZIP file...'
    progress = 98

    return zipSync(files, { level: 0 })
  }

  function encodeTile(
    image: VipsImage,
    format: TileFormat,
    selectedQuality: number
  ) {
    if (format === 'webp') {
      return image.webpsaveBuffer({
        Q: selectedQuality
      })
    }

    return image.jpegsaveBuffer({
      Q: selectedQuality,
      optimize_coding: true,
      background: [255, 255, 255]
    })
  }

  function calculateIiifTile(
    width: number,
    height: number,
    scaleFactor: number,
    tileWidth: number,
    tileHeight: number,
    column: number,
    row: number
  ): IiifTile {
    const xr = column * tileWidth * scaleFactor
    const yr = row * tileHeight * scaleFactor
    const wr = Math.min(tileWidth * scaleFactor, width - xr)
    const hr = Math.min(tileHeight * scaleFactor, height - yr)
    const ws =
      xr + tileWidth * scaleFactor > width
        ? Math.floor((width - xr + scaleFactor - 1) / scaleFactor)
        : tileWidth
    const hs =
      yr + tileHeight * scaleFactor > height
        ? Math.floor((height - yr + scaleFactor - 1) / scaleFactor)
        : tileHeight

    return { xr, yr, wr, hr, ws, hs }
  }

  function createTilePlans(
    width: number,
    height: number,
    selectedTileSize: TileSize
  ): TilePlan[] {
    const plans: TilePlan[] = []
    let scaleFactor = 1

    while (true) {
      const levelWidth = Math.max(1, Math.ceil(width / scaleFactor))
      const levelHeight = Math.max(1, Math.ceil(height / scaleFactor))

      plans.push({
        scaleFactor,
        levelWidth,
        levelHeight,
        columns: Math.ceil(levelWidth / selectedTileSize),
        rows: Math.ceil(levelHeight / selectedTileSize)
      })

      if (levelWidth <= selectedTileSize && levelHeight <= selectedTileSize) {
        break
      }

      scaleFactor *= 2
    }

    return plans
  }

  function fileStem(name: string) {
    return (
      name
        .replace(/\.[^.]+$/, '')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase() || 'image'
    )
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  function downloadZip() {
    if (!zipUrl) return

    const link = document.createElement('a')
    link.href = zipUrl
    link.download = zipName
    link.click()
  }

  function tickBrowser() {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }
</script>

<svelte:head>
  <title>IIIF Level 0 Tiler</title>
  <meta
    name="description"
    content="Create a static IIIF Image API Level 0 tile pyramid from an image in the browser."
  />
  <link rel="canonical" href="https://iiif-tiler.allmaps.org/" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://iiif-tiler.allmaps.org/" />
  <meta property="og:site_name" content="IIIF Tiler" />
  <meta property="og:locale" content="en_US" />
  <meta property="og:title" content="IIIF Tiler" />
  <meta
    property="og:description"
    content="Create static IIIF Image API 3 Level 0 tile pyramids in your browser."
  />
  <meta property="og:image" content="/og-image.png" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta
    property="og:image:alt"
    content="IIIF Tiler logo and summary: create static Image API 3 Level 0 tile pyramids in your browser."
  />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:url" content="https://iiif-tiler.allmaps.org/" />
  <meta name="twitter:title" content="IIIF Tiler" />
  <meta
    name="twitter:description"
    content="Create static IIIF Image API 3 Level 0 tile pyramids in your browser."
  />
  <meta name="twitter:image" content="/og-image.png" />
  <meta
    name="twitter:image:alt"
    content="IIIF Tiler logo and summary: create static Image API 3 Level 0 tile pyramids in your browser."
  />
</svelte:head>

<main class="min-h-screen bg-stone-50 text-zinc-950">
  <section
    class="mx-auto grid min-h-screen w-full max-w-6xl gap-8 px-5 py-6 md:grid-cols-[1.05fr_0.95fr] md:items-center md:px-8 lg:px-10"
  >
    <div class="space-y-7">
      <div class="space-y-3">
        <p
          class="text-sm font-semibold tracking-wide text-emerald-700 uppercase"
        >
          Browser IIIF tiler
        </p>
        <h1 class="max-w-2xl text-4xl leading-tight font-semibold md:text-6xl">
          Drop an image. Download a Level 0 pyramid.
        </h1>
        <p class="max-w-xl text-base leading-7 text-zinc-700">
          Images are processed in the browser with
          <a
            class="font-medium text-emerald-800 underline decoration-emerald-800/30 underline-offset-4 hover:decoration-emerald-800"
            href="https://github.com/kleisauke/wasm-vips"
            rel="noreferrer"
            target="_blank">wasm-vips</a
          >. The ZIP contains an
          <a
            class="font-medium text-emerald-800 underline decoration-emerald-800/30 underline-offset-4 hover:decoration-emerald-800"
            href="https://iiif.io/api/image/3.0/"
            rel="noreferrer"
            target="_blank">Image API 3</a
          >
          <code>info.json</code> and pre-rendered JPG tiles, with optional
          <a
            href="https://caniuse.com/webp"
            rel="noreferrer"
            target="_blank"
            class="font-medium text-emerald-800 underline decoration-emerald-800/30 underline-offset-4 hover:decoration-emerald-800"
            >WebP</a
          > tiles.
        </p>
      </div>

      <label
        class="flex min-h-[330px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-zinc-300 bg-white px-6 py-8 text-center shadow-sm transition hover:border-emerald-600 hover:bg-emerald-50/40"
        class:cursor-wait={isBusy}
        for="image-input"
        ondragenter={preventDefaults}
        ondragover={preventDefaults}
        ondrop={handleDrop}
      >
        <input
          id="image-input"
          class="sr-only"
          type="file"
          accept="image/*"
          disabled={isBusy}
          onchange={handlePick}
        />

        {#if previewUrl}
          <img
            class="mb-5 h-44 w-full max-w-md rounded-md bg-zinc-100 object-contain"
            src={previewUrl}
            alt={file ? `Preview of ${file.name}` : 'Selected image preview'}
          />
        {:else}
          <span
            class="mb-5 grid h-16 w-16 place-items-center rounded-full bg-emerald-100 text-3xl text-emerald-800"
          >
            +
          </span>
        {/if}
        <span class="text-xl font-semibold"
          >{file?.name ?? 'Choose or drop an image'}</span
        >
        <span class="mt-2 max-w-sm text-sm leading-6 text-zinc-600">
          JPG, PNG, WebP, TIFF, and other libvips-readable formats can be turned
          into a downloadable pyramid.
        </span>
      </label>
    </div>

    <div class="space-y-4">
      <div class="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
        <label
          class="mb-2 block text-sm font-medium text-zinc-800"
          for="image-id"
        >
          Image ID
        </label>
        <input
          id="image-id"
          class="min-h-11 w-full rounded-md border border-zinc-300 px-3 text-sm transition outline-none placeholder:text-zinc-400 focus:border-emerald-700 focus:ring-2 focus:ring-emerald-700/20 disabled:bg-zinc-100"
          type="url"
          required
          disabled={isBusy}
          placeholder="https://example.org/iiif/my-image"
          bind:value={imageId}
        />
      </div>

      <div class="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
        <div class="mb-3 flex items-center justify-between gap-4">
          <p class="text-sm font-medium text-zinc-800">Tile size</p>
          <span class="text-sm text-zinc-600 tabular-nums">{tileSize}px</span>
        </div>
        <div class="grid grid-cols-3 gap-2">
          {#each tileSizes as size (size)}
            <button
              class="min-h-10 rounded-md border px-3 text-sm font-semibold transition disabled:cursor-not-allowed"
              class:cursor-pointer={!isBusy}
              class:border-emerald-700={tileSize === size}
              class:bg-emerald-700={tileSize === size}
              class:text-white={tileSize === size}
              class:border-zinc-300={tileSize !== size}
              class:bg-white={tileSize !== size}
              class:text-zinc-800={tileSize !== size}
              type="button"
              disabled={isBusy}
              onclick={() => {
                tileSize = size
                resetOutput()
                message = file
                  ? 'Tile size changed. Generate the pyramid again when ready.'
                  : 'Drop an image to create a static IIIF Image API Level 0 pyramid.'
              }}
            >
              {size}
            </button>
          {/each}
        </div>
      </div>

      <div class="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
        <div class="mb-3 flex items-center justify-between gap-4">
          <label class="text-sm font-medium text-zinc-800" for="quality"
            >Tile quality</label
          >
          <span class="text-sm text-zinc-600 tabular-nums">{quality}</span>
        </div>
        <input
          id="quality"
          class="w-full accent-emerald-700"
          type="range"
          min="50"
          max="100"
          step="1"
          disabled={isBusy}
          bind:value={quality}
        />
      </div>

      <div class="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-zinc-800">WebP tiles</p>
            <p class="mt-1 text-sm leading-6 text-zinc-600">
              Include WebP tiles alongside the default JPG tiles.
            </p>
          </div>
          <label
            class="relative inline-flex min-h-8 cursor-pointer items-center"
            class:cursor-not-allowed={isBusy}
          >
            <input
              class="peer sr-only"
              type="checkbox"
              disabled={isBusy}
              bind:checked={includeWebp}
              onchange={() => {
                resetOutput()
                message = file
                  ? 'Output format changed. Generate the pyramid again when ready.'
                  : 'Drop an image to create a static IIIF Image API Level 0 pyramid.'
              }}
            />
            <span
              class="h-7 w-12 rounded-full bg-zinc-300 transition peer-checked:bg-emerald-700 peer-disabled:opacity-50"
            ></span>
            <span
              class="absolute left-1 h-5 w-5 rounded-full bg-white shadow transition peer-checked:translate-x-5 peer-disabled:opacity-70"
            ></span>
          </label>
        </div>
      </div>

      <div class="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
        <div
          class="flex flex-col gap-3 border-b border-zinc-100 pb-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <p class="text-sm font-semibold text-zinc-950">Pyramid builder</p>
            <p class="mt-1 text-sm leading-6 text-zinc-600">
              {file
                ? `${file.name} is ready to process.`
                : 'Load an image to start.'}
            </p>
          </div>
          <div class="flex gap-2">
            <button
              class="inline-flex min-h-11 flex-1 items-center justify-center rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-45 sm:min-w-32"
              class:cursor-pointer={canGenerate}
              type="button"
              disabled={!canGenerate}
              onclick={generatePyramid}
            >
              Generate!
            </button>
            <button
              class="inline-flex min-h-11 flex-1 items-center justify-center rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-45 sm:min-w-32"
              class:cursor-pointer={canDownload}
              type="button"
              disabled={!canDownload}
              onclick={downloadZip}
            >
              Download ZIP
            </button>
          </div>
        </div>

        <div class="pt-4">
          <div class="mb-3 flex items-center justify-between gap-4">
            <div class="flex min-w-0 items-center gap-2">
              <span
                class="h-2.5 w-2.5 rounded-full"
                class:bg-emerald-600={status === 'done'}
                class:bg-red-600={status === 'error'}
                class:bg-sky-600={isBusy}
                class:bg-zinc-300={!isBusy &&
                  status !== 'done' &&
                  status !== 'error'}
              ></span>
              <p class="truncate text-sm font-medium text-zinc-800">
                {message}
              </p>
            </div>
            <span class="text-sm text-zinc-600 tabular-nums"
              >{progressLabel}</span
            >
          </div>
          <div class="h-3 overflow-hidden rounded-full bg-zinc-100">
            <div
              class="h-full rounded-full transition-[width]"
              class:bg-emerald-700={status !== 'error'}
              class:bg-red-600={status === 'error'}
              style:width={`${progress}%`}
            ></div>
          </div>
        </div>

        {#if errorMessage}
          <p
            class="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {errorMessage}
          </p>
        {/if}

        {#if sourceWidth && sourceHeight}
          <dl
            class="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md bg-zinc-200 text-sm sm:grid-cols-4"
          >
            <div class="bg-zinc-50 p-3">
              <dt class="text-zinc-500">Image</dt>
              <dd class="font-medium tabular-nums">
                {sourceWidth} x {sourceHeight}
              </dd>
            </div>
            <div class="bg-zinc-50 p-3">
              <dt class="text-zinc-500">Levels</dt>
              <dd class="font-medium tabular-nums">{levelCount}</dd>
            </div>
            <div class="bg-zinc-50 p-3">
              <dt class="text-zinc-500">Tiles</dt>
              <dd class="font-medium tabular-nums">{tileCount}</dd>
            </div>
            <div class="bg-zinc-50 p-3">
              <dt class="text-zinc-500">ZIP</dt>
              <dd class="font-medium tabular-nums">
                {outputSize ? formatBytes(outputSize) : '-'}
              </dd>
            </div>
          </dl>
        {/if}
      </div>
    </div>
  </section>
</main>
