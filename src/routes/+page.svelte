<script lang="ts">
  import { onMount } from "svelte";
  import * as d3 from "d3";
  import { songs as songData, motifs as motifData } from "$lib/data";
  import { blobPath } from "$lib/graphUtils";

  type Song = (typeof songData)[number];
  type Motif = (typeof motifData)[number];
  type GraphNode = Song & d3.SimulationNodeDatum & { homeX?: number; homeY?: number };
  type GraphLink = d3.SimulationLinkDatum<GraphNode> & {
    source: string | GraphNode;
    target: string | GraphNode;
    motif: string;
    color: string;
  };
  type ResolvedGraphLink = Omit<GraphLink, "source" | "target"> & {
    source: GraphNode;
    target: GraphNode;
  };
  type Blob = Motif & { path: string };
  type PanelContent = { type: "song"; data: GraphNode } | { type: "motif"; data: Motif } | null;

  let width = $state(0);
  let height = $state(0);

  // holyyyyyy shit going crazzzy
  let nodes = $state<GraphNode[]>(songData.map((song) => ({ ...song })));
  const nodeById = new Map<string, GraphNode>(nodes.map((node) => [node.id, node]));

  let links = $state<GraphLink[]>([]);
  motifData.forEach((motif) => {
    motif.songs
      .filter((id) => id !== motif.source)
      .forEach((id) => {
        links.push({ source: motif.source, target: id, motif: motif.id, color: motif.color });
      });
  });

  const motifSongs = new Map<string, string[]>(motifData.map((motif) => [motif.id, motif.songs]));
  const songMotifs = new Map<string, Motif[]>(
    nodes.map((node) => [node.id, motifData.filter((motif) => motif.songs.includes(node.id))])
  );
  const sourceMotifs = new Map<string, Motif[]>(
    nodes.map((node) => [node.id, motifData.filter((motif) => motif.source === node.id)])
  );

  let svgEl: SVGSVGElement;
  let simulation: d3.Simulation<GraphNode, undefined> | undefined;
  let ready = $state(false);

  let zoomTransform = $state.raw(d3.zoomIdentity);
  const transformStr = $derived(
    `translate(${zoomTransform.x},${zoomTransform.y}) scale(${zoomTransform.k})`
  );

  let hoveredSong = $state<string | null>(null);
  let hoveredMotif = $state<string | null>(null);
  let isolatedMotifs = $state(new Set<string>());
  let panelContent = $state<PanelContent>(null);

  const blobs = $derived.by<Blob[]>(() =>
    motifData.map((motif) => {
      const points = motif.songs.flatMap((id) => {
        const node = nodes.find((candidate) => candidate.id === id);
        return node?.x !== undefined && node.y !== undefined ? [{ x: node.x, y: node.y }] : [];
      });
      return { ...motif, path: blobPath(points, 30) };
    })
  );

  const activeSongs = $derived(
    hoveredSong
      ? new Set([hoveredSong, ...getSongMotifs(hoveredSong).flatMap((motif) => motif.songs)])
      : hoveredMotif
        ? new Set(motifSongs.get(hoveredMotif) ?? [])
        : null
  );

  const activeMotifs = $derived(
    hoveredSong
      ? new Set(getSongMotifs(hoveredSong).map((motif) => motif.id))
      : hoveredMotif
        ? new Set([hoveredMotif])
        : null
  );

  const resolvedLinks = $derived(ready ? (links as ResolvedGraphLink[]) : []);

  function getSongMotifs(songId: string) {
    return songMotifs.get(songId) ?? [];
  }

  function getSourceMotifs(songId: string) {
    return sourceMotifs.get(songId) ?? [];
  }

  function getNode(songId: string) {
    return nodeById.get(songId);
  }

  function nodeOpacity(node: GraphNode) {
    if (activeSongs) return activeSongs.has(node.id) ? 1 : 0.15;
    if (isolatedMotifs.size > 0) {
      const active = new Set<string>();
      isolatedMotifs.forEach((id) => (motifSongs.get(id) ?? []).forEach((song) => active.add(song)));
      return active.has(node.id) ? 1 : 0.12;
    }
    return 1;
  }

  function linkOpacity(link: GraphLink) {
    if (activeMotifs) return activeMotifs.has(link.motif) ? 1 : 0.08;
    if (isolatedMotifs.size > 0) return isolatedMotifs.has(link.motif) ? 1 : 0.05;
    return 0.45;
  }

  function blobOpacity(motif: Blob) {
    if (activeMotifs) return activeMotifs.has(motif.id) ? 1 : 0.06;
    if (isolatedMotifs.size > 0) return isolatedMotifs.has(motif.id) ? 1 : 0.04;
    return 1;
  }

  function edgePoint(from: GraphNode, to: GraphNode, r: number) {
    if (from.x === undefined || from.y === undefined || to.x === undefined || to.y === undefined) {
      return { x: 0, y: 0 };
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: from.x + (dx / len) * r, y: from.y + (dy / len) * r };
  }

  onMount(() => {
    width = window.innerWidth;
    height = window.innerHeight;

    simulation = d3
      .forceSimulation<GraphNode>(nodes)
      .force("link", d3.forceLink<GraphNode, GraphLink>(links).id((node) => node.id).distance(95).strength(0.35))
      .force("charge", d3.forceManyBody().strength(-260))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide(38))
      .velocityDecay(0.35)
      .on("end", settleHomes);

    ready = true;

    const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.4, 2.5]).on("zoom", (event) => {
      zoomTransform = event.transform;
    });
    d3.select(svgEl).call(zoom);

    const onResize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      simulation?.force("center", d3.forceCenter(width / 2, height / 2));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      simulation?.stop();
    };
  });

  // code to resolve the physics w all hte bounciness
  function settleHomes() {
    nodes.forEach((node) => {
      node.homeX = node.x;
      node.homeY = node.y;
    });
    simulation
      ?.force("anchorX", d3.forceX<GraphNode>((node) => node.homeX ?? 0).strength(0.15))
      .force("anchorY", d3.forceY<GraphNode>((node) => node.homeY ?? 0).strength(0.15));
  }

  // svelte related stuff for dragging nodes
  function dragNode(el: SVGCircleElement, node: GraphNode) {
    const behavior = d3
      .drag<SVGCircleElement, GraphNode>()
      .on("start", (event) => {
        if (!event.active) simulation?.alphaTarget(0.35).restart();
        node.fx = node.x;
        node.fy = node.y;
      })
      .on("drag", (event) => {
        node.fx = event.x;
        node.fy = event.y;
      })
      .on("end", (event) => {
        if (!event.active) simulation?.alphaTarget(0);
        node.fx = null;
        node.fy = null;
      });
    d3.select<SVGCircleElement, GraphNode>(el).datum(node).call(behavior);
    return {
      destroy() {
        d3.select(el).on(".drag", null);
      }
    };
  }

  function toggleMotif(id: string) {
    const next = new Set(isolatedMotifs);
    next.has(id) ? next.delete(id) : next.add(id);
    isolatedMotifs = next;
  }

  function openSong(node: GraphNode) {
    panelContent = { type: "song", data: node };
  }
  function openMotif(motif: Motif) {
    panelContent = { type: "motif", data: motif };
  }
  function closePanel() {
    panelContent = null;
  }

  function closePanelOnClick(el: SVGSVGElement) {
    el.addEventListener("click", closePanel);
    return {
      destroy() {
        el.removeEventListener("click", closePanel);
      }
    };
  }

  function activateWithKeyboard(event: KeyboardEvent, callback: () => void) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    callback();
  }
