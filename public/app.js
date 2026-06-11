const state = {
  graph: null,
  selectedNodeId: null,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  layout: null,
  pointer: null,
};

const dom = {
  svg: document.getElementById("graph-svg"),
  viewport: document.getElementById("viewport"),
  edgesLayer: document.getElementById("edges-layer"),
  nodesLayer: document.getElementById("nodes-layer"),
  nodeDetails: document.getElementById("node-details"),
  traceStats: document.getElementById("trace-stats"),
  graphSummary: document.getElementById("graph-summary"),
  fileInput: document.getElementById("file-input"),
  fitViewButton: document.getElementById("fit-view-button"),
  resetViewButton: document.getElementById("reset-view-button"),
  emptyState: document.getElementById("empty-state"),
  canvasContainer: document.getElementById("canvas-container"),
};

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_WIDTH = 220;
const GOAL_HEIGHT = 106;
const TACTIC_HEIGHT = 82;
const TERMINAL_HEIGHT = 62;
const COLUMN_GAP = 180;
const ROW_GAP = 64;
const PADDING_X = 80;
const PADDING_Y = 70;
const MIN_SCALE = 0.35;
const MAX_SCALE = 2.4;

document.addEventListener("DOMContentLoaded", () => {
  wireControls();
  loadDefaultGraph();
});

function wireControls() {
  dom.fileInput.addEventListener("change", handleFileInput);
  dom.fitViewButton.addEventListener("click", fitToView);
  dom.resetViewButton.addEventListener("click", resetView);

  dom.svg.addEventListener("wheel", handleZoom, { passive: false });
  dom.svg.addEventListener("pointerdown", beginPan);
  dom.svg.addEventListener("pointermove", continuePan);
  dom.svg.addEventListener("pointerup", endPan);
  dom.svg.addEventListener("pointerleave", endPan);
}

async function loadDefaultGraph() {
  try {
    const response = await fetch("../ProofTreeRepresentation/proof_dag.json");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const graph = await response.json();
    applyGraph(graph);
  } catch (error) {
    showEmptyState(
      "Could not fetch proof_dag.json automatically. Load a JSON file manually or serve this folder over HTTP."
    );
    renderStatsPlaceholder();
  }
}

async function handleFileInput(event) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    const graph = JSON.parse(text);
    applyGraph(graph);
  } catch (error) {
    showEmptyState("The selected file is not valid DAG JSON.");
  }
}

function applyGraph(graph) {
  state.graph = graph;
  state.selectedNodeId = null;
  state.layout = computeLayout(graph);
  renderGraph();
  renderStats(graph);
  renderNodeDetails(null);
  hideEmptyState();
  fitToView();
}

