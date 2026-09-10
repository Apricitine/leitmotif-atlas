import {
  curveCatmullRomClosed,
  line,
  polygonCentroid,
  polygonHull,
} from "d3"

export type GraphPoint = { x: number; y: number }
type Coordinate = [number, number]

// The curve configuration is constant. Reusing the generator avoids creating a
// new d3 object for every motif on every simulation frame.
const closedBlobLine = line<Coordinate>().curve(
  curveCatmullRomClosed.alpha(0.85),
)

// makes the cool blobs around each motif, todo
export function blobPath(
  points: readonly GraphPoint[],
  pad: number,
  pointCount = points.length,
): string {
  if (pointCount === 0) return ""

  if (pointCount === 1) {
    const p = points[0]
    return `M${p.x - pad},${p.y} a${pad},${pad} 0 1,0 ${pad * 2},0 a${pad},${pad} 0 1,0 ${-pad * 2},0`
  }

  let hullPts: Coordinate[]
  if (pointCount === 2) {
    const [a, b] = points
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    const nx = (-dy / len) * pad
    const ny = (dx / len) * pad
    hullPts = [
      [a.x + nx, a.y + ny],
      [b.x + nx, b.y + ny],
      [b.x - nx, b.y - ny],
      [a.x - nx, a.y - ny]
    ]
  } else {
    const coordinates = new Array<Coordinate>(pointCount)
    for (let i = 0; i < pointCount; i += 1) {
      const point = points[i]
      coordinates[i] = [point.x, point.y]
    }
    const hull = polygonHull(coordinates)
    if (!hull) return ""
    const centroid = polygonCentroid(hull)
    hullPts = hull.map(([x, y]) => {
      const dx = x - centroid[0]
      const dy = y - centroid[1]
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      return [x + (dx / len) * pad, y + (dy / len) * pad]
    })
  }

  return closedBlobLine(hullPts) ?? ""
}