</script>

<div class="atlas">
  <header>
    <h1>DELTARUNE LEITMOTIF ATLAS</h1>
    <p>work in progress obv</p>
  </header>

  <div class="legend">
    {#each motifData as m (m.id)}
      <button
        class="chip"
        class:dimmed={isolatedMotifs.size > 0 && !isolatedMotifs.has(m.id)}
        onclick={() => toggleMotif(m.id)}
      >
        <span class="dot" style:background={m.color}></span>
        {m.name}
      </button>
    {/each}
  </div>

  <svg
    bind:this={svgEl}
    viewBox="0 0 {width} {height}"
    use:closePanelOnClick
  >
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
              event.stopPropagation();
              openMotif(motif);
            }}
            onkeydown={(event) => activateWithKeyboard(event, () => openMotif(motif))}
            onmouseenter={() => (hoveredMotif = motif.id)}
            onmouseleave={() => (hoveredMotif = null)}
          />
        {/each}

        {#each resolvedLinks as link (link.source.id + "-" + link.target.id + "-" + link.motif)}
          {@const start = edgePoint(link.source, link.target, 11)}
          {@const end = edgePoint(link.target, link.source, 14)}
          <line
            x1={start.x}
            y1={start.y}
            x2={end.x}
            y2={end.y}
            stroke={link.color}
            stroke-width="1.4"
            opacity={linkOpacity(link)}
            marker-end="url(#arrow-{link.motif})"
          />
        {/each}

        {#each nodes as node (node.id)}
          {#each getSourceMotifs(node.id) as m, i (m.id)}
            <circle
              cx={node.x}
              cy={node.y}
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
            cx={node.x}
            cy={node.y}
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
              event.stopPropagation();
              openSong(node);
            }}
            onkeydown={(event) => activateWithKeyboard(event, () => openSong(node))}
            onmouseenter={() => (hoveredSong = node.id)}
            onmouseleave={() => (hoveredSong = null)}
          />
          <text
            x={node.x}
            y={(node.y ?? 0) - 14}
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
          <h3>{m.source === panelContent.data.id ? "Source of" : "Derives from"}</h3>
          <div class="motif-row"><span class="dot" style:background={m.color}></span>{m.name}</div>
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

  <p class="hint">drag songs to rearrange - click a song or a bubble for details - click a legend chip to get a theme</p>
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
