<script lang="ts">
  import { onMount } from "svelte"
  import {
    drag,
    forceCenter,
    forceCollide,
    forceLink,
    forceManyBody,
    forceSimulation,
    forceX,
    forceY,
    select,
    zoom,
    zoomIdentity,
    type Simulation,
    type SimulationLinkDatum,
    type SimulationNodeDatum,
  } from "d3"
  import { motifs as motifData } from "$lib/motifs"
  import { songs as songData } from "$lib/songs"
  import { blobPath } from "$lib/graphUtils"

  type Song = (typeof songData)[number]
  type Motif = (typeof motifData)[number]
  type GraphNode = Song &
    SimulationNodeDatum & { homeX?: number; homeY?: number }
  type GraphLink = SimulationLinkDatum<GraphNode> & {
    source: string | GraphNode
    target: string | GraphNode
    motif: string
    color: string
  }
  type ResolvedGraphLink = Omit<GraphLink, "source" | "target"> & {
    source: GraphNode
    target: GraphNode
  }
  type Blob = Motif & { path: string }
  type RenderedNode = { node: GraphNode; x: number; y: number }
  type RenderedGraphLink = ResolvedGraphLink & {
    x1: number
    y1: number
    x2: number
    y2: number
  }
  type PanelContent =
    | { type: "song"; data: GraphNode }
    | { type: "motif"; data: Motif }
    | null

  let width = $state(0)
  let height = $state(0)

  // D3 updates these objects on every physics tick. They deliberately remain
  // plain objects: `positionVersion` below batches SVG work to the display
  // refresh rate instead of paying Svelte proxy costs for every x/y write.
  const nodes: GraphNode[] = songData.map((song) => ({ ...song }))
  const nodeById = new Map<string, GraphNode>(
    nodes.map((node) => [node.id, node]),
  )

  const links: GraphLink[] = motifData.flatMap((motif) =>
    motif.songs
      .filter((id) => id !== motif.source)
      .map((id) => ({
        source: motif.source,
        target: id,
        motif: motif.id,
        color: motif.color,
      })),
  )

  const motifSongs = new Map<string, string[]>(
    motifData.map((motif) => [motif.id, motif.songs]),
  )
  const songMotifs = new Map<string, Motif[]>(
    nodes.map((node) => [node.id, []]),
  )
  const sourceMotifs = new Map<string, Motif[]>(
    nodes.map((node) => [node.id, []]),
  )
  const blobDefinitions = motifData.map((motif) => {
    const motifNodes = motif.songs
      .map((id) => nodeById.get(id))
      .filter((node): node is GraphNode => node !== undefined)

    motif.songs.forEach((songId) => songMotifs.get(songId)?.push(motif))
    sourceMotifs.get(motif.source)?.push(motif)

    return {
      motif,
      nodes: motifNodes,
      // Reuse these coordinates on every frame instead of allocating one object
      // per song per blob update.
      points: motifNodes.map(() => ({ x: 0, y: 0 })),
    }
  })

  let svgEl: SVGSVGElement
  let simulation: Simulation<GraphNode, undefined> | undefined
  let ready = $state(false)
  let positionVersion = $state(0)
  let renderFrame: number | undefined

  let zoomTransform = $state.raw(zoomIdentity)
  const transformStr = $derived(
    `translate(${zoomTransform.x},${zoomTransform.y}) scale(${zoomTransform.k})`,
  )

  let hoveredSong = $state<string | null>(null)
  let hoveredMotif = $state<string | null>(null)
  let isolatedMotifs = $state(new Set<string>())
  let panelContent = $state<PanelContent>(null)

  const blobs = $derived.by<Blob[]>(() => {
    positionVersion
    return blobDefinitions.map(({ motif, nodes: motifNodes, points }) => {
      let pointCount = 0
      for (let i = 0; i < motifNodes.length; i += 1) {
        const node = motifNodes[i]
        if (node.x === undefined || node.y === undefined) continue
        points[pointCount].x = node.x
        points[pointCount].y = node.y
        pointCount += 1
      }
      return { ...motif, path: blobPath(points, 30, pointCount) }
    })
  })

  const renderedNodes = $derived.by<RenderedNode[]>(() => {
    positionVersion
    return nodes.map((node) => ({
      node,
      x: node.x ?? 0,
      y: node.y ?? 0,
    }))
  })

  const activeSongs = $derived(
    hoveredSong
      ? new Set([
          hoveredSong,
          ...getSongMotifs(hoveredSong).flatMap((motif) => motif.songs),
        ])
      : hoveredMotif
        ? new Set(motifSongs.get(hoveredMotif) ?? [])
        : null,
  )

  const activeMotifs = $derived(
    hoveredSong
      ? new Set(getSongMotifs(hoveredSong).map((motif) => motif.id))
      : hoveredMotif
        ? new Set([hoveredMotif])
        : null,
  )

  const isolatedSongs = $derived.by(() => {
    if (isolatedMotifs.size === 0) return null

    const songs = new Set<string>()
    isolatedMotifs.forEach((id) => {
      for (const song of motifSongs.get(id) ?? []) songs.add(song)
    })
    return songs
  })

  const renderedLinks = $derived.by<RenderedGraphLink[]>(() => {
    if (!ready) return []
    positionVersion
    return (links as ResolvedGraphLink[]).map((link) => ({
      ...link,
      ...linkGeometry(link.source, link.target, 11, 14),
    }))
  })

  function getSongMotifs(songId: string) {
    return songMotifs.get(songId) ?? []
  }

  function getSourceMotifs(songId: string) {
    return sourceMotifs.get(songId) ?? []
  }

  function getNode(songId: string) {
    return nodeById.get(songId)
  }

  function nodeOpacity(node: GraphNode) {
    if (activeSongs) return activeSongs.has(node.id) ? 1 : 0.15
    if (isolatedSongs) return isolatedSongs.has(node.id) ? 1 : 0.12
    return 1
  }

  function linkOpacity(link: GraphLink) {
    if (activeMotifs) return activeMotifs.has(link.motif) ? 1 : 0.08
    if (isolatedMotifs.size > 0)
      return isolatedMotifs.has(link.motif) ? 1 : 0.05
    return 0.45
  }

  function blobOpacity(motif: Blob) {
    if (activeMotifs) return activeMotifs.has(motif.id) ? 1 : 0.06
    if (isolatedMotifs.size > 0) return isolatedMotifs.has(motif.id) ? 1 : 0.04
    return 1
  }

  function linkGeometry(
    from: GraphNode,
    to: GraphNode,
    sourceRadius: number,
    targetRadius: number,
  ) {
    if (
      from.x === undefined ||
      from.y === undefined ||
      to.x === undefined ||
      to.y === undefined
    ) {
      return { x1: 0, y1: 0, x2: 0, y2: 0 }
    }
    const dx = to.x - from.x
    const dy = to.y - from.y
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    const unitX = dx / len
    const unitY = dy / len
    return {
      x1: from.x + unitX * sourceRadius,
      y1: from.y + unitY * sourceRadius,
      x2: to.x - unitX * targetRadius,
      y2: to.y - unitY * targetRadius,
    }
  }

  function scheduleRender() {
    if (renderFrame !== undefined) return
    renderFrame = requestAnimationFrame(() => {
      renderFrame = undefined
      positionVersion += 1
    })
  }

  onMount(() => {
    width = window.innerWidth
    height = window.innerHeight

    simulation = forceSimulation<GraphNode>(nodes)
      .force(
        "link",
        forceLink<GraphNode, GraphLink>(links)
          .id((node) => node.id)
          .distance(95)
          .strength(0.35),
      )
      .force("charge", forceManyBody().strength(-260))
      .force("center", forceCenter(width / 2, height / 2))
      .force("collide", forceCollide<GraphNode>(38))
      .velocityDecay(0.35)
      .on("tick", scheduleRender)
      .on("end", settleHomes)

    ready = true
    scheduleRender()

    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.4, 2.5])
      .on("zoom", (event) => {
        zoomTransform = event.transform
      })
    select(svgEl).call(zoomBehavior)

    let resizeFrame: number | undefined
    const onResize = () => {
      if (resizeFrame !== undefined) return
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined
        width = window.innerWidth
        height = window.innerHeight
        simulation?.force("center", forceCenter(width / 2, height / 2))
      })
    }
    window.addEventListener("resize", onResize)
    return () => {
      window.removeEventListener("resize", onResize)
      if (renderFrame !== undefined) cancelAnimationFrame(renderFrame)
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      simulation?.stop()
    }
  })

  // code to resolve the physics w all hte bounciness
  function settleHomes() {
    nodes.forEach((node) => {
      node.homeX = node.x
      node.homeY = node.y
    })
    simulation
      ?.force(
        "anchorX",
        forceX<GraphNode>((node) => node.homeX ?? 0).strength(0.15),
      )
      .force(
        "anchorY",
        forceY<GraphNode>((node) => node.homeY ?? 0).strength(0.15),
      )
  }

  // svelte related stuff for dragging nodes
  function dragNode(el: SVGCircleElement, node: GraphNode) {
    const behavior = drag<SVGCircleElement, GraphNode>()
      .on("start", (event) => {
        if (!event.active) simulation?.alphaTarget(0.35).restart()
        node.fx = node.x
        node.fy = node.y
      })
      .on("drag", (event) => {
        node.fx = event.x
        node.fy = event.y
      })
      .on("end", (event) => {
        if (!event.active) simulation?.alphaTarget(0)
        node.fx = null
        node.fy = null
      })
    select<SVGCircleElement, GraphNode>(el).datum(node).call(behavior)
    return {
      destroy() {
        select(el).on(".drag", null)
      },
    }
  }

  function toggleMotif(id: string) {
    const next = new Set(isolatedMotifs)
    next.has(id) ? next.delete(id) : next.add(id)
    isolatedMotifs = next
  }

  function openSong(node: GraphNode) {
    panelContent = { type: "song", data: node }
  }
  function openMotif(motif: Motif) {
    panelContent = { type: "motif", data: motif }
  }
  function closePanel() {
    panelContent = null
  }

  function closePanelOnClick(el: SVGSVGElement) {
    el.addEventListener("click", closePanel)
    return {
      destroy() {
        el.removeEventListener("click", closePanel)
      },
    }
  }

  function activateWithKeyboard(event: KeyboardEvent, callback: () => void) {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    event.stopPropagation()
    callback()
  }
