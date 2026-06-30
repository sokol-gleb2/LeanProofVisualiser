from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_TRACE_PATH = Path(__file__).resolve().parent.parent / "ProofTracer" / "trace.jsonl"
DEFAULT_OUTPUT_PATH = Path(__file__).resolve().parent / "proof_dag.json"
DEFAULT_METADATA_PATH = (
    Path(__file__).resolve().parent.parent / "ProofTracer" / "trace.metadata.json"
)


@dataclass(frozen=True)
class Hypothesis:
    userName: str
    type: str


@dataclass(frozen=True)
class GoalSnapshot:
    goalId: str
    target: str
    context: list[Hypothesis]

    @property
    def label(self) -> str:
        return self.target


@dataclass(frozen=True)
class ProofStateSnapshot:
    goals: list[GoalSnapshot]


@dataclass(frozen=True)
class ProofStep:
    preState: ProofStateSnapshot
    tactic: str
    tacticText: str
    tacticKind: str
    postState: ProofStateSnapshot


@dataclass(frozen=True)
class DeclarationHeader:
    kind: str
    name: str
    statement: str
    header: str
    startLine: int
    endLine: int


@dataclass
class GraphNode:
    id: str
    kind: str
    label: str
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class GraphEdge:
    source: str
    target: str
    kind: str
    data: dict[str, Any] = field(default_factory=dict)


def _parse_hypothesis(raw: dict[str, Any]) -> Hypothesis:
    return Hypothesis(
        userName=str(raw["userName"]),
        type=str(raw["type"]),
    )


def _parse_goal(raw: dict[str, Any]) -> GoalSnapshot:
    return GoalSnapshot(
        goalId=str(raw["goalId"]),
        target=str(raw["target"]),
        context=[_parse_hypothesis(item) for item in raw.get("context", [])],
    )


def _parse_state(raw: dict[str, Any]) -> ProofStateSnapshot:
    return ProofStateSnapshot(
        goals=[_parse_goal(item) for item in raw.get("goals", [])],
    )


def _parse_step(raw: dict[str, Any]) -> ProofStep:
    return ProofStep(
        preState=_parse_state(raw["preState"]),
        tactic=str(raw["tactic"]),
        tacticText=str(raw["tacticText"]),
        tacticKind=str(raw["tacticKind"]),
        postState=_parse_state(raw["postState"]),
    )


def load_metadata(path: str | Path) -> dict[str, Any]:
    metadata_path = Path(path)
    with metadata_path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)

    declarations = [
        DeclarationHeader(
            kind=str(item["kind"]),
            name=str(item["name"]),
            statement=str(item["statement"]),
            header=str(item["header"]),
            startLine=int(item["startLine"]),
            endLine=int(item["endLine"]),
        )
        for item in payload.get("declarations", [])
    ]
    return {
        "sourcePath": payload.get("sourcePath"),
        "declarations": declarations,
    }


def load_trace(path: str | Path) -> list[ProofStep]:
    trace_path = Path(path)
    steps: list[ProofStep] = []

    with trace_path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                payload = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"Invalid JSON in {trace_path} at line {line_number}"
                ) from exc
            steps.append(_parse_step(payload))

    return steps


def _goal_to_data(goal: GoalSnapshot) -> dict[str, Any]:
    return {
        "goalId": goal.goalId,
        "target": goal.target,
        "context": [asdict(hyp) for hyp in goal.context],
    }


def _add_goal_node(nodes: dict[str, GraphNode], goal: GoalSnapshot) -> None:
    if goal.goalId in nodes:
        return
    nodes[goal.goalId] = GraphNode(
        id=goal.goalId,
        kind="goal",
        label=goal.label,
        data=_goal_to_data(goal),
    )


def _make_terminal_node(goal_id: str, status: str) -> GraphNode:
    return GraphNode(
        id=f"{goal_id}:{status}",
        kind="terminal",
        label=status,
        data={"goalId": goal_id, "status": status},
    )


def infer_root_step_indices(steps: list[ProofStep]) -> list[int]:
    seen_goal_ids: set[str] = set()
    root_indices: list[int] = []

    for index, step in enumerate(steps):
        if not step.preState.goals:
            continue
        focused_goal_id = step.preState.goals[0].goalId
        if focused_goal_id not in seen_goal_ids:
            root_indices.append(index)
        seen_goal_ids.update(goal.goalId for goal in step.preState.goals)
        seen_goal_ids.update(goal.goalId for goal in step.postState.goals)

    return root_indices


