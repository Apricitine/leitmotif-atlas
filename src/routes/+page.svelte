<script lang="ts">
  import { onMount } from "svelte"
  import { fade, fly } from "svelte/transition"
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
  let motifQuery = $state("")
  let songQuery = $state("")
  let songSearchEl: HTMLInputElement

  const visibleMotifs = $derived.by(() => {
    const query = motifQuery.trim().toLocaleLowerCase()
    if (!query) return motifData

    return motifData.filter((motif) =>
      `${motif.name} ${motif.id}`.toLocaleLowerCase().includes(query),
    )
  })

  const songResults = $derived.by(() => {
    const query = songQuery.trim().toLocaleLowerCase()
    if (!query) return []

    return nodes
      .filter((song) =>
        `${song.title} ${song.id}`.toLocaleLowerCase().includes(query),
      )
      .slice(0, 6)
  })

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
    const focusSongSearch = (event: KeyboardEvent) => {
      const target = event.target
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return
      }
      event.preventDefault()
      songSearchEl?.focus()
    }
    window.addEventListener("keydown", focusSongSearch)
    return () => {
      window.removeEventListener("resize", onResize)
      window.removeEventListener("keydown", focusSongSearch)
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
  function openSongFromSearch(node: GraphNode) {
    openSong(node)
    songQuery = ""
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
  <header class="page-header">
    <h1>DELTARUNE LEITMOTIF ATLAS</h1>
    <p>work in progress obv</p>
  </header>

  <div class="song-search">
    <label class="search-label" for="song-search">Search every song</label>
    <div class="search-field">
      <span class="search-icon" aria-hidden="true">⌕</span>
      <input
        bind:this={songSearchEl}
        bind:value={songQuery}
        id="song-search"
        type="search"
        placeholder="Search songs..."
        autocomplete="off"
        aria-controls="song-results"
      />
      <kbd>/</kbd>
      {#if songQuery}
        <button
          class="clear-search"
          aria-label="Clear song search"
          onclick={() => (songQuery = "")}
        >&times;</button>
      {/if}
    </div>

    {#if songQuery.trim()}
      <div id="song-results" class="search-results" transition:fade={{ duration: 140 }}>
        {#if songResults.length > 0}
          {#each songResults as song, i (song.id)}
            <button
              class="search-result"
              style={`--enter-delay: ${i * 35}ms`}
              onclick={() => openSongFromSearch(song)}
            >
              <span>{song.title}</span>
              <small>Chapter {song.chapter}</small>
            </button>
          {/each}
        {:else}
          <p class="search-empty">No songs found.</p>
        {/if}
      </div>
    {/if}
  </div>

  <div class="legend">
    <label class="search-label" for="motif-search">Find a motif</label>
    <div class="search-field motif-search">
      <span class="search-icon" aria-hidden="true">⌕</span>
      <input
        bind:value={motifQuery}
        id="motif-search"
        type="search"
        placeholder="Search motifs..."
        autocomplete="off"
      />
      {#if motifQuery}
        <button
          class="clear-search"
          aria-label="Clear motif search"
          onclick={() => (motifQuery = "")}
        >&times;</button>
      {/if}
    </div>

    <div class="motif-list">
      {#each visibleMotifs as motif, i (motif.id)}
        <button
          class="chip"
          class:dimmed={isolatedMotifs.size > 0 && !isolatedMotifs.has(motif.id)}
          class:selected={isolatedMotifs.has(motif.id)}
          style={`--enter-delay: ${Math.min(i, 10) * 30}ms; --motif-color: ${motif.color}`}
          aria-pressed={isolatedMotifs.has(motif.id)}
          onclick={() => toggleMotif(motif.id)}
        >
          <span class="dot" style:background={motif.color}></span>
          <span class="chip-name">{motif.name}</span>
          {#if isolatedMotifs.has(motif.id)}
            <span class="selection-mark" aria-label="Selected">✓</span>
          {/if}
        </button>
      {:else}
        <p class="search-empty">No motifs found.</p>
      {/each}
    </div>
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
      <g class="graph-root" transform={transformStr}>
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
    <aside
      class="panel open"
      in:fly={{ x: 28, duration: 240 }}
      out:fly={{ x: 28, duration: 160 }}
    >
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
    overflow: hidden;
    isolation: isolate;
    color: var(--text);
    font-family: "Space Grotesk", sans-serif;
  }

  .atlas::before {
    content: "";
    position: absolute;
    z-index: 0;
    inset: -20%;
    pointer-events: none;
    background:
      radial-gradient(circle at 18% 18%, rgba(172, 77, 255, 0.1), transparent 30%),
      radial-gradient(circle at 76% 74%, rgba(246, 119, 16, 0.08), transparent 28%);
    animation: ambient-drift 16s ease-in-out infinite alternate;
  }

  .page-header {
    position: absolute;
    top: 22px;
    left: 26px;
    z-index: 5;
    pointer-events: none;
    animation: rise-in 0.55s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .page-header h1 {
    font-family: "Press Start 2P", monospace;
    font-size: 14px;
    letter-spacing: 1px;
    margin: 0 0 8px 0;
    text-shadow: 0 0 14px rgba(241, 238, 249, 0.3);
  }

  .page-header p {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
    max-width: 320px;
  }

  .legend {
    position: absolute;
    top: 92px;
    right: 26px;
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(260px, calc(100vw - 52px));
    max-height: calc(100vh - 114px);
    overflow: hidden;
    animation: rise-in 0.55s 0.12s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .song-search {
    position: absolute;
    top: 22px;
    right: 26px;
    z-index: 6;
    width: min(260px, calc(100vw - 52px));
    animation: rise-in 0.55s 0.08s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .search-label {
    display: block;
    margin: 0 0 4px 4px;
    color: var(--muted);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .search-field {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 34px;
    padding: 0 9px;
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    background: rgba(21, 18, 31, 0.9);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    transition:
      border-color 0.2s ease,
      box-shadow 0.2s ease,
      transform 0.2s ease;
  }

  .search-field:focus-within {
    border-color: rgba(207, 201, 232, 0.52);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.3);
    transform: translateY(-1px);
  }

  .search-icon {
    color: var(--muted);
    font-size: 18px;
    line-height: 1;
    transform: rotate(-18deg);
  }

  .search-field input {
    width: 100%;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 12px;
  }

  .search-field input::placeholder {
    color: var(--muted);
  }

  kbd {
    flex: 0 0 auto;
    padding: 1px 5px;
    border: 1px solid var(--panel-border);
    border-radius: 4px;
    color: var(--muted);
    font-family: inherit;
    font-size: 10px;
  }

  .clear-search {
    flex: 0 0 auto;
    border: 0;
    border-radius: 50%;
    width: 19px;
    height: 19px;
    padding: 0;
    background: rgba(241, 238, 249, 0.1);
    color: var(--text);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    transition: background 0.16s ease, transform 0.16s ease;
  }

  .clear-search:hover {
    background: rgba(241, 238, 249, 0.2);
    transform: rotate(90deg);
  }

  .search-results {
    display: grid;
    gap: 4px;
    margin-top: 7px;
    padding: 6px;
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    background: rgba(21, 18, 31, 0.96);
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.32);
  }

  .search-result {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 7px 8px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    text-align: left;
    animation: result-enter 0.28s var(--enter-delay, 0ms) both;
    transition: background 0.16s ease, transform 0.16s ease;
  }

  .search-result:hover,
  .search-result:focus-visible {
    background: rgba(241, 238, 249, 0.08);
    transform: translateX(3px);
  }

  .search-result small {
    flex: 0 0 auto;
    color: var(--muted);
    font-size: 10px;
  }

  .search-empty {
    margin: 0;
    padding: 8px 9px;
    color: var(--muted);
    font-size: 12px;
  }

  .motif-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow-y: auto;
    padding: 1px 2px 12px;
    scrollbar-width: thin;
    scrollbar-color: rgba(241, 238, 249, 0.2) transparent;
  }

  .motif-list::-webkit-scrollbar {
    width: 5px;
  }

  .motif-list::-webkit-scrollbar-thumb {
    border-radius: 999px;
    background: rgba(241, 238, 249, 0.2);
  }

  .chip {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 999px;
    padding: 5px 10px;
    font-size: 11px;
    font-family: inherit;
    color: var(--text);
    cursor: pointer;
    user-select: none;
    text-align: left;
    animation: chip-enter 0.36s var(--enter-delay, 0ms) both;
    transition:
      opacity 0.2s ease,
      background 0.2s ease,
      border-color 0.2s ease,
      transform 0.2s ease;
  }

  .chip.dimmed {
    opacity: 0.35;
  }

  .chip.selected {
    border-color: var(--motif-color);
    background: rgba(42, 35, 57, 0.98);
    box-shadow: inset 0 0 0 1px var(--motif-color), 0 0 14px rgba(0, 0, 0, 0.2);
  }

  .chip:hover,
  .chip:focus-visible {
    border-color: rgba(241, 238, 249, 0.28);
    background: rgba(35, 30, 48, 0.96);
    transform: translateX(-3px);
  }

  .chip.selected:hover,
  .chip.selected:focus-visible {
    border-color: var(--motif-color);
    background: rgba(42, 35, 57, 0.98);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    display: inline-block;
    box-shadow: 0 0 0 transparent;
    transition: box-shadow 0.2s ease, transform 0.2s ease;
  }

  .chip-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .selection-mark {
    margin-left: auto;
    color: var(--motif-color);
    font-size: 14px;
    font-weight: 800;
    line-height: 1;
    animation: selection-pop 0.2s ease-out both;
  }

  .chip:hover .dot,
  .chip:focus-visible .dot {
    box-shadow: 0 0 10px var(--motif-color);
    transform: scale(1.14);
  }

  svg {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    cursor: grab;
  }
  svg:active {
    cursor: grabbing;
  }

  .graph-root {
    animation: graph-reveal 0.6s 0.15s ease-out both;
  }

  .graph-root path,
  .graph-root line,
  .graph-root circle,
  .graph-root text {
    transition: opacity 0.18s ease;
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
    box-shadow: -16px 0 44px rgba(0, 0, 0, 0.24);
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
    transition: color 0.16s ease, transform 0.16s ease;
  }

  .panel-close:hover,
  .panel-close:focus-visible {
    color: var(--text);
    transform: rotate(90deg) scale(1.1);
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
    transition: background 0.16s ease, padding-left 0.16s ease;
  }

  .related-song:hover {
    padding-left: 4px;
    background: rgba(241, 238, 249, 0.04);
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
    animation: rise-in 0.55s 0.2s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  @keyframes rise-in {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes chip-enter {
    from {
      opacity: 0;
      transform: translateX(10px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  @keyframes result-enter {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes selection-pop {
    from {
      opacity: 0;
      transform: scale(0.5);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  @keyframes graph-reveal {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes ambient-drift {
    from { transform: translate3d(-2%, -1%, 0) scale(1); }
    to { transform: translate3d(2%, 1%, 0) scale(1.04); }
  }

  @media (max-width: 720px) {
    .page-header {
      top: 16px;
      left: 16px;
    }

    .page-header h1 {
      font-size: 11px;
      line-height: 1.5;
      max-width: 220px;
    }

    .song-search {
      top: 94px;
      right: 16px;
      width: min(260px, calc(100vw - 32px));
    }

    .legend {
      top: 148px;
      right: 12px;
      width: min(260px, calc(100vw - 24px));
      max-height: calc(100vh - 202px);
    }

    .panel {
      box-sizing: border-box;
      width: min(300px, 100vw);
    }

    .hint {
      bottom: 12px;
      left: 16px;
      max-width: 250px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      scroll-behavior: auto !important;
      transition-duration: 0.01ms !important;
    }
  }
</style>
