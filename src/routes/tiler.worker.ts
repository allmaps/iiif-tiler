import { zipSync } from 'fflate'

type TilePlan = {
  scaleFactor: number
  levelWidth: number
  levelHeight: number
  columns: number
  rows: number
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

type WorkerRequest = {
  file: File
  serviceId: string
  tileSize: TileSize
  quality: number
  includeFullImage: boolean
  includeThumbnails: boolean
  includeWebp: boolean
  maxFullImageDimension: number
}

type WorkerResponse =
  | {
      type: 'metadata'
      width: number
      height: number
      tileCount: number
      levelCount: number
    }
  | {
      type: 'progress'
      progress: number
      message: string
    }
  | {
      type: 'done'
      zip: ArrayBuffer
    }
  | {
      type: 'error'
      message: string
    }

type GeneratedFile = {
  path: string
  bytes: Uint8Array
}

type Size = {
  width: number
  height: number
}

type WorkerScope = typeof self & {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: unknown, transfer: Transferable[]): void
}

const workerScope = self as WorkerScope

workerScope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    const result = await buildIiifZip(event.data)
    workerScope.postMessage({ type: 'done', zip: result }, [result])
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      message:
        error instanceof Error
          ? error.message
          : 'Could not create the tile pyramid.'
    } satisfies WorkerResponse)
  }
}

async function buildIiifZip(options: WorkerRequest) {
  postProgress(0, 'Decoding image...')

  const image = await createImageBitmap(options.file)
  const selectedFormats: TileFormat[] = options.includeWebp
    ? ['jpg', 'webp']
    : ['jpg']
  const plans = createTilePlans(image.width, image.height, options.tileSize)
  const scaleFactors = plans.map((plan) => plan.scaleFactor)
  const fullImageSize = calculateMaxFullImageSize(
    image.width,
    image.height,
    options.maxFullImageDimension
  )
  const fullImageIsLimited =
    fullImageSize.width !== image.width || fullImageSize.height !== image.height
  const thumbnailSizes = options.includeThumbnails
    ? calculateThumbnailSizes(image.width, image.height, fullImageSize)
    : []
  const availableSizes = [
    ...thumbnailSizes,
    ...(options.includeFullImage ? [fullImageSize] : [])
  ]
  const totalRegions = plans.reduce(
    (sum, plan) => sum + plan.columns * plan.rows,
    0
  )
  const fullImages = options.includeFullImage ? selectedFormats.length : 0
  const thumbnailImages = thumbnailSizes.length * selectedFormats.length
  const totalImages =
    totalRegions * selectedFormats.length + fullImages + thumbnailImages
  let completedImages = 0

  workerScope.postMessage({
    type: 'metadata',
    width: image.width,
    height: image.height,
    tileCount: totalImages,
    levelCount: plans.length
  } satisfies WorkerResponse)

  const generatedFiles: GeneratedFile[] = []

  if (options.includeThumbnails) {
    for (const thumbnailSize of thumbnailSizes) {
      for (const format of selectedFormats) {
        generatedFiles.push({
          path: `full/${thumbnailSize.width},${thumbnailSize.height}/0/default.${format}`,
          bytes: await encodeImage(
            image,
            {
              xr: 0,
              yr: 0,
              wr: image.width,
              hr: image.height,
              ws: thumbnailSize.width,
              hs: thumbnailSize.height
            },
            format,
            options.quality
          )
        })

        completedImages += 1
        postProgress(
          (completedImages / totalImages) * 95,
          'Rendering images...'
        )
      }
    }
  }

  if (options.includeFullImage) {
    for (const format of selectedFormats) {
      generatedFiles.push({
        path: `full/max/0/default.${format}`,
        bytes: await encodeImage(
          image,
          {
            xr: 0,
            yr: 0,
            wr: image.width,
            hr: image.height,
            ws: fullImageSize.width,
            hs: fullImageSize.height
          },
          format,
          options.quality
        )
      })

      completedImages += 1
      postProgress((completedImages / totalImages) * 95, 'Rendering images...')
    }
  }

  for (const plan of plans) {
    for (let row = 0; row < plan.rows; row += 1) {
      for (let column = 0; column < plan.columns; column += 1) {
        const tileInfo = calculateIiifTile(
          image.width,
          image.height,
          plan.scaleFactor,
          options.tileSize,
          options.tileSize,
          column,
          row
        )
        const region =
          tileInfo.xr === 0 &&
          tileInfo.yr === 0 &&
          tileInfo.wr === image.width &&
          tileInfo.hr === image.height
            ? 'full'
            : `${tileInfo.xr},${tileInfo.yr},${tileInfo.wr},${tileInfo.hr}`
        const size = `${tileInfo.ws},${tileInfo.hs}`

        for (const format of selectedFormats) {
          generatedFiles.push({
            path: `${region}/${size}/0/default.${format}`,
            bytes: await encodeImage(image, tileInfo, format, options.quality)
          })

          completedImages += 1
          postProgress(
            (completedImages / totalImages) * 95,
            'Rendering images...'
          )
        }
      }
    }
  }

  const info = {
    '@context': 'http://iiif.io/api/image/3/context.json',
    id: options.serviceId,
    type: 'ImageService3',
    protocol: 'http://iiif.io/api/image',
    profile: 'level0',
    width: image.width,
    height: image.height,
    ...(options.includeFullImage && fullImageIsLimited
      ? {
          maxWidth: fullImageSize.width,
          maxHeight: fullImageSize.height
        }
      : {}),
    extraFormats: selectedFormats.includes('webp') ? ['webp'] : [],
    preferredFormats: selectedFormats.includes('webp')
      ? ['webp', 'jpg']
      : ['jpg'],
    sizes: availableSizes.length ? availableSizes : undefined,
    tiles: [
      {
        width: options.tileSize,
        height: options.tileSize,
        scaleFactors
      }
    ]
  }

  const files: Record<string, Uint8Array> = {
    'info.json': new TextEncoder().encode(`${JSON.stringify(info, null, 2)}\n`)
  }

  for (const file of generatedFiles) {
    files[file.path] = file.bytes
  }

  postProgress(98, 'Packing ZIP file...')
  image.close()

  const zip = zipSync(files, { level: 0 })
  const zipBuffer = new ArrayBuffer(zip.byteLength)
  new Uint8Array(zipBuffer).set(zip)

  return zipBuffer
}

