<script lang="ts">
  import { onMount } from "svelte"
  import {
    drag,
    easeCubicOut,
    select,
    zoom,
    zoomIdentity,
    type ZoomBehavior,
  } from "d3"
  import { motifs as motifData, type MotifClip } from "$lib/motifs"
  import { songs as songData } from "$lib/songs"
  import { blobPath } from "$lib/graphUtils"

  type Song = (typeof songData)[number]
  type Motif = (typeof motifData)[number]
  type GraphNode = Song & { x?: number; y?: number }
  type GraphLink = {
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
  type Catalog = "motifs" | "songs"
  type MatchPart = { text: string; matches: boolean }
  type SongTrace = {
    songIds: string[]
    edgeKeys: Set<string>
    motifIds: Set<string>
  }
  type ResolvedMotifClip = {
    videoId: string
    startSeconds: number
    endSeconds: number
  }
  type YouTubePlayer = {
    destroy: () => void
    loadVideoById: (options: {
      videoId: string
      startSeconds: number
      endSeconds: number
    }) => void
    pauseVideo: () => void
    playVideo: () => void
    seekTo: (seconds: number, allowSeekAhead?: boolean) => void
    setVolume: (volume: number) => void
  }
  type YouTubeApi = {
    Player: new (
      element: HTMLElement,
      options: {
        width: string
        height: string
        playerVars: Record<string, number | string>
        events: {
          onReady: () => void
          onStateChange: (event: { data: number }) => void
          onError: () => void
        }
      },
    ) => YouTubePlayer
    PlayerState: { PLAYING: number; PAUSED: number; ENDED: number }
  }
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

  // Position messages from the physics worker update these plain objects.
  // `positionVersion` below batches SVG work to the display refresh rate,
  // avoiding Svelte proxy costs for every x/y write.
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
  const resolvedLinks: ResolvedGraphLink[] = links.map((link) => ({
    ...link,
    source: nodeById.get(link.source as string)!,
    target: nodeById.get(link.target as string)!,
  }))

  // Routes are intentionally undirected: a shared motif is useful to trace in
  // either musical direction, even though the arrows still show its source.
  const songNeighbors = new Map<string, string[]>(nodes.map((node) => [node.id, []]))
  for (const link of links) {
    const source = link.source as string
    const target = link.target as string
    songNeighbors.get(source)?.push(target)
    songNeighbors.get(target)?.push(source)
  }

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
  let physicsWorker: Worker | undefined
  let zoomBehavior: ZoomBehavior<SVGSVGElement, unknown> | undefined
  let searchInput: HTMLInputElement | undefined
  let youtubeHost: HTMLDivElement
  let youtubePlayer: YouTubePlayer | undefined
  let youtubeApiPromise: Promise<YouTubeApi> | undefined
  let loadedClip: ResolvedMotifClip | undefined
  let ready = $state(false)
  let positionVersion = $state(0)
  let renderFrame: number | undefined
  let reduceMotion = false

  let zoomTransform = $state.raw(zoomIdentity)
  const transformStr = $derived(
    `translate(${zoomTransform.x},${zoomTransform.y}) scale(${zoomTransform.k})`,
  )

  let hoveredSong = $state<string | null>(null)
  let hoveredMotif = $state<string | null>(null)
  let selectedSongId = $state<string | null>(null)
  let selectedMotifId = $state<string | null>(null)
  let traceMode = $state(false)
  let traceStartId = $state<string | null>(null)
  let traceEndId = $state<string | null>(null)
  let activeCatalog = $state<Catalog>("motifs")
  let catalogQuery = $state("")
  let panelContent = $state<PanelContent>(null)
  let clipPlaybackError = $state<string | null>(null)
  let activeClipMotifId = $state<string | null>(null)
  let isClipPlaying = $state(false)
  let clipVolume = $state(80)

  const normalizedCatalogQuery = $derived(catalogQuery.trim().toLocaleLowerCase())
  const filteredMotifs = $derived.by(() => {
    const query = normalizedCatalogQuery
    return motifData.filter((motif) =>
      !query || motif.name.toLocaleLowerCase().includes(query),
    )
  })
  const filteredSongs = $derived.by(() => {
    const query = normalizedCatalogQuery
    return songData.filter((song) =>
      !query ||
      song.title.toLocaleLowerCase().includes(query) ||
      `chapter ${song.chapter}`.includes(query),
    )
  })

  const trace = $derived.by<SongTrace | null>(() => {
    if (!traceStartId || !traceEndId) return null
    const songIds = findShortestPath(traceStartId, traceEndId)
    if (!songIds) return null

    const edgeKeys = new Set<string>()
    for (let index = 1; index < songIds.length; index += 1) {
      edgeKeys.add(routeEdgeKey(songIds[index - 1], songIds[index]))
    }

    const motifIds = new Set<string>()
    for (const link of links) {
      if (edgeKeys.has(routeEdgeKey(link.source as string, link.target as string))) {
        motifIds.add(link.motif)
      }
    }
    return { songIds, edgeKeys, motifIds }
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

  const activeSongs = $derived.by(() => {
    if (trace) return new Set(trace.songIds)

    const songId = hoveredSong ?? selectedSongId
    if (songId) {
      return new Set([
        songId,
        ...getSongMotifs(songId).flatMap((motif) => motif.songs),
      ])
    }

    const motifId = hoveredMotif ?? selectedMotifId
    return motifId ? new Set(motifSongs.get(motifId) ?? []) : null
  })

  const activeMotifs = $derived.by(() => {
    if (trace) return trace.motifIds

    const songId = hoveredSong ?? selectedSongId
    if (songId) return new Set(getSongMotifs(songId).map((motif) => motif.id))

    const motifId = hoveredMotif ?? selectedMotifId
    return motifId ? new Set([motifId]) : null
  })

  const renderedLinks = $derived.by<RenderedGraphLink[]>(() => {
    if (!ready) return []
    positionVersion
    return resolvedLinks.map((link) => ({
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

  function routeEdgeKey(from: string, to: string) {
    return from < to ? `${from}|${to}` : `${to}|${from}`
  }

  function findShortestPath(start: string, end: string) {
    if (start === end) return [start]

    const previous = new Map<string, string | null>([[start, null]])
    const queue = [start]

    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]
      for (const neighbor of songNeighbors.get(current) ?? []) {
        if (previous.has(neighbor)) continue
        previous.set(neighbor, current)
        if (neighbor === end) {
          const route = [end]
          let cursor: string | null = current
          while (cursor) {
            route.push(cursor)
            cursor = previous.get(cursor) ?? null
          }
          return route.reverse()
        }
        queue.push(neighbor)
      }
    }

    return null
  }

  function nodeOpacity(node: GraphNode) {
    if (activeSongs) return activeSongs.has(node.id) ? 1 : 0.15
    return 1
  }

  function linkOpacity(link: GraphLink) {
    const sourceId = typeof link.source === "string" ? link.source : link.source.id
    const targetId = typeof link.target === "string" ? link.target : link.target.id
    if (trace) {
      return trace.edgeKeys.has(routeEdgeKey(sourceId, targetId))
        ? 1
        : 0.035
    }
    if (activeMotifs) return activeMotifs.has(link.motif) ? 1 : 0.08
    return 0.45
  }

  function blobOpacity(motif: Blob) {
    if (activeMotifs) return activeMotifs.has(motif.id) ? 1 : 0.06
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

  function applyPhysicsPositions(positions: Float64Array) {
    for (let index = 0; index < nodes.length; index += 1) {
      nodes[index].x = positions[index * 2]
      nodes[index].y = positions[index * 2 + 1]
    }
    scheduleRender()
  }

  function extractYouTubeId(value: string) {
    const trimmed = value.trim()
    if (/^[\w-]{11}$/.test(trimmed)) return trimmed

    try {
      const url = new URL(trimmed)
      const host = url.hostname.replace(/^www\./, "")
      const videoId =
        host === "youtu.be"
          ? url.pathname.slice(1).split("/")[0]
          : host.endsWith("youtube.com")
            ? url.searchParams.get("v") ??
              url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/)?.[1]
            : null
      return videoId && /^[\w-]{11}$/.test(videoId) ? videoId : null
    } catch {
      return null
    }
  }

  function getMotifClip(motifId: string): ResolvedMotifClip | undefined {
    const clip: MotifClip | undefined = motifData.find((motif) => motif.id === motifId)?.clip
    if (!clip) return undefined

    const videoId = extractYouTubeId(clip.youtubeUrl)
    if (
      !videoId ||
      !Number.isFinite(clip.startSeconds) ||
      !Number.isFinite(clip.endSeconds) ||
      clip.startSeconds < 0 ||
      clip.endSeconds <= clip.startSeconds
    ) {
      return undefined
    }
    return { videoId, startSeconds: clip.startSeconds, endSeconds: clip.endSeconds }
  }

  function youtubeWindow() {
    return window as Window & {
      YT?: YouTubeApi
      onYouTubeIframeAPIReady?: () => void
    }
  }

  function loadYouTubeApi() {
    if (youtubeApiPromise) return youtubeApiPromise

    youtubeApiPromise = new Promise<YouTubeApi>((resolve, reject) => {
      const youtube = youtubeWindow()
      if (youtube.YT?.Player) {
        resolve(youtube.YT)
        return
      }

      const previousReady = youtube.onYouTubeIframeAPIReady
      youtube.onYouTubeIframeAPIReady = () => {
        previousReady?.()
        if (youtube.YT?.Player) resolve(youtube.YT)
        else reject(new Error("YouTube player API did not initialize."))
      }

      if (document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) return

      const script = document.createElement("script")
      script.src = "https://www.youtube.com/iframe_api"
      script.onerror = () => reject(new Error("Could not load the YouTube player."))
      document.head.append(script)
    })
    return youtubeApiPromise
  }

  async function ensureYouTubePlayer() {
    if (youtubePlayer) return youtubePlayer
    const api = await loadYouTubeApi()

    return new Promise<YouTubePlayer>((resolve) => {
      youtubePlayer = new api.Player(youtubeHost, {
        width: "200",
        height: "200",
        playerVars: { controls: 0, disablekb: 1, playsinline: 1, rel: 0 },
        events: {
          onReady: () => {
            youtubePlayer?.setVolume(clipVolume)
            resolve(youtubePlayer!)
          },
          onStateChange: (event) => {
            isClipPlaying = event.data === api.PlayerState.PLAYING
          },
          onError: () => {
            isClipPlaying = false
            clipPlaybackError = activeClipMotifId
          },
        },
      })
    })
  }

  async function playMotifClip(motifId: string) {
    const clip = getMotifClip(motifId)
    if (!clip) return

    activeClipMotifId = motifId
    clipPlaybackError = null
    try {
      const player = await ensureYouTubePlayer()
      const isLoadedClip =
        loadedClip?.videoId === clip.videoId &&
        loadedClip.startSeconds === clip.startSeconds &&
        loadedClip.endSeconds === clip.endSeconds

      if (isLoadedClip) {
        player.seekTo(clip.startSeconds, true)
        player.playVideo()
      } else {
        player.loadVideoById(clip)
        loadedClip = clip
      }
    } catch {
      clipPlaybackError = motifId
      isClipPlaying = false
    }
  }

  function pauseClip() {
    youtubePlayer?.pauseVideo()
    isClipPlaying = false
  }

  function toggleMotifClip(motifId: string) {
    if (activeClipMotifId === motifId && isClipPlaying) pauseClip()
    else playMotifClip(motifId)
  }

  function updateClipVolume(value: number) {
    clipVolume = value
    youtubePlayer?.setVolume(value)
  }

  function formatTimestamp(seconds: number) {
    const minutes = Math.floor(seconds / 60)
    const remainder = Math.floor(seconds % 60)
    return `${minutes}:${String(remainder).padStart(2, "0")}`
  }

  onMount(() => {
    width = window.innerWidth
    height = window.innerHeight
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
    reduceMotion = motionQuery.matches
    const onMotionChange = () => (reduceMotion = motionQuery.matches)
    motionQuery.addEventListener("change", onMotionChange)

    physicsWorker = new Worker(new URL("../lib/physics.worker.ts", import.meta.url), {
      type: "module",
    })
    physicsWorker.onmessage = (
      event: MessageEvent<{ type: "ready" | "positions"; positions: Float64Array }>,
    ) => {
      applyPhysicsPositions(event.data.positions)
      if (event.data.type === "ready") ready = true
    }
    physicsWorker.postMessage({
      type: "initialize",
      width,
      height,
      nodes: nodes.map(({ id }) => ({ id })),
      links: links.map((link) => ({
        source: link.source as string,
        target: link.target as string,
      })),
    })

    zoomBehavior = zoom<SVGSVGElement, unknown>()
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
        physicsWorker?.postMessage({ type: "resize", width, height })
      })
    }
    window.addEventListener("resize", onResize)
    return () => {
      window.removeEventListener("resize", onResize)
      motionQuery.removeEventListener("change", onMotionChange)
      if (renderFrame !== undefined) cancelAnimationFrame(renderFrame)
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      select(svgEl).interrupt("focus")
      physicsWorker?.terminate()
      physicsWorker = undefined
      youtubePlayer?.destroy()
    }
  })

  // svelte related stuff for dragging nodes
  function dragNode(el: SVGCircleElement, node: GraphNode) {
    const behavior = drag<SVGCircleElement, GraphNode>()
      .on("start", (event) => {
        node.x = event.x
        node.y = event.y
        physicsWorker?.postMessage({
          type: "drag-start",
          nodeId: node.id,
          x: event.x,
          y: event.y,
        })
        scheduleRender()
      })
      .on("drag", (event) => {
        node.x = event.x
        node.y = event.y
        physicsWorker?.postMessage({
          type: "drag",
          nodeId: node.id,
          x: event.x,
          y: event.y,
        })
        scheduleRender()
      })
      .on("end", () => {
        physicsWorker?.postMessage({ type: "drag-end", nodeId: node.id })
      })
    select<SVGCircleElement, GraphNode>(el).datum(node).call(behavior)
    return {
      destroy() {
        select(el).on(".drag", null)
      },
    }
  }

  function openSong(node: GraphNode) {
    pauseClip()
    clearTrace()
    selectedSongId = node.id
    selectedMotifId = null
    panelContent = { type: "song", data: node }
  }

  function openMotif(motif: Motif) {
    if (activeClipMotifId !== motif.id) pauseClip()
    clearTrace()
    selectedMotifId = motif.id
    selectedSongId = null
    panelContent = { type: "motif", data: motif }
  }

  function focusPoint(x: number, y: number) {
    if (!zoomBehavior || !width || !height) return

    const scale = Math.max(zoomTransform.k, 0.85)
    const destination = zoomIdentity
      .translate(width / 2 - x * scale, height / 2 - y * scale)
      .scale(scale)
    const canvas = select(svgEl).interrupt("focus")

    if (reduceMotion) {
      canvas.call(zoomBehavior.transform, destination)
      return
    }

    canvas
      .transition("focus")
      .duration(360)
      .ease(easeCubicOut)
      .call(zoomBehavior.transform, destination)
  }

  function focusSong(node: GraphNode) {
    openSong(node)
    if (node.x !== undefined && node.y !== undefined) focusPoint(node.x, node.y)
  }

  function beginTrace() {
    activeCatalog = "songs"
    catalogQuery = ""
    traceMode = true
    traceStartId = null
    traceEndId = null
    selectedSongId = null
    selectedMotifId = null
    panelContent = null
    requestAnimationFrame(() => searchInput?.focus())
  }

  function clearTrace() {
    traceMode = false
    traceStartId = null
    traceEndId = null
  }

  function cancelTrace() {
    clearTrace()
    selectedSongId = null
    selectedMotifId = null
    panelContent = null
  }

  function chooseTraceSong(node: GraphNode) {
    if (!traceStartId || traceEndId) {
      traceStartId = node.id
      traceEndId = null
      selectedSongId = node.id
    } else if (node.id !== traceStartId) {
      traceEndId = node.id
      selectedSongId = node.id
    }

    selectedMotifId = null
    panelContent = null
    if (node.x !== undefined && node.y !== undefined) focusPoint(node.x, node.y)
  }

  function selectSong(node: GraphNode) {
    if (traceMode) {
      chooseTraceSong(node)
      return
    }
    focusSong(node)
  }

  function focusMotif(motif: Motif) {
    openMotif(motif)

    let x = 0
    let y = 0
    let count = 0
    for (const songId of motif.songs) {
      const node = getNode(songId)
      if (node?.x === undefined || node.y === undefined) continue
      x += node.x
      y += node.y
      count += 1
    }
    if (count) focusPoint(x / count, y / count)
  }

  function clearSelection() {
    pauseClip()
    clearTrace()
    selectedSongId = null
    selectedMotifId = null
    panelContent = null
  }

  function closePanel() {
    pauseClip()
    panelContent = null
  }

  function switchCatalog(catalog: Catalog) {
    activeCatalog = catalog
    catalogQuery = ""
    requestAnimationFrame(() => searchInput?.focus())
  }

  function highlightQuery(value: string): MatchPart[] {
    const query = normalizedCatalogQuery
    if (!query) return [{ text: value, matches: false }]

    const index = value.toLocaleLowerCase().indexOf(query)
    if (index === -1) return [{ text: value, matches: false }]

    return [
      { text: value.slice(0, index), matches: false },
      { text: value.slice(index, index + query.length), matches: true },
      { text: value.slice(index + query.length), matches: false },
    ].filter((part) => part.text)
  }

  function handleGlobalKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
      event.preventDefault()
      searchInput?.focus()
    }
    if (event.key === "Escape") {
      if (document.activeElement === searchInput) {
        searchInput?.blur()
      } else if (traceMode) {
        cancelTrace()
      } else {
        closePanel()
      }
    }
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

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="atlas" class:has-selection={selectedSongId !== null || selectedMotifId !== null}>
  <div class="control-hub" class:has-panel={panelContent !== null}>
    <header>
      <p class="eyebrow">interactive score map</p>
      <h1>DELTARUNE LEITMOTIF ATLAS</h1>
      <p>See the connections between songs.</p>
    </header>

  <section class="catalog" aria-label="Atlas explorer">
    <div class="catalog-heading">
      <div>
        <p class="eyebrow">EXPLORE</p>
        <h2>{activeCatalog === "motifs" ? "Motifs" : "Songs"}</h2>
      </div>
      {#if selectedSongId || selectedMotifId}
        <button class="clear-focus" onclick={clearSelection}>Clear</button>
      {/if}
    </div>

    <div class="catalog-tabs" role="tablist" aria-label="Explorer type">
      <button
        class:active={activeCatalog === "motifs"}
        role="tab"
        aria-selected={activeCatalog === "motifs"}
        onclick={() => switchCatalog("motifs")}
      >
        Motifs <span>{motifData.length}</span>
      </button>
      <button
        class:active={activeCatalog === "songs"}
        role="tab"
        aria-selected={activeCatalog === "songs"}
        onclick={() => switchCatalog("songs")}
      >
        Songs <span>{songData.length}</span>
      </button>
    </div>

    <div class="search-field">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 20-4.2-4.2m2.2-5.3a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" /></svg>
      <input
        bind:this={searchInput}
        bind:value={catalogQuery}
        type="search"
        placeholder={`Search ${activeCatalog}`}
        aria-label={`Search ${activeCatalog}`}
      />
      {#if catalogQuery}
        <button class="clear-query" onclick={() => (catalogQuery = "")} aria-label="Clear search">&times;</button>
      {:else}
        <kbd>⌘K</kbd>
      {/if}
    </div>

    <p class="catalog-summary">
      {activeCatalog === "motifs"
        ? `${filteredMotifs.length} of ${motifData.length} motifs`
        : `${filteredSongs.length} of ${songData.length} songs`}
    </p>

    {#if activeCatalog === "songs"}
      <div class="trace-control">
        {#if traceMode}
          <p>
            {#if !traceStartId}
              Choose a route start
            {:else if !traceEndId}
              Now choose a destination
            {:else if trace}
              {trace.songIds.length - 1} shared-motif {trace.songIds.length === 2 ? "hop" : "hops"}
            {:else}
              No shared-motif route found
            {/if}
          </p>
          <button class="trace-reset" onclick={traceEndId ? beginTrace : cancelTrace}>
            {traceEndId ? "Start over" : "Cancel"}
          </button>
        {:else}
          <button class="trace-trigger" onclick={beginTrace}>
            <span aria-hidden="true">⌁</span> Trace two songs
          </button>
        {/if}
      </div>
      {#if trace}
        <div class="trace-route" aria-label="Shortest shared-motif route">
          {#each trace.songIds as songId, index (songId)}
            {#if index > 0}<span class="trace-arrow" aria-hidden="true">→</span>{/if}
            <span>{getNode(songId)?.title}</span>
          {/each}
        </div>
      {/if}
    {/if}

    <div class="catalog-list" aria-live="polite">
      {#if activeCatalog === "motifs"}
        {#each filteredMotifs as motif (motif.id)}
          <button
            class="catalog-item motif-item"
            class:selected={selectedMotifId === motif.id}
            aria-pressed={selectedMotifId === motif.id}
            onclick={() => focusMotif(motif)}
            onmouseenter={() => (hoveredMotif = motif.id)}
            onmouseleave={() => (hoveredMotif = null)}
          >
            <span class="motif-swatch" style:background={motif.color}></span>
            <span class="catalog-item-copy">
              <span class="catalog-item-title">
                {#each highlightQuery(motif.name) as part}
                  <mark class:match={part.matches}>{part.text}</mark>
                {/each}
              </span>
              <span class="catalog-item-meta">{motif.songs.length} songs</span>
            </span>
            <span class="item-arrow" aria-hidden="true">↗</span>
          </button>
        {:else}
          <p class="no-results">No motifs match “{catalogQuery}”.</p>
        {/each}
      {:else}
        {#each filteredSongs as song (song.id)}
          {@const node = getNode(song.id)}
          {#if node}
            <button
              class="catalog-item song-item"
              class:selected={selectedSongId === song.id || traceStartId === song.id}
              class:trace-start={traceStartId === song.id}
              class:trace-end={traceEndId === song.id}
              aria-pressed={selectedSongId === song.id || traceStartId === song.id}
              onclick={() => selectSong(node)}
              onmouseenter={() => (hoveredSong = song.id)}
              onmouseleave={() => (hoveredSong = null)}
            >
              <span class="song-number">{String(song.chapter).padStart(2, "0")}</span>
              <span class="catalog-item-copy">
                <span class="catalog-item-title">
                  {#each highlightQuery(song.title) as part}
                    <mark class:match={part.matches}>{part.text}</mark>
                  {/each}
                </span>
                <span class="catalog-item-meta">Chapter {song.chapter}</span>
              </span>
              <span class="item-arrow" aria-hidden="true">↗</span>
            </button>
          {/if}
        {:else}
          <p class="no-results">No songs match “{catalogQuery}”.</p>
        {/each}
      {/if}
    </div>
    </section>

  {#if panelContent}
    <aside class="panel open">
      <div class="panel-heading">
        <p class="eyebrow">{panelContent.type === "song" ? "SONG" : "MOTIF"}</p>
        <button class="panel-close" onclick={closePanel} aria-label="Close details">&times;</button>
      </div>

      {#if panelContent.type === "song"}
        <h2>{panelContent.data.title}</h2>
        <div class="meta">Chapter {panelContent.data.chapter}</div>
        {#each getSongMotifs(panelContent.data.id) as m (m.id)}
          <h3>
            {m.source === panelContent.data.id ? "Source of" : "Derives from"}
          </h3>
          <button class="motif-row" onclick={() => focusMotif(m)}>
            <span class="dot" style:background={m.color}></span><span>{m.name}</span>
            <span class="row-arrow" aria-hidden="true">↗</span>
          </button>
          {#if m.source === panelContent.data.id}
            {#each m.songs.filter((id) => id !== m.source) as id}
              {@const relatedSong = getNode(id)}
              {#if relatedSong}
                <button class="related-song" onclick={() => focusSong(relatedSong)}>{relatedSong.title}</button>
              {/if}
            {/each}
          {:else}
            {@const sourceSong = getNode(m.source)}
            {#if sourceSong}
              <button class="related-song" onclick={() => focusSong(sourceSong)}>{sourceSong.title}</button>
            {/if}
          {/if}
        {/each}
        {#if getSongMotifs(panelContent.data.id).length === 0}
          <p class="empty">No shared motifs in this sample dataset.</p>
        {/if}
      {:else}
        {@const motif = panelContent.data}
        {@const clip = getMotifClip(motif.id)}
        <h2 style:color={motif.color}>{motif.name}</h2>
        <div class="meta">{motif.songs.length} songs</div>

        {#if clip}
        <section class="audio-card" aria-label={`${motif.name} audio clip`}>
          <div class="audio-card-heading">
            <div>
              <strong>Motif soundbite</strong>
            </div>
            <span class="clip-range">{formatTimestamp(clip.startSeconds)}–{formatTimestamp(clip.endSeconds)}</span>
          </div>

          <div class="clip-controls">
            <button
              class="clip-play"
              class:playing={activeClipMotifId === motif.id && isClipPlaying}
              onclick={() => toggleMotifClip(motif.id)}
            >
              {activeClipMotifId === motif.id && isClipPlaying ? "Pause" : "Play audio"}
            </button>
            <button class="clip-icon-button" onclick={() => playMotifClip(motif.id)} aria-label="Restart clip">↺</button>
            <a
              class="clip-icon-button"
              href={`https://www.youtube.com/watch?v=${clip.videoId}&t=${Math.floor(clip.startSeconds)}`}
              target="_blank"
              rel="noreferrer"
              aria-label="Open clip on YouTube"
            >↗</a>
          </div>
          <label class="volume-control">
            <span>Volume</span>
            <input
              type="range"
              min="0"
              max="100"
              value={clipVolume}
              aria-label="Clip volume"
              oninput={(event) => updateClipVolume(Number(event.currentTarget.value))}
            />
          </label>
          {#if clipPlaybackError === motif.id}
            <p class="clip-error" role="alert">The YouTube player could not load this clip.</p>
          {/if}
        </section>
        {/if}

        <h3>Source</h3>
        {@const sourceSong = getNode(motif.source)}
        {#if sourceSong}
          <button class="related-song" onclick={() => focusSong(sourceSong)}>{sourceSong.title}</button>
        {/if}
        <h3>Derives into</h3>
        {#each motif.songs.filter((id) => id !== motif.source) as id}
          {@const relatedSong = getNode(id)}
          {#if relatedSong}
            <button class="related-song" onclick={() => focusSong(relatedSong)}>{relatedSong.title}</button>
          {/if}
        {/each}
      {/if}
    </aside>
  {/if}
  </div>

  <svg bind:this={svgEl} viewBox="0 0 {width} {height}" use:closePanelOnClick>
    <defs>
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
      <g class="graph-content" transform={transformStr}>
        {#each blobs as motif (motif.id)}
          <path
            class="blob-aura"
            d={motif.path}
            fill={motif.color}
            fill-opacity="0.025"
            stroke={motif.color}
            stroke-opacity="0.13"
            stroke-width="9"
            style:opacity={blobOpacity(motif)}
            style="pointer-events:none"
          />
        {/each}

        {#each blobs as motif (motif.id)}
          <path
            class="motif-blob"
            class:focused={selectedMotifId === motif.id || hoveredMotif === motif.id}
            d={motif.path}
            fill={motif.color}
            fill-opacity="0.1"
            stroke={motif.color}
            stroke-opacity="0.55"
            stroke-width="1.2"
            style:opacity={blobOpacity(motif)}
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
            class="graph-link"
            class:active={activeMotifs?.has(link.motif)}
            class:traced={trace?.edgeKeys.has(routeEdgeKey(link.source.id, link.target.id))}
            x1={link.x1}
            y1={link.y1}
            x2={link.x2}
            y2={link.y2}
            stroke={link.color}
            stroke-width="1.4"
            style:opacity={linkOpacity(link)}
            marker-end="url(#arrow-{link.motif})"
          />
        {/each}

        {#each renderedNodes as positionedNode (positionedNode.node.id)}
          {@const node = positionedNode.node}
          {@const isTraceEndpoint = traceStartId === node.id || traceEndId === node.id}
          {@const isTraced = trace?.songIds.includes(node.id) ?? false}
          {@const isFocused = selectedSongId === node.id || hoveredSong === node.id || isTraceEndpoint}
          {@const highlightColor = getSongMotifs(node.id)[0]?.color ?? "#cfc9e8"}
          {#if isFocused}
            <circle
              class="selection-ring"
              cx={positionedNode.x}
              cy={positionedNode.y}
              r="16"
              stroke={highlightColor}
            />
          {/if}
          {#each getSourceMotifs(node.id) as m, i (m.id)}
            <circle
              class="source-ring"
              class:focused={isFocused}
              cx={positionedNode.x}
              cy={positionedNode.y}
              r={14 + i * 4}
              fill="none"
              stroke={m.color}
              stroke-width="1.5"
              stroke-dasharray="3 2"
              style:opacity={nodeOpacity(node)}
              style="pointer-events:none"
            />
          {/each}
          <circle
            class="node-aura"
            cx={positionedNode.x}
            cy={positionedNode.y}
            r="13"
            style:opacity={nodeOpacity(node) * 0.16}
          />
          <circle
            class="graph-node"
            class:focused={isFocused}
            class:traced={isTraced}
            class:trace-endpoint={isTraceEndpoint}
            cx={positionedNode.x}
            cy={positionedNode.y}
            r="9"
            fill="var(--node)"
            stroke="var(--node-stroke)"
            stroke-width="2"
            style:opacity={nodeOpacity(node)}
            style="cursor:pointer"
            use:dragNode={node}
            role="button"
            tabindex="0"
            aria-label={`Open ${node.title} details`}
            onclick={(event) => {
              event.stopPropagation()
              selectSong(node)
            }}
            onkeydown={(event) =>
              activateWithKeyboard(event, () => selectSong(node))}
            onmouseenter={() => (hoveredSong = node.id)}
            onmouseleave={() => (hoveredSong = null)}
          />
          <text
            x={positionedNode.x}
            y={positionedNode.y - 14}
            text-anchor="middle"
            class="song-label"
            class:focused={isFocused}
            class:traced={isTraced}
            style:opacity={nodeOpacity(node)}>{node.title}</text
          >
        {/each}
      </g>
    {/if}
  </svg>

  <div class="youtube-audio-host" bind:this={youtubeHost} aria-hidden="true"></div>

  <p class="hint">
    Drag songs to rearrange · select a song or motif to trace its connections ·
    scroll to zoom
  </p>
</div>

<style>
  :global(:root) {
    --bg: #0a0912;
    --surface: rgba(21, 18, 31, 0.88);
    --surface-strong: #191522;
    --surface-hover: #211c2e;
    --panel-border: rgba(241, 238, 249, 0.1);
    --panel-border-strong: rgba(241, 238, 249, 0.18);
    --text: #f1eef9;
    --muted: #938da7;
    --muted-strong: #b6b0c5;
    --node: #d8d3eb;
    --node-stroke: #0a0912;
    --focus: #ad7cff;
  }

  .atlas {
    position: relative;
    width: 100vw;
    height: 100vh;
    isolation: isolate;
    overflow: hidden;
    color: var(--text);
    font-family: "Space Grotesk", sans-serif;
    background:
      radial-gradient(circle at 55% 42%, rgba(86, 55, 152, 0.11), transparent 34rem),
      var(--bg);
  }

  .atlas::before {
    position: absolute;
    z-index: -1;
    inset: 0;
    background-image: radial-gradient(rgba(241, 238, 249, 0.12) 0.6px, transparent 0.6px);
    background-size: 24px 24px;
    opacity: 0.1;
    content: "";
    pointer-events: none;
  }

  button,
  input {
    font: inherit;
  }

  button:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  :global(*) {
    scrollbar-color: rgba(201, 156, 255, 0.42) rgba(7, 6, 13, 0.28);
    scrollbar-width: thin;
  }

  :global(*::-webkit-scrollbar) {
    width: 7px;
    height: 7px;
  }

  :global(*::-webkit-scrollbar-track) {
    border-radius: 999px;
    background: rgba(7, 6, 13, 0.28);
  }

  :global(*::-webkit-scrollbar-thumb) {
    border: 2px solid rgba(7, 6, 13, 0.28);
    border-radius: 999px;
    background: rgba(201, 156, 255, 0.42);
  }

  :global(*::-webkit-scrollbar-thumb:hover) {
    background: rgba(218, 185, 255, 0.7);
  }

  .control-hub {
    position: absolute;
    top: 16px;
    left: 16px;
    z-index: 8;
    display: flex;
    width: min(278px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    flex-direction: column;
    gap: 9px;
    pointer-events: none;
  }

  .control-hub > * {
    pointer-events: auto;
  }

  header {
    max-width: 270px;
    padding: 3px 4px 6px;
    animation: fade-up 480ms both cubic-bezier(0.22, 1, 0.36, 1);
  }

  .eyebrow {
    margin: 0 0 7px;
    color: var(--muted);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.14em;
  }

  header h1 {
    margin: 0 0 6px;
    font-family: "Press Start 2P", monospace;
    font-size: 11px;
    line-height: 1.45;
    letter-spacing: 0.5px;
    text-shadow: 0 0 18px rgba(241, 238, 249, 0.22);
  }

  header > p:last-child {
    margin: 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.5;
  }

  .catalog {
    display: flex;
    width: 100%;
    max-height: min(370px, calc(100vh - 116px));
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--panel-border);
    border-radius: 14px;
    background: var(--surface);
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.18);
    backdrop-filter: blur(14px);
    animation: fade-up 520ms 60ms both cubic-bezier(0.22, 1, 0.36, 1);
  }

  .control-hub.has-panel .catalog {
    max-height: min(260px, calc(100vh - 390px));
  }

  .catalog-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 13px 14px 9px;
  }

  .catalog-heading .eyebrow {
    margin-bottom: 3px;
  }

  .catalog-heading h2 {
    margin: 0;
    font-size: 16px;
    letter-spacing: -0.02em;
  }

  .clear-focus {
    border: 0;
    border-radius: 8px;
    padding: 5px 7px;
    background: transparent;
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: color 160ms ease, background 160ms ease;
  }

  .clear-focus:hover {
    background: rgba(241, 238, 249, 0.07);
    color: var(--text);
  }

  .catalog-tabs {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 4px;
    margin: 0 10px;
    padding: 4px;
    border: 1px solid rgba(241, 238, 249, 0.06);
    border-radius: 10px;
    background: rgba(7, 6, 13, 0.45);
  }

  .catalog-tabs button {
    border: 0;
    border-radius: 7px;
    padding: 7px 8px;
    background: transparent;
    color: var(--muted);
    font-size: 12px;
    font-weight: 650;
    cursor: pointer;
    transition: color 180ms ease, background 180ms ease, box-shadow 180ms ease;
  }

  .catalog-tabs button span {
    margin-left: 3px;
    opacity: 0.65;
    font-size: 10px;
  }

  .catalog-tabs button.active {
    background: #312846;
    color: var(--text);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
  }

  .search-field {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 9px 10px 0;
    padding: 0 10px;
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    background: rgba(7, 6, 13, 0.38);
    transition: border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
  }

  .search-field:focus-within {
    border-color: rgba(173, 124, 255, 0.72);
    background: rgba(18, 14, 29, 0.8);
    box-shadow: 0 0 0 3px rgba(173, 124, 255, 0.12);
  }

  .search-field svg {
    width: 15px;
    height: 15px;
    flex: 0 0 auto;
    cursor: default;
    fill: none;
    stroke: var(--muted);
    stroke-linecap: round;
    stroke-width: 1.8;
  }

  .search-field input {
    width: 100%;
    min-width: 0;
    padding: 8px 0;
    border: 0;
    background: transparent;
    color: var(--text);
    font-size: 12px;

    &:focus {
      outline: 0;
    }
  }

  .search-field input::placeholder {
    color: var(--muted);
  }

  .search-field kbd {
    border: 1px solid var(--panel-border);
    border-radius: 4px;
    padding: 2px 4px;
    color: var(--muted);
    font-family: inherit;
    font-size: 9px;
    white-space: nowrap;
  }

  .clear-query {
    display: grid;
    width: 18px;
    height: 18px;
    place-items: center;
    border: 0;
    border-radius: 50%;
    background: rgba(241, 238, 249, 0.1);
    color: var(--muted-strong);
    cursor: pointer;
    line-height: 1;
  }

  .catalog-summary {
    margin: 8px 14px 6px;
    color: var(--muted);
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .trace-control {
    display: flex;
    min-height: 30px;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 0 10px 7px;
    padding: 5px 7px;
    border: 1px solid rgba(173, 124, 255, 0.2);
    border-radius: 8px;
    background: rgba(173, 124, 255, 0.07);
  }

  .trace-control p {
    overflow: hidden;
    margin: 0;
    color: #ddd0ff;
    font-size: 10px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trace-trigger,
  .trace-reset {
    border: 0;
    border-radius: 6px;
    color: var(--muted-strong);
    cursor: pointer;
    font-size: 10.5px;
    font-weight: 650;
    transition: color 160ms ease, background 160ms ease;
  }

  .trace-trigger {
    width: 100%;
    padding: 4px 6px;
    background: transparent;
    text-align: left;
  }

  .trace-trigger span {
    margin-right: 4px;
    color: #d9b7ff;
    font-size: 15px;
    vertical-align: -1px;
  }

  .trace-reset {
    flex: 0 0 auto;
    padding: 4px 5px;
    background: rgba(241, 238, 249, 0.07);
  }

  .trace-trigger:hover,
  .trace-reset:hover {
    background: rgba(173, 124, 255, 0.16);
    color: var(--text);
  }

  .trace-route {
    display: flex;
    gap: 5px;
    overflow-x: auto;
    margin: -2px 10px 7px;
    padding: 5px 7px;
    border-radius: 7px;
    background: rgba(7, 6, 13, 0.3);
    color: var(--muted-strong);
    font-size: 10px;
    line-height: 1.2;
    white-space: nowrap;
  }

  .trace-arrow {
    color: #d9b7ff;
  }

  .catalog-list {
    display: flex;
    min-height: 80px;
    flex: 1;
    flex-direction: column;
    gap: 3px;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0 7px 8px;
  }

  .catalog-item {
    display: grid;
    width: 100%;
    grid-template-columns: 12px minmax(0, 1fr) 14px;
    align-items: center;
    gap: 10px;
    border: 1px solid transparent;
    border-radius: 10px;
    padding: 7px 8px;
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
    transition: background 160ms ease, border-color 160ms ease, transform 160ms ease, box-shadow 160ms ease;
  }

  .catalog-item:hover {
    border-color: rgba(241, 238, 249, 0.08);
    background: var(--surface-hover);
    transform: translateX(-2px);
  }

  .catalog-item.selected {
    border-color: rgba(173, 124, 255, 0.44);
    background: linear-gradient(90deg, rgba(173, 124, 255, 0.18), rgba(173, 124, 255, 0.05));
    box-shadow: inset 2px 0 0 var(--focus);
  }

  .catalog-item.trace-start {
    box-shadow: inset 2px 0 0 #f7dc8a;
  }

  .catalog-item.trace-end {
    border-color: rgba(173, 124, 255, 0.62);
    box-shadow: inset 2px 0 0 #c99cff;
  }

  .motif-swatch {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.06);
  }

  .song-number {
    color: var(--muted);
    font-family: "Press Start 2P", monospace;
    font-size: 8px;
  }

  .catalog-item-copy {
    display: grid;
    min-width: 0;
    gap: 3px;
  }

  .catalog-item-title {
    overflow: hidden;
    color: var(--text);
    font-size: 12.5px;
    font-weight: 600;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .catalog-item-title mark {
    padding: 0;
    background: transparent;
    color: inherit;
  }

  .catalog-item-title mark.match {
    border-radius: 2px;
    background: rgba(248, 212, 112, 0.24);
    color: #fff0b6;
  }

  .catalog-item-meta {
    color: var(--muted);
    font-size: 10.5px;
  }

  .item-arrow,
  .row-arrow {
    color: var(--muted);
    opacity: 0;
    transform: translate(-3px, 2px);
    transition: opacity 160ms ease, transform 160ms ease, color 160ms ease;
  }

  .catalog-item:hover .item-arrow,
  .catalog-item.selected .item-arrow,
  .motif-row:hover .row-arrow {
    color: var(--text);
    opacity: 1;
    transform: translate(0, 2px);
  }

  .no-results {
    margin: 24px 8px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
    text-align: center;
  }

  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 50%;
  }

  svg {
    width: 100%;
    height: 100%;
    cursor: grab;
    touch-action: none;
  }

  svg:active {
    cursor: grabbing;
  }

  .blob-aura,
  .motif-blob,
  .graph-link,
  .source-ring,
  .node-aura,
  .graph-node,
  :global(.song-label) {
    transition: opacity 180ms ease, stroke-width 180ms ease, fill-opacity 180ms ease;
  }

  .blob-aura,
  .node-aura,
  .selection-ring {
    pointer-events: none;
  }

  .motif-blob.focused {
    fill-opacity: 0.16;
    stroke-width: 2.2;
  }

  .graph-link.active {
    stroke-width: 2.1;
  }

  .graph-link.traced {
    stroke-width: 3;
  }

  .node-aura {
    fill: var(--node);
  }

  .graph-node.focused {
    stroke: var(--text);
    stroke-width: 2.5;
  }

  .graph-node.traced {
    fill: #fff3c7;
  }

  .graph-node.trace-endpoint {
    fill: #ead5ff;
    stroke: var(--text);
    stroke-width: 2.6;
  }

  .source-ring.focused {
    animation: source-dash 7s linear infinite;
  }

  .selection-ring {
    fill: none;
    stroke-width: 1.5;
    stroke-dasharray: 3 3;
    animation: selection-pulse 1.7s ease-out infinite;
  }

  :global(.song-label) {
    fill: var(--muted);
    font-size: 10.5px;
    font-weight: 500;
    pointer-events: none;
  }

  :global(.song-label.focused) {
    fill: var(--text);
    font-weight: 700;
  }

  :global(.song-label.traced) {
    fill: #fff1c1;
  }

  .panel {
    width: 100%;
    max-height: min(300px, calc(100vh - 390px));
    overflow-y: auto;
    overscroll-behavior: contain;
    border: 1px solid var(--panel-border);
    border-radius: 14px;
    padding: 13px 14px 14px;
    background: var(--surface);
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.18);
    backdrop-filter: blur(14px);
    animation: panel-in 260ms both cubic-bezier(0.22, 1, 0.36, 1);
  }

  .panel-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .panel-heading .eyebrow {
    margin: 0;
  }

  .panel-close {
    display: grid;
    width: 25px;
    height: 25px;
    place-items: center;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--muted);
    font-size: 20px;
    cursor: pointer;
    transition: background 160ms ease, color 160ms ease;
  }

  .panel-close:hover {
    background: rgba(241, 238, 249, 0.08);
    color: var(--text);
  }

  .panel h2 {
    margin: 10px 0 4px;
    font-size: 17px;
    letter-spacing: -0.015em;
  }

  .panel .meta {
    margin-bottom: 17px;
    color: var(--muted);
    font-size: 12px;
  }

  .panel h3 {
    margin: 18px 0 7px;
    color: var(--muted);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .panel .empty {
    color: var(--muted);
    font-size: 13px;
  }

  .audio-card {
    margin: 14px 0 4px;
    padding: 10px;
    border: 1px solid rgba(173, 124, 255, 0.2);
    border-radius: 10px;
    background: linear-gradient(135deg, rgba(173, 124, 255, 0.1), rgba(173, 124, 255, 0.025));
  }

  .audio-card-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .audio-card-heading strong {
    font-size: 11px;
  }

  .clip-range {
    flex: 0 0 auto;
    border-radius: 5px;
    padding: 3px 5px;
    background: rgba(7, 6, 13, 0.32);
    color: #e5d7ff;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  .clip-controls {
    display: flex;
    gap: 6px;
    margin-top: 9px;
  }

  .clip-play,
  .clip-icon-button {
    border: 0;
    border-radius: 6px;
    cursor: pointer;
    font-size: 10.5px;
    font-weight: 700;
    transition: transform 150ms ease, background 150ms ease, color 150ms ease;
  }

  .clip-play {
    flex: 1;
    padding: 7px 9px;
    background: #d3b4ff;
    color: #180d2a;
  }

  .clip-play.playing {
    background: #f1e9ff;
  }

  .clip-icon-button {
    display: grid;
    width: 30px;
    place-items: center;
    padding: 0;
    background: rgba(241, 238, 249, 0.1);
    color: var(--text);
    text-decoration: none;
  }

  .clip-play:hover,
  .clip-icon-button:hover {
    transform: translateY(-1px);
  }

  .volume-control {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    color: var(--muted);
    font-size: 10px;
  }

  .volume-control input {
    width: 100%;
    accent-color: #c99cff;
  }

  .clip-error {
    margin: 0;
    font-size: 9.5px;
    line-height: 1.35;
  }

  .clip-error {
    color: #ffb9c7;
  }

  .motif-row,
  .related-song {
    width: 100%;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--text);
    cursor: pointer;
    text-align: left;
    transition: background 150ms ease, color 150ms ease, padding 150ms ease;
  }

  .motif-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 7px;
    font-size: 12.5px;
    font-weight: 600;
  }

  .motif-row .row-arrow {
    margin-left: auto;
  }

  .related-song {
    display: block;
    padding: 5px 7px 5px 22px;
    color: var(--muted-strong);
    font-size: 12px;
  }

  .motif-row:hover,
  .related-song:hover {
    background: rgba(241, 238, 249, 0.07);
    color: var(--text);
  }

  .hint {
    position: absolute;
    bottom: 19px;
    left: 28px;
    z-index: 5;
    max-width: min(510px, calc(100vw - 80px));
    margin: 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.45;
    pointer-events: none;
  }

  .youtube-audio-host {
    position: fixed;
    top: -220px;
    left: -220px;
    width: 200px;
    height: 200px;
    overflow: hidden;
    pointer-events: none;
  }

  @keyframes fade-up {
    from {
      opacity: 0;
      transform: translateY(9px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes panel-in {
    from {
      opacity: 0;
      transform: translateX(-10px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateX(0) scale(1);
    }
  }

  @keyframes selection-pulse {
    0% {
      opacity: 0.9;
      stroke-dashoffset: 0;
    }
    70%,
    100% {
      opacity: 0.18;
      stroke-dashoffset: -12;
    }
  }

  @keyframes source-dash {
    to {
      stroke-dashoffset: -30;
    }
  }

  @media (max-width: 760px) {
    .control-hub {
      top: 10px;
      left: 10px;
      width: min(274px, calc(100vw - 20px));
      gap: 7px;
    }

    header {
      max-width: 250px;
      padding: 2px 3px;
    }

    header h1 {
      font-size: 10px;
    }

    header > p:last-child,
    .hint,
    .search-field kbd {
      display: none;
    }

    .catalog {
      width: 100%;
      max-height: 42vh;
      border-radius: 13px;
    }

    .control-hub.has-panel .catalog {
      max-height: 27vh;
    }

    .catalog-heading {
      padding: 12px 14px 8px;
    }

    .catalog-heading h2 {
      font-size: 16px;
    }

    .catalog-tabs,
    .search-field {
      margin-left: 10px;
      margin-right: 10px;
    }

    .catalog-summary {
      margin-left: 14px;
    }

    .catalog-item {
      padding-top: 7px;
      padding-bottom: 7px;
    }

    .panel {
      width: 100%;
      max-height: 31vh;
    }
  }

  @media (max-height: 680px) {
    header > p:last-child {
      display: none;
    }

    .catalog {
      max-height: 46vh;
    }

    .control-hub.has-panel .catalog,
    .panel {
      max-height: 30vh;
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
