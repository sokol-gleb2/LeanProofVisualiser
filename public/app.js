const state = {
  graph: null,
  selectedNodeId: null,
  layout: null,
  activeGoalPopupId: null,
};

const dom = {
  svg: document.getElementById("graph-svg"),
  edgesLayer: document.getElementById("edges-layer"),
  nodesLayer: document.getElementById("nodes-layer"),
  theoremDetails: document.getElementById("theorem-details"),
  nodeDetails: document.getElementById("node-details"),
  traceStats: document.getElementById("trace-stats"),
  graphSummary: document.getElementById("graph-summary"),
  fileInput: document.getElementById("file-input"),
  fitViewButton: document.getElementById("fit-view-button"),
  resetViewButton: document.getElementById("reset-view-button"),
  emptyState: document.getElementById("empty-state"),
  canvasContainer: document.getElementById("canvas-container"),
  goalPopup: null,
};

const SVG_NS = "http://www.w3.org/2000/svg";
const HORIZONTAL_GAP = 32;
const VERTICAL_GAP = 56;
const PADDING_X = 28;
const PADDING_Y = 28;
const NODE_PADDING_X = 18;
const NODE_PADDING_Y = 16;
const NODE_LINE_GAP = 7;
const GOAL_RADIUS = 28;
const TACTIC_RADIUS = 22;
const GOAL_TEXT_MAX_WIDTH = 320;
const TACTIC_TEXT_MAX_WIDTH = 240;
const TERMINAL_TEXT_MAX_WIDTH = 180;
const TITLE_FONT = '700 14px "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif';
const SUBTITLE_FONT = '12px "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif';
const TITLE_LINE_HEIGHT = 18;
const SUBTITLE_LINE_HEIGHT = 15;

document.addEventListener("DOMContentLoaded", () => {
  wireControls();
  loadDefaultGraph();
});

function wireControls() {
  dom.fileInput.addEventListener("change", handleFileInput);
  dom.fitViewButton.addEventListener("click", fitToView);
  dom.resetViewButton.addEventListener("click", resetView);

  dom.goalPopup = createGoalPopup();
  document.body.appendChild(dom.goalPopup);
  document.addEventListener("click", handleDocumentClick);
  dom.nodeDetails.addEventListener("click", handleGoalReferenceClick);
  dom.traceStats.addEventListener("click", handleGoalReferenceClick);
  dom.theoremDetails.addEventListener("click", handleGoalReferenceClick);
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
  renderTheoremDetails(graph);
  renderStats(graph);
  renderNodeDetails(null);
  hideEmptyState();
  fitToView();
}