async function encodeImage(
  image: ImageBitmap,
  tileInfo: IiifTile,
  format: TileFormat,
  selectedQuality: number
) {
  const canvas = new OffscreenCanvas(tileInfo.ws, tileInfo.hs)
  const context = canvas.getContext('2d')

  if (!context) {
    throw new Error('Could not create an image canvas.')
  }

  if (format === 'jpg') {
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, tileInfo.ws, tileInfo.hs)
  }

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    image,
    tileInfo.xr,
    tileInfo.yr,
    tileInfo.wr,
    tileInfo.hr,
    0,
    0,
    tileInfo.ws,
    tileInfo.hs
  )

  const blob = await canvas.convertToBlob({
    type: format === 'webp' ? 'image/webp' : 'image/jpeg',
    quality: selectedQuality / 100
  })

  return new Uint8Array(await blob.arrayBuffer())
}

function postProgress(progress: number, message: string) {
  workerScope.postMessage({
    type: 'progress',
    progress,
    message
  } satisfies WorkerResponse)
}

function calculateMaxFullImageSize(
  width: number,
  height: number,
  maxFullImageDimension: number
) {
  const scale = Math.min(1, maxFullImageDimension / Math.max(width, height))

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

function calculateThumbnailSizes(
  width: number,
  height: number,
  fullImageSize: Size
) {
  const maxSourceDimension = Math.max(width, height)
  const maxFullImageDimension = Math.max(
    fullImageSize.width,
    fullImageSize.height
  )
  const thumbnailDimensions = calculateThumbnailDimensions(
    maxFullImageDimension
  )
  const seen = new Set<string>()

  return thumbnailDimensions.flatMap((maxThumbnailDimension) => {
    if (
      maxThumbnailDimension >= maxSourceDimension ||
      maxThumbnailDimension >= maxFullImageDimension
    ) {
      return []
    }

    const scale = maxThumbnailDimension / maxSourceDimension
    const size = {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    }
    const key = `${size.width}x${size.height}`

    if (
      seen.has(key) ||
      (size.width === fullImageSize.width &&
        size.height === fullImageSize.height)
    ) {
      return []
    }

    seen.add(key)
    return [size]
  })
}

function calculateThumbnailDimensions(maxFullImageDimension: number) {
  const dimensions: number[] = []
  let dimension = 512

  while (dimension < maxFullImageDimension) {
    dimensions.push(dimension)
    dimension *= 2
  }

  return dimensions
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
