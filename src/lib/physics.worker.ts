import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceCenter,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3"

type PhysicsNode = SimulationNodeDatum & {
  id: string
  homeX?: number
  homeY?: number
}
type PhysicsLink = SimulationLinkDatum<PhysicsNode> & {
  source: string | PhysicsNode
  target: string | PhysicsNode
}
type InitializeMessage = {
  type: "initialize"
  width: number
  height: number
  nodes: { id: string }[]
  links: { source: string; target: string }[]
}
type ResizeMessage = { type: "resize"; width: number; height: number }
type DragMessage = {
  type: "drag-start" | "drag" | "drag-end"
  nodeId: string
  x?: number
  y?: number
}
type PhysicsMessage = InitializeMessage | ResizeMessage | DragMessage
type WorkerScope = {
  postMessage: (message: unknown, transfer: Transferable[]) => void
  onmessage: ((event: MessageEvent<PhysicsMessage>) => void) | null
}

let nodes: PhysicsNode[] = []
let nodeById = new Map<string, PhysicsNode>()
let simulation: Simulation<PhysicsNode, undefined> | undefined
let centerForce: ForceCenter<PhysicsNode> | undefined
let activeDragCount = 0
const workerScope = self as unknown as WorkerScope

function publishPositions(initial = false) {
  const positions = new Float64Array(nodes.length * 2)
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    positions[index * 2] = node.x ?? 0
    positions[index * 2 + 1] = node.y ?? 0
  }

  workerScope.postMessage(
    { type: initial ? "ready" : "positions", positions },
    [positions.buffer],
  )
}

function settleHomes() {
  for (const node of nodes) {
    node.homeX = node.x
    node.homeY = node.y
  }

  simulation
    ?.force(
      "anchorX",
      forceX<PhysicsNode>((node) => node.homeX ?? 0).strength(0.15),
    )
    .force(
      "anchorY",
      forceY<PhysicsNode>((node) => node.homeY ?? 0).strength(0.15),
    )
}

function initialize({ width, height, nodes: initialNodes, links }: InitializeMessage) {
  nodes = initialNodes.map((node) => ({ ...node }))
  nodeById = new Map(nodes.map((node) => [node.id, node]))
  activeDragCount = 0

  const physicsLinks: PhysicsLink[] = links.map((link) => ({ ...link }))
  centerForce = forceCenter<PhysicsNode>(width / 2, height / 2)
  simulation = forceSimulation<PhysicsNode>(nodes)
    .force(
      "link",
      forceLink<PhysicsNode, PhysicsLink>(physicsLinks)
        .id((node) => node.id)
        .distance(95)
        .strength(0.35),
    )
    .force("charge", forceManyBody().strength(-260))
    .force("center", centerForce)
    .force("collide", forceCollide<PhysicsNode>(38))
    .velocityDecay(0.35)
    .on("tick", publishPositions)
    .on("end", settleHomes)

  // forceSimulation assigns its initial phyllotaxis positions synchronously.
  // Sending them now lets the main thread render the same initial graph state.
  publishPositions(true)
}

workerScope.onmessage = (event: MessageEvent<PhysicsMessage>) => {
  const message = event.data

  if (message.type === "initialize") {
    initialize(message)
    return
  }

  if (message.type === "resize") {
    centerForce?.x(message.width / 2).y(message.height / 2)
    return
  }

  const node = nodeById.get(message.nodeId)
  if (!node) return

  if (message.type === "drag-start") {
    node.fx = message.x ?? node.x ?? 0
    node.fy = message.y ?? node.y ?? 0
    activeDragCount += 1
    simulation?.alphaTarget(0.35).restart()
    return
  }

  if (message.type === "drag") {
    node.fx = message.x ?? node.fx ?? node.x ?? 0
    node.fy = message.y ?? node.fy ?? node.y ?? 0
    return
  }

  node.fx = null
  node.fy = null
  activeDragCount = Math.max(0, activeDragCount - 1)
  if (activeDragCount === 0) simulation?.alphaTarget(0)
}