function computeLayout(graph) {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const sizeById = new Map(graph.nodes.map((node) => [node.id, computeNodeSize(node)]));
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

  const layerBuckets = new Map();
  for (const node of graph.nodes) {
    const layer = layerById.get(node.id) || 0;
    if (!layerBuckets.has(layer)) {
      layerBuckets.set(layer, []);
    }
    layerBuckets.get(layer).push(node);
  }

  for (const bucket of layerBuckets.values()) {
    bucket.sort(compareNodes);
  }

  const sortedLayers = [...layerBuckets.keys()].sort((a, b) => a - b);
  const layerMetrics = sortedLayers.map((layer) => {
    const bucket = layerBuckets.get(layer) || [];
    const width =
      bucket.reduce((sum, node) => sum + (sizeById.get(node.id)?.width || 0), 0) +
      Math.max(0, bucket.length - 1) * HORIZONTAL_GAP;
    const height = bucket.reduce(
      (max, node) => Math.max(max, sizeById.get(node.id)?.height || 0),
      0
    );

    return { layer, bucket, width, height };
  });

  const contentWidth = layerMetrics.reduce((max, layer) => Math.max(max, layer.width), 0);
  const contentHeight =
    layerMetrics.reduce((sum, layer) => sum + layer.height, 0) +
    Math.max(0, layerMetrics.length - 1) * VERTICAL_GAP;
  const positions = new Map();
  let currentY = PADDING_Y;

  for (const layer of layerMetrics) {
    let currentX = PADDING_X + (contentWidth - layer.width) / 2;
    layer.bucket.forEach((node, index) => {
      const size = sizeById.get(node.id);
      if (!size) {
        return;
      }
      positions.set(node.id, {
        x: currentX,
        y: currentY + (layer.height - size.height) / 2,
        width: size.width,
        height: size.height,
        layer: layer.layer,
        row: index,
      });
      currentX += size.width + HORIZONTAL_GAP;
    });
    currentY += layer.height + VERTICAL_GAP;
  }

  const width = PADDING_X * 2 + Math.max(contentWidth, 0);
  const height = PADDING_Y * 2 + Math.max(contentHeight, 0);

  return {
    nodesById,
    sizeById,
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

function renderGraph() {
  const graph = state.graph;
  const layout = state.layout;
  if (!graph || !layout) {
    return;
  }

  dom.edgesLayer.replaceChildren();
  dom.nodesLayer.replaceChildren();
  dom.svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  dom.svg.setAttribute("width", String(layout.width));
  dom.svg.setAttribute("height", String(layout.height));

  for (const edge of graph.edges) {
    const edgeElement = buildEdgeElement(edge, layout.positions);
    dom.edgesLayer.appendChild(edgeElement);
  }

  for (const node of graph.nodes) {
    const nodeElement = buildNodeElement(node, layout.positions.get(node.id));
    dom.nodesLayer.appendChild(nodeElement);
  }

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

  const startX = source.x + source.width / 2;
  const startY = source.y + source.height;
  const endX = target.x + target.width / 2;
  const endY = target.y;
  const curve = Math.max(36, (endY - startY) * 0.45);

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute(
    "d",
    `M ${startX} ${startY} C ${startX} ${startY + curve}, ${endX} ${endY - curve}, ${endX} ${endY}`
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
      ? createRoundedRect(position.width, position.height, TACTIC_RADIUS)
      : node.kind === "terminal"
        ? createPill(position.width, position.height)
        : createRoundedRect(position.width, position.height, GOAL_RADIUS);
  shape.setAttribute("class", "node-shape");
  group.appendChild(shape);

  const title = document.createElementNS(SVG_NS, "text");
  title.setAttribute("class", "node-title");
  title.setAttribute("x", String(NODE_PADDING_X));
  title.setAttribute("y", String(NODE_PADDING_Y + TITLE_LINE_HEIGHT - 2));
  appendTextLines(title, wrapTitleLines(node), TITLE_LINE_HEIGHT);
  group.appendChild(title);

  const subtitle = document.createElementNS(SVG_NS, "text");
  subtitle.setAttribute("class", "node-subtitle");
  subtitle.setAttribute("x", String(NODE_PADDING_X));
  subtitle.setAttribute(
    "y",
    String(
      NODE_PADDING_Y +
        titleLineCount(node) * TITLE_LINE_HEIGHT +
        NODE_LINE_GAP +
        SUBTITLE_LINE_HEIGHT -
        1
    )
  );
  appendTextLines(subtitle, wrapSubtitleLines(node), SUBTITLE_LINE_HEIGHT);
  group.appendChild(subtitle);

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

function appendTextLines(element, lines, lineHeight) {
  lines.forEach((line, index) => {
    const tspan = document.createElementNS(SVG_NS, "tspan");
    if (index > 0) {
      tspan.setAttribute("x", element.getAttribute("x") || "0");
      tspan.setAttribute("dy", String(lineHeight));
    }
    tspan.textContent = line;
    element.appendChild(tspan);
  });
}

function wrapTitleLines(node) {
  return wrapText(node.label, titleMaxWidth(node), TITLE_FONT);
}

function titleMaxWidth(node) {
  if (node.kind === "goal") {
    return GOAL_TEXT_MAX_WIDTH;
  }
  if (node.kind === "tactic") {
    return TACTIC_TEXT_MAX_WIDTH;
  }
  return TERMINAL_TEXT_MAX_WIDTH;
}

function wrapSubtitleLines(node) {
  return wrapText(nodeSubtitle(node), subtitleMaxWidth(node), SUBTITLE_FONT);
}

function subtitleMaxWidth(node) {
  if (node.kind === "goal") {
    return GOAL_TEXT_MAX_WIDTH;
  }
  if (node.kind === "tactic") {
    return TACTIC_TEXT_MAX_WIDTH;
  }
  return TERMINAL_TEXT_MAX_WIDTH;
}

function titleLineCount(node) {
  return wrapTitleLines(node).length;
}

function computeNodeSize(node) {
  const titleLines = wrapTitleLines(node);
  const subtitleLines = wrapSubtitleLines(node);
  const titleWidth = maxLineWidth(titleLines, TITLE_FONT);
  const subtitleWidth = maxLineWidth(subtitleLines, SUBTITLE_FONT);
  const width = Math.ceil(
    Math.max(titleWidth, subtitleWidth, 40) + NODE_PADDING_X * 2
  );
  const height = Math.ceil(
    NODE_PADDING_Y * 2 +
      titleLines.length * TITLE_LINE_HEIGHT +
      subtitleLines.length * SUBTITLE_LINE_HEIGHT +
      NODE_LINE_GAP
  );

  return {
    width,
    height,
  };
}

function maxLineWidth(lines, font) {
  return lines.reduce((max, line) => Math.max(max, measureTextWidth(line, font)), 0);
}

function measureTextWidth(text, font) {
  const context = getTextMeasureContext();
  context.font = font;
  return context.measureText(text || "").width;
}

function getTextMeasureContext() {
  if (!getTextMeasureContext.context) {
    const canvas = document.createElement("canvas");
    getTextMeasureContext.context = canvas.getContext("2d");
  }
  return getTextMeasureContext.context;
}

function wrapText(text, maxWidth, font) {
  const source = String(text || "").trim();
  if (!source) {
    return ["—"];
  }

  const context = getTextMeasureContext();
  context.font = font;
  const words = source.split(/\s+/);
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    const trial = currentLine ? `${currentLine} ${word}` : word;
    if (context.measureText(trial).width <= maxWidth) {
      currentLine = trial;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    if (context.measureText(word).width <= maxWidth) {
      currentLine = word;
      continue;
    }

    const segments = breakLongToken(word, maxWidth, context);
    lines.push(...segments.slice(0, -1));
    currentLine = segments[segments.length - 1] || "";
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length ? lines : ["—"];
}

function breakLongToken(token, maxWidth, context) {
  const segments = [];
  let current = "";

  for (const char of token) {
    const trial = current + char;
    if (current && context.measureText(trial).width > maxWidth) {
      segments.push(current);
      current = char;
      continue;
    }
    current = trial;
  }

  if (current) {
    segments.push(current);
  }

  return segments;
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
    detailRowHtml("ID", renderNodeReference(node.id)),
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
      detailRowHtml("Goal ID", renderGoalReference(node.data?.goalId || "")),
    ]));

    if (node.data?.declaration) {
      blocks.push(detailBlock("Declaration", [
        detailRow("Kind", node.data.declaration.kind || ""),
        detailRow("Name", node.data.declaration.name || ""),
        detailRow("Statement", node.data.declaration.statement || ""),
      ]));
    }
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
      detailRowHtml("Focused Goal", renderGoalReference(node.data?.focusedGoalId || "")),
      detailRowHtml("Pre Goals", renderGoalReferenceList(node.data?.preGoals || [])),
      detailRowHtml("Post Goals", renderGoalReferenceList(node.data?.postGoals || [])),
    ]));
  }

  if (node.kind === "terminal") {
    blocks.push(detailBlock("Terminal", [
      detailRow("Status", node.data?.status || ""),
      detailRowHtml("Goal ID", renderGoalReference(node.data?.goalId || "")),
    ]));
  }

  dom.nodeDetails.innerHTML = blocks.join("");
}