</script>

<div class="atlas">
  <header>
    <h1>DELTARUNE LEITMOTIF ATLAS</h1>
    <p>work in progress obv</p>
  </header>

  <div class="legend">
    
    {#each motifData as motif (motif.id)}
      <button
        class="chip"
        class:dimmed={isolatedMotifs.size > 0 && !isolatedMotifs.has(motif.id)}
        onclick={() => toggleMotif(motif.id)}
      >
        <span class="dot" style:background={motif.color}></span>
        {motif.name}
      </button>
    {/each}
  </div>

  <svg bind:this={svgEl} viewBox="0 0 {width} {height}" use:closePanelOnClick>
    <defs>
      <filter id="blob-blur" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="14" />
      </filter>
      <filter id="node-glow" x="-100%" y="-100%" width="300%" height="300%">
        <feGaussianBlur stdDeviation="3" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      {#each motifData as m (m.id)}
        <marker
          id="arrow-{m.id}"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,0L10,5L0,10z" fill={m.color} />
        </marker>
      {/each}
    </defs>

    {#if ready}
      <g transform={transformStr}>
        {#each blobs as motif (motif.id)}
          <path
            d={motif.path}
            fill={motif.color}
            opacity={blobOpacity(motif) * 0.18}
            filter="url(#blob-blur)"
            style="pointer-events:none"
          />
        {/each}

        {#each blobs as motif (motif.id)}
          <path
            d={motif.path}
            fill={motif.color}
            fill-opacity="0.1"
            stroke={motif.color}
            stroke-opacity="0.55"
            stroke-width="1.2"
            opacity={blobOpacity(motif)}
            style="cursor:pointer"
            role="button"
            tabindex="0"
            aria-label={`Open ${motif.name} details`}
            onclick={(event) => {
              event.stopPropagation()
              openMotif(motif)
            }}
            onkeydown={(event) =>
              activateWithKeyboard(event, () => openMotif(motif))}
            onmouseenter={() => (hoveredMotif = motif.id)}
            onmouseleave={() => (hoveredMotif = null)}
          />
        {/each}

        {#each renderedLinks as link (link.source.id + "-" + link.target.id + "-" + link.motif)}
          <line
            x1={link.x1}
            y1={link.y1}
            x2={link.x2}
            y2={link.y2}
            stroke={link.color}
            stroke-width="1.4"
            opacity={linkOpacity(link)}
            marker-end="url(#arrow-{link.motif})"
          />
        {/each}

        {#each renderedNodes as positionedNode (positionedNode.node.id)}
          {@const node = positionedNode.node}
          {#each getSourceMotifs(node.id) as m, i (m.id)}
            <circle
              cx={positionedNode.x}
              cy={positionedNode.y}
              r={14 + i * 4}
              fill="none"
              stroke={m.color}
              stroke-width="1.5"
              stroke-dasharray="3 2"
              opacity={nodeOpacity(node)}
              style="pointer-events:none"
            />
          {/each}
          <circle
            cx={positionedNode.x}
            cy={positionedNode.y}
            r="9"
            fill="var(--node)"
            stroke="var(--node-stroke)"
            stroke-width="2"
            filter="url(#node-glow)"
            opacity={nodeOpacity(node)}
            style="cursor:pointer"
            use:dragNode={node}
            role="button"
            tabindex="0"
            aria-label={`Open ${node.title} details`}
            onclick={(event) => {
              event.stopPropagation()
              openSong(node)
            }}
            onkeydown={(event) =>
              activateWithKeyboard(event, () => openSong(node))}
            onmouseenter={() => (hoveredSong = node.id)}
            onmouseleave={() => (hoveredSong = null)}
          />
          <text
            x={positionedNode.x}
            y={positionedNode.y - 14}
            text-anchor="middle"
            class="song-label"
            opacity={nodeOpacity(node)}>{node.title}</text
          >
        {/each}
      </g>
    {/if}
  </svg>

  {#if panelContent}
    <aside class="panel open">
      <button class="panel-close" onclick={closePanel}>&times;</button>

      {#if panelContent.type === "song"}
        <h2>{panelContent.data.title}</h2>
        <div class="meta">Chapter {panelContent.data.chapter}</div>
        {#each getSongMotifs(panelContent.data.id) as m (m.id)}
          <h3>
            {m.source === panelContent.data.id ? "Source of" : "Derives from"}
          </h3>
          <div class="motif-row">
            <span class="dot" style:background={m.color}></span>{m.name}
          </div>
          {#if m.source === panelContent.data.id}
            {#each m.songs.filter((id) => id !== m.source) as id}
              <div class="related-song">{getNode(id)?.title}</div>
            {/each}
          {:else}
            <div class="related-song">{getNode(m.source)?.title}</div>
          {/if}
        {/each}
        {#if getSongMotifs(panelContent.data.id).length === 0}
          <p class="empty">No shared motifs in this sample dataset.</p>
        {/if}
      {:else}
        {@const motif = panelContent.data}
        <h2 style:color={motif.color}>{motif.name}</h2>
        <div class="meta">{motif.songs.length} songs</div>
        <h3>Source</h3>
        <div class="related-song">{getNode(motif.source)?.title}</div>
        <h3>Derives into</h3>
        {#each motif.songs.filter((id) => id !== motif.source) as id}
          <div class="related-song">{getNode(id)?.title}</div>
        {/each}
      {/if}
    </aside>
  {/if}

  <p class="hint">
    drag songs to rearrange - click a song or a bubble for details - click a
    legend chip to get a theme
  </p>
</div>

<style>
  :global(:root) {
    --bg: #0a0912;
    --panel: #15121f;
    --panel-border: rgba(241, 238, 249, 0.08);
    --text: #f1eef9;
    --muted: #85809c;
    --node: #cfc9e8;
    --node-stroke: #0a0912;
  }

  .atlas {
    position: relative;
    width: 100vw;
    height: 100vh;
    color: var(--text);
    font-family: "Space Grotesk", sans-serif;
  }

  header {
    position: absolute;
    top: 22px;
    left: 26px;
    z-index: 5;
    pointer-events: none;
  }

  header h1 {
    font-family: "Press Start 2P", monospace;
    font-size: 14px;
    letter-spacing: 1px;
    margin: 0 0 8px 0;
    text-shadow: 0 0 14px rgba(241, 238, 249, 0.3);
  }

  header p {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
    max-width: 320px;
  }

  .legend {
    position: absolute;
    top: 22px;
    right: 26px;
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-end;
    height: 90vh;
    overflow: scroll;
  }

  .legend::-webkit-scrollbar {
    display: none
  }

  .chip {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 999px;
    padding: 6px 14px 6px 10px;
    font-size: 12px;
    font-family: inherit;
    color: var(--text);
    cursor: pointer;
    user-select: none;
    transition: opacity 0.2s ease;
  }

  .chip.dimmed {
    opacity: 0.35;
  }

  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex-shrink: 0;
    display: inline-block;
  }

  svg {
    width: 100%;
    height: 100%;
    cursor: grab;
  }
  svg:active {
    cursor: grabbing;
  }

  :global(.song-label) {
    font-size: 10.5px;
    fill: var(--muted);
    pointer-events: none;
  }

  .panel {
    position: absolute;
    top: 0;
    right: 0;
    height: 100%;
    width: 300px;
    background: var(--panel);
    border-left: 1px solid var(--panel-border);
    z-index: 10;
    padding: 26px 22px;
    overflow-y: auto;
  }

  .panel-close {
    background: none;
    border: none;
    color: var(--muted);
    font-size: 18px;
    cursor: pointer;
    position: absolute;
    top: 18px;
    right: 18px;
  }

  .panel h2 {
    font-size: 16px;
    margin: 6px 0 4px 0;
  }

  .panel .meta {
    color: var(--muted);
    font-size: 12px;
    margin-bottom: 18px;
  }

  .panel h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--muted);
    margin: 18px 0 8px 0;
  }

  .panel .empty {
    color: var(--muted);
    font-size: 13px;
  }

  .motif-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    margin-bottom: 6px;
  }

  .related-song {
    font-size: 12.5px;
    color: var(--text);
    padding: 4px 0;
    border-bottom: 1px solid var(--panel-border);
  }

  .hint {
    position: absolute;
    bottom: 18px;
    left: 26px;
    font-size: 11px;
    color: var(--muted);
    margin: 0;
    z-index: 5;
    pointer-events: none;
  }
</style>