function computeLayout(graph) {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map();
  const incomingCount = new Map();

  for (const node of graph.nodes) {
    outgoing.set(node.id, []);
    incomingCount.set(node.id, 0);
  }

  for (const edge of graph.edges) {
    outgoing.get(edge.source)?.push(edge);
    incomingCount.set(edge.target, (incomingCount.get(edge.target) || 0) + 1);
  }

  const layerById = new Map();
  const queue = [];

  for (const rootId of graph.metadata?.rootGoalIds || []) {
    if (nodesById.has(rootId)) {
      layerById.set(rootId, 0);
      queue.push(rootId);
    }
  }

  for (const node of graph.nodes) {
    if ((incomingCount.get(node.id) || 0) === 0 && !layerById.has(node.id)) {
      layerById.set(node.id, 0);
      queue.push(node.id);
    }
  }

  while (queue.length > 0) {
    const currentId = queue.shift();
    const currentLayer = layerById.get(currentId) || 0;
    for (const edge of outgoing.get(currentId) || []) {
      const nextLayer = currentLayer + 1;
      if (!layerById.has(edge.target) || nextLayer > layerById.get(edge.target)) {
        layerById.set(edge.target, nextLayer);
        queue.push(edge.target);
      }
    }
  }

  const columnBuckets = new Map();
  for (const node of graph.nodes) {
    const layer = layerById.get(node.id) || 0;
    if (!columnBuckets.has(layer)) {
      columnBuckets.set(layer, []);
    }
    columnBuckets.get(layer).push(node);
  }

  for (const bucket of columnBuckets.values()) {
    bucket.sort(compareNodes);
  }

  const positions = new Map();
  let maxLayer = 0;
  let maxRows = 0;

  for (const [layer, bucket] of columnBuckets.entries()) {
    maxLayer = Math.max(maxLayer, layer);
    maxRows = Math.max(maxRows, bucket.length);
    bucket.forEach((node, index) => {
      positions.set(node.id, {
        x: PADDING_X + layer * (NODE_WIDTH + COLUMN_GAP),
        y: PADDING_Y + index * (GOAL_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: nodeHeight(node),
        layer,
        row: index,
      });
    });
  }

  const width = PADDING_X * 2 + (maxLayer + 1) * NODE_WIDTH + maxLayer * COLUMN_GAP;
  const height =
    PADDING_Y * 2 + Math.max(1, maxRows) * (GOAL_HEIGHT + ROW_GAP) - ROW_GAP;

  return {
    nodesById,
    positions,
    width,
    height,
  };
}

function compareNodes(a, b) {
  const aPriority = nodePriority(a);
  const bPriority = nodePriority(b);
  if (aPriority !== bPriority) {
    return aPriority - bPriority;
  }

  const aStep = a.data?.stepIndex ?? Number.MAX_SAFE_INTEGER;
  const bStep = b.data?.stepIndex ?? Number.MAX_SAFE_INTEGER;
  if (aStep !== bStep) {
    return aStep - bStep;
  }

  return a.id.localeCompare(b.id);
}

function nodePriority(node) {
  if (node.kind === "goal") {
    return 0;
  }
  if (node.kind === "tactic") {
    return 1;
  }
  return 2;
}

function nodeHeight(node) {
  if (node.kind === "tactic") {
    return TACTIC_HEIGHT;
  }
  if (node.kind === "terminal") {
    return TERMINAL_HEIGHT;
  }
  return GOAL_HEIGHT;
}

function renderGraph() {
  const graph = state.graph;
  const layout = state.layout;
  if (!graph || !layout) {
    return;
  }

  dom.edgesLayer.replaceChildren();
  dom.nodesLayer.replaceChildren();
  dom.svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);

  for (const edge of graph.edges) {
    const edgeElement = buildEdgeElement(edge, layout.positions);
    dom.edgesLayer.appendChild(edgeElement);
  }

  for (const node of graph.nodes) {
    const nodeElement = buildNodeElement(node, layout.positions.get(node.id));
    dom.nodesLayer.appendChild(nodeElement);
  }

  updateViewportTransform();
  updateGraphSummary(graph);
}

function buildEdgeElement(edge, positions) {
  const source = positions.get(edge.source);
  const target = positions.get(edge.target);
  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("class", "edge");

  if (!source || !target) {
    return group;
  }

  const startX = source.x + source.width;
  const startY = source.y + source.height / 2;
  const endX = target.x;
  const endY = target.y + target.height / 2;
  const curve = Math.max(40, (endX - startX) * 0.45);

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute(
    "d",
    `M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`
  );
  path.setAttribute("class", "edge-path");
  group.appendChild(path);

  return group;
}

