export function mapMvAdapterViews(images) {
  const list = Array.isArray(images) ? images : []
  if (list.length !== 3) {
    const error = new Error(`mvadapter_view_count_mismatch:expected=3 actual=${list.length}`)
    error.status = 502
    throw error
  }
  const keys = ['front', 'side', 'back']
  const azimuths = [0, 90, 180]
  return list.map((image, index) => ({
    key: keys[index],
    azimuth: azimuths[index],
    bytes: image.bytes,
    ext: image.ext,
    meta: image.meta
  }))
}