function renderTheoremDetails(graph) {
  const declaration =
    graph.metadata?.primaryDeclaration ||
    (graph.metadata?.declarations || [])[0] ||
    null;

  if (!declaration) {
    const rootGoalId = (graph.metadata?.rootGoalIds || [])[0];
    const rootNode = graph.nodes.find((node) => node.id === rootGoalId);
    if (!rootNode) {
      dom.theoremDetails.innerHTML = "<p>No theorem metadata available.</p>";
      return;
    }

    dom.theoremDetails.innerHTML = [
      detailBlock("Root Goal", [
        detailRow("Target", rootNode.data?.target || ""),
        detailRowHtml("Goal ID", renderGoalReference(rootNode.data?.goalId || "")),
        detailRow("Hypotheses", String(rootNode.data?.context?.length || 0)),
      ]),
    ].join("");
    return;
  }

  const rootNode = graph.nodes.find((node) => node.id === declaration.rootGoalId);
  const blocks = [
    detailBlock("Statement", [
      detailRow("Kind", declaration.kind || ""),
      detailRow("Name", declaration.name || ""),
      detailRow("Header", declaration.header || ""),
      detailRow("Statement", declaration.statement || ""),
    ]),
  ];

  if (rootNode) {
    blocks.push(detailBlock("Initial Goal", [
      detailRow("Target", rootNode.data?.target || ""),
      detailRowHtml("Goal ID", renderGoalReference(rootNode.data?.goalId || "")),
      detailRow("Hypotheses", String(rootNode.data?.context?.length || 0)),
    ]));
  }

  const declarationCount = graph.metadata?.declarations?.length || 0;
  if (declarationCount > 1) {
    blocks.push(detailBlock("File", [
      detailRow("Declarations", String(declarationCount)),
      detailRow("Source", graph.metadata?.sourcePath || ""),
    ]));
  }

  dom.theoremDetails.innerHTML = blocks.join("");
}

