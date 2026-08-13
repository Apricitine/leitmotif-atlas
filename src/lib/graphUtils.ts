import * as d3 from "d3"

export type GraphPoint = { x: number; y: number }
type Coordinate = [number, number]

// makes the cool blobs around each motif, todo
export function blobPath(points: readonly GraphPoint[], pad: number): string {
  if (points.length === 0) return ""

  if (points.length === 1) {
    const p = points[0]
    return `M${p.x - pad},${p.y} a${pad},${pad} 0 1,0 ${pad * 2},0 a${pad},${pad} 0 1,0 ${-pad * 2},0`
  }

  let hullPts: Coordinate[]
  if (points.length === 2) {
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
    const hull = d3.polygonHull(points.map((p): Coordinate => [p.x, p.y]))
    if (!hull) return ""
    const centroid = d3.polygonCentroid(hull)
    hullPts = hull.map(([x, y]) => {
      const dx = x - centroid[0]
      const dy = y - centroid[1]
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      return [x + (dx / len) * pad, y + (dy / len) * pad]
    })
  }

  const line = d3.line<Coordinate>().curve(d3.curveCatmullRomClosed.alpha(0.85))
  return line(hullPts) ?? ""
}