def build_proof_dag(
    steps: list[ProofStep],
    declarations: list[DeclarationHeader] | None = None,
    source_path: str | None = None,
) -> dict[str, Any]:
    nodes: dict[str, GraphNode] = {}
    edges: list[GraphEdge] = []
    root_goal_ids: list[str] = []
    solved_goal_ids: set[str] = set()
    expanded_goal_ids: set[str] = set()
    declaration_payloads: list[dict[str, Any]] = []
    declaration_by_root_goal_id: dict[str, dict[str, Any]] = {}
    inferred_root_indices = set(infer_root_step_indices(steps))

    if declarations:
        for declaration, step_index in zip(declarations, sorted(inferred_root_indices)):
            if step_index >= len(steps) or not steps[step_index].preState.goals:
                continue
            root_goal_id = steps[step_index].preState.goals[0].goalId
            payload = {
                **asdict(declaration),
                "rootGoalId": root_goal_id,
                "stepIndex": step_index,
            }
            declaration_payloads.append(payload)
            declaration_by_root_goal_id[root_goal_id] = payload

    for index, step in enumerate(steps):
        if not step.preState.goals:
            raise ValueError(f"Step {index} has no pre-state goals.")

        focused_goal = step.preState.goals[0]
        tactic_id = f"tactic:{index}"
        pre_goal_ids = [goal.goalId for goal in step.preState.goals]
        post_goal_ids = [goal.goalId for goal in step.postState.goals]
        post_goal_id_set = set(post_goal_ids)

        for goal in step.preState.goals:
            _add_goal_node(nodes, goal)
        for goal in step.postState.goals:
            _add_goal_node(nodes, goal)

        if index in inferred_root_indices:
            root_goal_ids.append(focused_goal.goalId)

        if focused_goal.goalId in declaration_by_root_goal_id:
            nodes[focused_goal.goalId].data["declaration"] = declaration_by_root_goal_id[
                focused_goal.goalId
            ]

        nodes[tactic_id] = GraphNode(
            id=tactic_id,
            kind="tactic",
            label=step.tacticText,
            data={
                "stepIndex": index,
                "tacticText": step.tacticText,
                "tacticKind": step.tacticKind,
                "rawTactic": step.tactic,
                "focusedGoalId": focused_goal.goalId,
                "preGoals": pre_goal_ids,
                "postGoals": post_goal_ids,
            },
        )

        edges.append(
            GraphEdge(
                source=focused_goal.goalId,
                target=tactic_id,
                kind="applies",
                data={"stepIndex": index},
            )
        )

        new_child_goals = [
            goal for goal in step.postState.goals if goal.goalId not in pre_goal_ids
        ]

        if new_child_goals:
            expanded_goal_ids.add(focused_goal.goalId)
            for child_position, goal in enumerate(new_child_goals):
                edges.append(
                    GraphEdge(
                        source=tactic_id,
                        target=goal.goalId,
                        kind="produces",
                        data={
                            "stepIndex": index,
                            "childIndex": child_position,
                        },
                    )
                )
        elif focused_goal.goalId not in post_goal_id_set:
            solved_goal_ids.add(focused_goal.goalId)
            terminal = _make_terminal_node(focused_goal.goalId, "solved")
            nodes[terminal.id] = terminal
            edges.append(
                GraphEdge(
                    source=tactic_id,
                    target=terminal.id,
                    kind="resolves",
                    data={"stepIndex": index},
                )
            )
        else:
            edges.append(
                GraphEdge(
                    source=tactic_id,
                    target=focused_goal.goalId,
                    kind="transforms",
                    data={"stepIndex": index},
                )
            )

    root_goal_ids = list(dict.fromkeys(root_goal_ids))
    leaf_goal_ids = sorted(
        node_id
        for node_id, node in nodes.items()
        if node.kind == "goal" and node_id not in expanded_goal_ids
    )
    open_leaf_goal_ids = sorted(
        goal_id for goal_id in leaf_goal_ids if goal_id not in solved_goal_ids
    )

    return {
        "metadata": {
            "nodeCount": len(nodes),
            "edgeCount": len(edges),
            "stepCount": len(steps),
            "rootGoalIds": root_goal_ids,
            "leafGoalIds": leaf_goal_ids,
            "openLeafGoalIds": open_leaf_goal_ids,
            "solvedGoalIds": sorted(solved_goal_ids),
            "sourcePath": source_path,
            "declarations": declaration_payloads,
            "primaryDeclaration": declaration_payloads[0] if declaration_payloads else None,
        },
        "nodes": [asdict(node) for node in nodes.values()],
        "edges": [asdict(edge) for edge in edges],
    }


def trace_to_dag(
    trace_path: str | Path,
    metadata_path: str | Path | None = None,
) -> dict[str, Any]:
    metadata: dict[str, Any] | None = None
    if metadata_path is not None:
        candidate = Path(metadata_path)
        if candidate.exists():
            metadata = load_metadata(candidate)

    return build_proof_dag(
        load_trace(trace_path),
        declarations=metadata["declarations"] if metadata else None,
        source_path=metadata["sourcePath"] if metadata else None,
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert a Lean proof trace JSONL file into a DAG JSON."
    )
    parser.add_argument(
        "trace_path",
        nargs="?",
        default=str(DEFAULT_TRACE_PATH),
        help="Path to the input trace.jsonl file.",
    )
    parser.add_argument(
        "-o",
        "--output",
        default=str(DEFAULT_OUTPUT_PATH),
        help="Path to write the DAG JSON output.",
    )
    parser.add_argument(
        "--metadata",
        default=str(DEFAULT_METADATA_PATH),
        help="Optional path to the declaration metadata JSON sidecar.",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print the output JSON.",
    )
    args = parser.parse_args()

    dag = trace_to_dag(args.trace_path, metadata_path=args.metadata)
    indent = 2 if args.pretty else None
    payload = json.dumps(dag, indent=indent, ensure_ascii=False)

    output_path = Path(args.output)
    output_path.write_text(payload + "\n", encoding="utf-8")
    print(f"Saved DAG JSON to {output_path}")


if __name__ == "__main__":
    main()