function renderStats(graph) {
  const metadata = graph.metadata || {};
  dom.traceStats.innerHTML = detailBlock("Counts", [
    detailRow("Nodes", String(metadata.nodeCount ?? graph.nodes.length)),
    detailRow("Edges", String(metadata.edgeCount ?? graph.edges.length)),
    detailRow("Steps", String(metadata.stepCount ?? 0)),
    detailRow("Declarations", String((metadata.declarations || []).length)),
    detailRowHtml("Roots", renderGoalReferenceList(metadata.rootGoalIds || [])),
    detailRowHtml("Leaf Goals", renderGoalReferenceList(metadata.leafGoalIds || [])),
    detailRowHtml("Open Leaves", renderGoalReferenceList(metadata.openLeafGoalIds || [])),
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
  const theoremName = metadata.primaryDeclaration?.name;
  const theoremPrefix = theoremName ? `${theoremName}: ` : "";
  dom.graphSummary.textContent = `${theoremPrefix}${steps} tactics, ${roots} root goal${roots === 1 ? "" : "s"}, ${leaves} leaf goal${leaves === 1 ? "" : "s"}.`;
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

function detailRowHtml(label, valueMarkup) {
  return `
    <div class="detail-row">
      <div class="detail-label">${escapeHtml(label)}</div>
      <div class="detail-value">${valueMarkup || "—"}</div>
    </div>
  `;
}

function renderNodeReference(nodeId) {
  if (!nodeId) {
    return "—";
  }

  return `
    <button type="button" class="goal-ref" data-ref-kind="node" data-ref-id="${escapeHtml(nodeId)}">
      ${escapeHtml(nodeId)}
    </button>
  `;
}

function renderGoalReference(goalId) {
  if (!goalId) {
    return "—";
  }

  return `
    <button type="button" class="goal-ref" data-ref-kind="goal" data-ref-id="${escapeHtml(goalId)}">
      ${escapeHtml(goalId)}
    </button>
  `;
}

function renderGoalReferenceList(goalIds) {
  if (!goalIds.length) {
    return "None";
  }

  return `<div class="goal-ref-list">${goalIds.map((goalId) => renderGoalReference(goalId)).join("")}</div>`;
}

function handleGoalReferenceClick(event) {
  const trigger = event.target.closest("[data-ref-id]");
  if (!trigger) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  toggleReferencePopup(trigger.dataset.refKind, trigger.dataset.refId, trigger);
}

function handleDocumentClick(event) {
  if (!dom.goalPopup || dom.goalPopup.hidden) {
    return;
  }

  const clickedTrigger = event.target.closest?.("[data-ref-id]");
  if (clickedTrigger || dom.goalPopup.contains(event.target)) {
    return;
  }

  hideGoalPopup();
}

function createGoalPopup() {
  const popup = document.createElement("div");
  popup.className = "goal-popup";
  popup.hidden = true;
  return popup;
}

function toggleReferencePopup(kind, id, trigger) {
  const popupKey = `${kind}:${id}`;
  if (state.activeGoalPopupId === popupKey && !dom.goalPopup.hidden) {
    hideGoalPopup();
    return;
  }

  showReferencePopup(kind, id, trigger);
}

function showReferencePopup(kind, id, trigger) {
  const summary = describeReference(kind, id);
  dom.goalPopup.innerHTML = summary;
  dom.goalPopup.hidden = false;
  state.activeGoalPopupId = `${kind}:${id}`;
  positionGoalPopup(trigger);
}

function hideGoalPopup() {
  if (!dom.goalPopup) {
    return;
  }

  dom.goalPopup.hidden = true;
  dom.goalPopup.innerHTML = "";
  state.activeGoalPopupId = null;
}

function positionGoalPopup(trigger) {
  const rect = trigger.getBoundingClientRect();
  const popup = dom.goalPopup;
  const margin = 10;
  const maxX = window.innerWidth - popup.offsetWidth - margin;
  const preferredLeft = rect.left;
  const preferredTop = rect.bottom + margin;
  const left = Math.max(margin, Math.min(preferredLeft, maxX));
  let top = preferredTop;

  if (top + popup.offsetHeight > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - popup.offsetHeight - margin);
  }

  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

function describeReference(kind, id) {
  if (kind === "node") {
    return describeNode(id);
  }
  return describeGoal(id);
}

function describeNode(nodeId) {
  const node = state.graph?.nodes?.find((item) => item.id === nodeId);
  if (!node) {
    return `
      <div class="goal-popup-header">Node ${escapeHtml(nodeId)}</div>
      <p>No node snapshot is available for this identifier in the loaded graph.</p>
    `;
  }

  if (node.kind === "tactic") {
    const preGoals = (node.data?.preGoals || []).length;
    const postGoals = (node.data?.postGoals || []).length;
    return `
      <div class="goal-popup-header">Tactic ${escapeHtml(nodeId)}</div>
      <p>This is a tactic node running <strong>${escapeHtml(node.data?.tacticText || node.label || "—")}</strong>.</p>
      <p>Kind: ${escapeHtml(node.data?.tacticKind || "tactic")}. It starts from ${preGoals} goal${preGoals === 1 ? "" : "s"} and leads to ${postGoals} goal${postGoals === 1 ? "" : "s"}.</p>
    `;
  }

  if (node.kind === "goal") {
    return describeGoal(nodeId);
  }

  if (node.kind === "terminal") {
    return `
      <div class="goal-popup-header">Terminal ${escapeHtml(nodeId)}</div>
      <p>This is a terminal node with status <strong>${escapeHtml(node.data?.status || "unknown")}</strong>.</p>
      <p>It corresponds to goal ${escapeHtml(node.data?.goalId || "—")}.</p>
    `;
  }

  return `
    <div class="goal-popup-header">Node ${escapeHtml(nodeId)}</div>
    <p>This is a <strong>${escapeHtml(node.kind || "node")}</strong> node.</p>
  `;
}

function describeGoal(goalId) {
  const goalNode = state.graph?.nodes?.find((node) => node.kind === "goal" && node.id === goalId);
  if (goalNode) {
    const contextSize = goalNode.data?.context?.length || 0;
    return `
      <div class="goal-popup-header">Goal ${escapeHtml(goalId)}</div>
      <p>This is a goal to show <strong>${escapeHtml(goalNode.data?.target || "—")}</strong>.</p>
      <p>${contextSize} hypothesis${contextSize === 1 ? "" : "es"} are available in its local context.</p>
    `;
  }

  const terminalNode = state.graph?.nodes?.find(
    (node) => node.kind === "terminal" && node.data?.goalId === goalId
  );
  if (terminalNode) {
    return `
      <div class="goal-popup-header">Goal ${escapeHtml(goalId)}</div>
      <p>This goal has terminal status <strong>${escapeHtml(terminalNode.data?.status || "unknown")}</strong>.</p>
    `;
  }

  return `
    <div class="goal-popup-header">Goal ${escapeHtml(goalId)}</div>
    <p>No goal snapshot is available for this identifier in the loaded graph.</p>
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

function fitToView() {
  if (!state.layout) {
    return;
  }

  const containerWidth = dom.canvasContainer.clientWidth;
  dom.canvasContainer.scrollLeft = Math.max(0, (state.layout.width - containerWidth) / 2);
  dom.canvasContainer.scrollTop = 0;
}

function resetView() {
  dom.canvasContainer.scrollLeft = 0;
  dom.canvasContainer.scrollTop = 0;
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