function buildNodeElement(node, position) {
  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("class", `node-card ${node.kind}`);
  group.dataset.nodeId = node.id;
  group.setAttribute("transform", `translate(${position.x}, ${position.y})`);

  group.addEventListener("click", () => {
    state.selectedNodeId = node.id;
    updateSelection();
    renderNodeDetails(node);
  });

  const shape =
    node.kind === "tactic"
      ? createRoundedRect(position.width, position.height, 22)
      : node.kind === "terminal"
        ? createPill(position.width, position.height)
        : createRoundedRect(position.width, position.height, 28);
  shape.setAttribute("class", "node-shape");
  group.appendChild(shape);

  const title = document.createElementNS(SVG_NS, "text");
  title.setAttribute("class", "node-title");
  title.setAttribute("x", "18");
  title.setAttribute("y", "30");
  title.textContent = truncate(node.label, node.kind === "goal" ? 30 : 24);
  group.appendChild(title);

  const subtitle = document.createElementNS(SVG_NS, "text");
  subtitle.setAttribute("class", "node-subtitle");
  subtitle.setAttribute("x", "18");
  subtitle.setAttribute("y", node.kind === "goal" ? "54" : "50");
  subtitle.textContent = nodeSubtitle(node);
  group.appendChild(subtitle);

  if (node.kind === "goal") {
    const goalIdText = document.createElementNS(SVG_NS, "text");
    goalIdText.setAttribute("class", "node-subtitle");
    goalIdText.setAttribute("x", "18");
    goalIdText.setAttribute("y", "78");
    goalIdText.textContent = truncate(node.data?.goalId || node.id, 26);
    group.appendChild(goalIdText);
  }

  return group;
}

function createRoundedRect(width, height, radius) {
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("width", width);
  rect.setAttribute("height", height);
  rect.setAttribute("rx", radius);
  rect.setAttribute("ry", radius);
  return rect;
}

function createPill(width, height) {
  return createRoundedRect(width, height, height / 2);
}

function nodeSubtitle(node) {
  if (node.kind === "goal") {
    return `${node.data?.context?.length || 0} hypotheses`;
  }
  if (node.kind === "tactic") {
    return node.data?.tacticKind || "tactic";
  }
  return node.data?.status || "terminal";
}

function updateSelection() {
  const nodeElements = dom.nodesLayer.querySelectorAll(".node-card");
  nodeElements.forEach((element) => {
    element.classList.toggle("selected", element.dataset.nodeId === state.selectedNodeId);
  });
}

function renderNodeDetails(node) {
  if (!node) {
    dom.nodeDetails.innerHTML =
      "<p>Select a node to inspect its goal, tactic, or terminal metadata.</p>";
    return;
  }

  const blocks = [];
  blocks.push(detailBlock("Summary", [
    detailRow("Kind", node.kind),
    detailRow("ID", node.id),
    detailRow("Label", node.label),
  ]));

  if (node.kind === "goal") {
    const context = node.data?.context || [];
    const contextMarkup =
      context.length === 0
        ? "<p>No local hypotheses.</p>"
        : `<div class="context-list">${context
            .map(
              (item) => `
                <div class="context-item">
                  <div class="context-name">${escapeHtml(item.userName)}</div>
                  <div class="detail-value">${escapeHtml(item.type)}</div>
                </div>
              `
            )
            .join("")}</div>`;

    blocks.push(detailBlock("Goal", [
      detailRow("Target", node.data?.target || ""),
      detailRow("Goal ID", node.data?.goalId || ""),
    ]));
    blocks.push(`
      <section class="detail-block">
        <h3>Context</h3>
        ${contextMarkup}
      </section>
    `);
  }

  if (node.kind === "tactic") {
    blocks.push(detailBlock("Tactic", [
      detailRow("Text", node.data?.tacticText || ""),
      detailRow("Kind", node.data?.tacticKind || ""),
      detailRow("Focused Goal", node.data?.focusedGoalId || ""),
      detailRow("Pre Goals", (node.data?.preGoals || []).join(", ")),
      detailRow("Post Goals", (node.data?.postGoals || []).join(", ")),
    ]));
  }

  if (node.kind === "terminal") {
    blocks.push(detailBlock("Terminal", [
      detailRow("Status", node.data?.status || ""),
      detailRow("Goal ID", node.data?.goalId || ""),
    ]));
  }

  dom.nodeDetails.innerHTML = blocks.join("");
}

function renderStats(graph) {
  const metadata = graph.metadata || {};
  dom.traceStats.innerHTML = detailBlock("Counts", [
    detailRow("Nodes", String(metadata.nodeCount ?? graph.nodes.length)),
    detailRow("Edges", String(metadata.edgeCount ?? graph.edges.length)),
    detailRow("Steps", String(metadata.stepCount ?? 0)),
    detailRow("Roots", (metadata.rootGoalIds || []).join(", ") || "None"),
    detailRow("Leaf Goals", (metadata.leafGoalIds || []).join(", ") || "None"),
    detailRow("Open Leaves", (metadata.openLeafGoalIds || []).join(", ") || "None"),
  ]);
}

