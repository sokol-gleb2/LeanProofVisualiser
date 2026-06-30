from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
import re
import sys


IMPORT_LINE = "import ProofTracer.ProofTrace"
OPEN_LINE = "open ProofTrace"

BLOCK_START_RE = re.compile(r"(?<![-\w.])by\s*$")
INLINE_BY_RE = re.compile(r"^(?P<prefix>.*\bby)\s+(?P<body>.+?)\s*$")
DECL_START_RE = re.compile(r"^(theorem|lemma|example|corollary)\b")
DECL_NAME_RE = re.compile(r"^(theorem|lemma|corollary)\s+([^\s:(\[{]+)")


@dataclass
class ByBlock:
    parent_indent: int
    child_indent: int | None = None


@dataclass(frozen=True)
class DeclarationHeader:
    kind: str
    name: str
    statement: str
    header: str
    startLine: int
    endLine: int


def leading_spaces(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def is_blank_or_comment(line: str) -> bool:
    stripped = line.strip()
    return stripped == "" or stripped.startswith("--")


def starts_by_block(line: str) -> bool:
    stripped = line.strip()
    return bool(BLOCK_START_RE.search(stripped))


def bullet_prefix(stripped: str) -> tuple[str, str]:
    if not stripped.startswith("·"):
        return "", stripped

    remainder = stripped[1:].lstrip()
    if remainder == "":
        return "·", ""
    return f"·{' ' if remainder else ''}", remainder


def should_instrument_statement(stripped: str) -> bool:
    if stripped == "":
        return False
    if stripped.startswith("--"):
        return False
    if stripped.startswith("trace_step"):
        return False
    if stripped in {"by", "do"}:
        return False
    return True


def instrument_inline_by(line: str) -> str:
    if "trace_step" in line:
        return line

    match = INLINE_BY_RE.match(line)
    if not match:
        return line

    body = match.group("body").strip()
    if not should_instrument_statement(body):
        return line

    return f"{match.group('prefix')} trace_step {body}"


def ensure_imports(lines: list[str]) -> list[str]:
    has_import = any(line.strip() == IMPORT_LINE for line in lines)
    has_open = any(line.strip() == OPEN_LINE for line in lines)

    if has_import and has_open:
        return list(lines)

    output: list[str] = []
    inserted = False

    for i, line in enumerate(lines):
        output.append(line)
        if inserted:
            continue

        if not line.strip().startswith("import "):
            continue

        next_is_import = i + 1 < len(lines) and lines[i + 1].strip().startswith("import ")
        if next_is_import:
            continue

        if not has_import:
            output.append(IMPORT_LINE)
        output.append("")
        if not has_open:
            output.append(OPEN_LINE)
        inserted = True

    if inserted:
        return output

    prefix: list[str] = []
    if not has_import:
        prefix.append(IMPORT_LINE)
    if not has_open:
        prefix.append(OPEN_LINE)
    if prefix:
        prefix.append("")
    return prefix + output


def _normalise_header_text(lines: list[str]) -> str:
    joined = " ".join(line.strip() for line in lines if line.strip())
    return re.sub(r"\s+", " ", joined).strip()


def _parse_declaration_header(header_lines: list[str], start_line: int, end_line: int) -> DeclarationHeader | None:
    header = _normalise_header_text(header_lines)
    if not header:
        return None

    header = re.sub(r"\s*:=\s*by\s*$", "", header)
    header = re.sub(r"\s+$", "", header)

    kind_match = DECL_START_RE.match(header)
    if not kind_match:
        return None

    kind = kind_match.group(1)
    name = "anonymous"
    name_match = DECL_NAME_RE.match(header)
    if name_match:
        name = name_match.group(2)

    statement = header[len(kind) :].strip()
    if name != "anonymous" and statement.startswith(name):
        statement = statement[len(name) :].strip()

    return DeclarationHeader(
        kind=kind,
        name=name,
        statement=statement,
        header=header,
        startLine=start_line,
        endLine=end_line,
    )


def extract_declarations(source: str) -> list[DeclarationHeader]:
    lines = source.splitlines()
    declarations: list[DeclarationHeader] = []
    pending_lines: list[str] = []
    pending_start: int | None = None

    for line_number, line in enumerate(lines, start=1):
        stripped = line.strip()

        if pending_lines:
            pending_lines.append(line)
            if stripped.endswith(":= by"):
                parsed = _parse_declaration_header(pending_lines, pending_start or line_number, line_number)
                if parsed is not None:
                    declarations.append(parsed)
                pending_lines = []
                pending_start = None
            continue

        if leading_spaces(line) != 0:
            continue
        if stripped.startswith("--") or stripped == "":
            continue
        if not DECL_START_RE.match(stripped):
            continue

        pending_lines = [line]
        pending_start = line_number
        if stripped.endswith(":= by"):
            parsed = _parse_declaration_header(pending_lines, pending_start, line_number)
            if parsed is not None:
                declarations.append(parsed)
            pending_lines = []
            pending_start = None

    return declarations


def extract_declarations_payload(source: str) -> list[dict[str, object]]:
    return [asdict(declaration) for declaration in extract_declarations(source)]


def instrument(source: str) -> str:
    lines = ensure_imports(source.splitlines())
    output: list[str] = []
    block_stack: list[ByBlock] = []

    for line in lines:
        indent = leading_spaces(line)
        stripped = line.strip()

        while block_stack:
            block = block_stack[-1]
            if is_blank_or_comment(line):
                break
            if indent <= block.parent_indent:
                block_stack.pop()
                continue
            break

        if starts_by_block(line) and not stripped.startswith("--"):
            output.append(instrument_inline_by(line))
            block_stack.append(ByBlock(parent_indent=indent))
            continue

        if not block_stack:
            output.append(line)
            continue

        if is_blank_or_comment(line):
            output.append(line)
            continue

        current_block = block_stack[-1]

        if current_block.child_indent is None:
            if indent <= current_block.parent_indent:
                output.append(line)
                continue
            current_block.child_indent = indent

        if indent != current_block.child_indent:
            output.append(line)
            continue

        bullet, statement = bullet_prefix(stripped)
        if not should_instrument_statement(statement):
            output.append(line)
            continue

        prefix = " " * indent
        if bullet:
            output.append(f"{prefix}{bullet} trace_step {statement}")
        else:
            output.append(f"{prefix}trace_step {statement}")

    return "\n".join(output) + "\n"


def main() -> None:
    if len(sys.argv) != 3:
        print("Usage: python instrument_lean.py input.lean output.lean")
        raise SystemExit(1)

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])

    source = input_path.read_text()
    output_path.write_text(instrument(source))

    print(f"Wrote instrumented file to {output_path}")


if __name__ == "__main__":
    main()
