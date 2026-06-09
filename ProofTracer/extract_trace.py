from __future__ import annotations

from pathlib import Path
import argparse
import subprocess
import sys

from instrument_lean import instrument


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Instrument a Lean file with trace_step and run Lean to emit trace.jsonl."
    )
    parser.add_argument("input", type=Path, help="Original Lean source file")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path("InstrumentedInput.lean"),
        help="Path for the generated instrumented Lean file",
    )
    parser.add_argument(
        "--trace-file",
        type=Path,
        default=Path("trace.jsonl"),
        help="Path of the trace file emitted by Lean",
    )
    parser.add_argument(
        "--lake-root",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="Lean package root where `lake env lean` should run",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    lake_root = args.lake_root.resolve()
    output_path = args.output if args.output.is_absolute() else lake_root / args.output
    trace_path = args.trace_file if args.trace_file.is_absolute() else lake_root / args.trace_file

    source = args.input.read_text()
    output_path.write_text(instrument(source))

    if trace_path.exists():
        trace_path.unlink()

    subprocess.run(
        ["lake", "env", "lean", str(output_path.name)],
        cwd=lake_root,
        check=True,
    )

    print(f"Instrumented file: {output_path}")
    print(f"Trace file: {trace_path}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        print(f"Lean execution failed with exit code {exc.returncode}", file=sys.stderr)
        raise SystemExit(exc.returncode)