function renderStatsPlaceholder() {
  dom.traceStats.innerHTML = "<p>Waiting for DAG data…</p>";
  dom.graphSummary.textContent = "No graph loaded.";
}

function updateGraphSummary(graph) {
  const metadata = graph.metadata || {};
  const roots = metadata.rootGoalIds?.length || 0;
  const leaves = metadata.leafGoalIds?.length || 0;
  const steps = metadata.stepCount ?? 0;
  dom.graphSummary.textContent = `${steps} tactics, ${roots} root goal${roots === 1 ? "" : "s"}, ${leaves} leaf goal${leaves === 1 ? "" : "s"}.`;
}

function detailBlock(title, rows) {
  return `
    <section class="detail-block">
      <h3>${escapeHtml(title)}</h3>
      <div class="detail-list">
        ${rows.join("")}
      </div>
    </section>
  `;
}

function detailRow(label, value) {
  return `
    <div class="detail-row">
      <div class="detail-label">${escapeHtml(label)}</div>
      <p class="detail-value">${escapeHtml(value || "—")}</p>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function fitToView() {
  if (!state.layout) {
    return;
  }

  const bounds = dom.canvasContainer.getBoundingClientRect();
  const padding = 36;
  const scaleX = (bounds.width - padding * 2) / state.layout.width;
  const scaleY = (bounds.height - padding * 2) / state.layout.height;
  state.scale = clamp(Math.min(scaleX, scaleY, 1), MIN_SCALE, MAX_SCALE);
  state.offsetX = (bounds.width - state.layout.width * state.scale) / 2;
  state.offsetY = (bounds.height - state.layout.height * state.scale) / 2;
  updateViewportTransform();
}

function resetView() {
  state.scale = 1;
  state.offsetX = 24;
  state.offsetY = 24;
  updateViewportTransform();
}

function updateViewportTransform() {
  dom.viewport.setAttribute(
    "transform",
    `translate(${state.offsetX} ${state.offsetY}) scale(${state.scale})`
  );
}

function handleZoom(event) {
  if (!state.layout) {
    return;
  }

  event.preventDefault();
  const delta = event.deltaY < 0 ? 1.08 : 0.92;
  const nextScale = clamp(state.scale * delta, MIN_SCALE, MAX_SCALE);
  const rect = dom.svg.getBoundingClientRect();
  const cursorX = event.clientX - rect.left;
  const cursorY = event.clientY - rect.top;
  const worldX = (cursorX - state.offsetX) / state.scale;
  const worldY = (cursorY - state.offsetY) / state.scale;

  state.scale = nextScale;
  state.offsetX = cursorX - worldX * state.scale;
  state.offsetY = cursorY - worldY * state.scale;
  updateViewportTransform();
}

function beginPan(event) {
  if (event.target.closest(".node-card")) {
    return;
  }
  state.pointer = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    baseOffsetX: state.offsetX,
    baseOffsetY: state.offsetY,
  };
  dom.svg.setPointerCapture(event.pointerId);
}

function continuePan(event) {
  if (!state.pointer || state.pointer.pointerId !== event.pointerId) {
    return;
  }

  state.offsetX = state.pointer.baseOffsetX + (event.clientX - state.pointer.startX);
  state.offsetY = state.pointer.baseOffsetY + (event.clientY - state.pointer.startY);
  updateViewportTransform();
}

function endPan(event) {
  if (!state.pointer || state.pointer.pointerId !== event.pointerId) {
    return;
  }
  dom.svg.releasePointerCapture(event.pointerId);
  state.pointer = null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function showEmptyState(message) {
  dom.emptyState.classList.remove("hidden");
  dom.emptyState.innerHTML = `
    <h3>No DAG loaded</h3>
    <p>${escapeHtml(message)}</p>
  `;
}

function hideEmptyState() {
  dom.emptyState.classList.add("hidden");
}
