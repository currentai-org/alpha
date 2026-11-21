"""The readable text of one PDF, Word or Excel file, for the artifacts screen.

Runs as its own short-lived process, never inside the app: the agent wrote the file, a prompt can steer
the agent, and a crafted document is a known way to make a parser hang or exhaust memory (most of pypdf's
own advisories are exactly that). `app._extract_document_text` sends the bytes on stdin and reads UTF-8
text from stdout. Any failure is a non-zero exit, which the app treats as a file it could not screen,
unless `app._document_text` takes exit 3 or 4 to mean the bytes only mention a PDF header.

The memory and CPU limits are set before any parser is imported, so they hold for the parser's whole run.

    python -I -B doc_text.py <pdf|docx|xlsx> <max_chars> <max_memory_bytes> <max_cpu_secs>  < file
"""

from __future__ import annotations

import io
import logging
import resource
import sys
import warnings


def _limit(max_memory: int, max_cpu_secs: int) -> None:
    for which, value in ((resource.RLIMIT_AS, max_memory), (resource.RLIMIT_CPU, max_cpu_secs),
                         (resource.RLIMIT_CORE, 0)):
        try:
            resource.setrlimit(which, (value, value))
        except (ValueError, OSError):
            pass  # macOS refuses RLIMIT_AS; the app's wall-clock timeout still bounds the run there


class NotAPdf(Exception):
    """pypdf could not open the bytes as a PDF at all (exit 3), as opposed to a PDF it could not read."""


class PdfUnparsable(Exception):
    """pypdf failed while opening or reading the bytes with any other error (exit 4): a broken PDF, or text
    that only looks like one. The app tells them apart by whether the bytes decode as text."""


class _Full(Exception):
    """The text reached its cap. Reading stops there, so a long ordinary file costs no more than its cap."""


class _Text:
    def __init__(self, cap: int):
        self.lines: list[str] = []
        self.size, self.cap = 0, cap

    def add(self, line: str) -> None:
        if line.strip():
            self.lines.append(line)
            self.size += len(line) + 1
            if self.size >= self.cap:
                raise _Full

    def value(self) -> str:
        return "\n".join(self.lines)[: self.cap]


def _pdf(data: bytes, out: _Text) -> None:
    from pypdf import PdfReader
    from pypdf.errors import PyPdfError

    try:
        reader = PdfReader(io.BytesIO(data))
    except PyPdfError as e:   # pypdf's own verdict only: a MemoryError or a timeout here is no such answer
        raise NotAPdf(type(e).__name__) from e
    except MemoryError:
        raise
    except Exception as e:  # a ValueError, KeyError or TypeError from bytes pypdf misparsed
        raise PdfUnparsable(type(e).__name__) from e
    # An empty user password is the common "no editing" protection, and opens. Anything else needs a
    # password nobody gave us, so the text cannot be screened and the file must not pass as if it had been.
    if reader.is_encrypted and not reader.decrypt(""):
        raise PermissionError("encrypted with a password")
    try:
        for page in reader.pages:
            out.add(page.extract_text() or "")
    except (_Full, MemoryError):
        raise
    except Exception as e:  # pypdf found no page tree it could read in what it opened
        raise PdfUnparsable(type(e).__name__) from e


# The main part of a Word document, a macro-enabled one (.docm), a template (.dotx) and a macro-enabled
# template (.dotm). `docx.Document` accepts only the first, but the body is the same WordprocessingML in all
# four, so the package is opened directly and its main part's content type checked against these.
_WORD_MAIN_PARTS = frozenset({
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    "application/vnd.ms-word.document.macroEnabled.main+xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
    "application/vnd.ms-word.template.macroEnabledTemplate.main+xml",
})


def _docx(data: bytes, out: _Text) -> None:
    from docx.oxml.ns import qn
    from docx.oxml.parser import parse_xml
    from docx.package import Package

    p_tag, t_tag, breaks = qn("w:p"), qn("w:t"), (qn("w:tab"), qn("w:br"))
    package = Package.open(io.BytesIO(data))
    content_type = package.main_document_part.content_type
    if content_type not in _WORD_MAIN_PARTS:
        raise ValueError(f"not a Word file, content type is {content_type[:64]!r}")
    # Every XML part the package reaches, not only the body: headers, footers, footnotes and comments are
    # text a reader sees too, and no part's directory is fixed. python-docx loads some of them (footnotes,
    # endnotes) as plain blobs, so those are parsed here. Walking runs in document order keeps text-box
    # paragraphs nested inside a paragraph from being read twice.
    for part in package.iter_parts():
        element = getattr(part, "element", None)
        if element is None:
            if not part.content_type.endswith("xml"):
                continue                            # images, a macro project and other binary parts: never run
            element = parse_xml(part.blob)
        paragraph: list[str] = []
        for el in element.iter(p_tag, t_tag, *breaks):
            if el.tag == p_tag:
                out.add("".join(paragraph))
                paragraph = []
            else:
                paragraph.append((el.text or "") if el.tag == t_tag else " ")
        out.add("".join(paragraph))


def _xlsx(data: bytes, out: _Text) -> None:
    import openpyxl

    # Sheet names, every cell, and the cached value of each formula. openpyxl writes formulas with no
    # cached value, so the formula is the only place text built with one (="…" & "…") exists; a viewer that
    # does not recalculate shows the cached value instead, which can differ from anything the formula spells
    # out. The cached values take a second read, so only a workbook with formulas pays for it.
    formulas: dict[int, dict[int, set[int]]] = {}         # sheet -> row -> columns holding a formula
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=False)
    try:
        for name in wb.sheetnames:
            out.add(name)
        for s, ws in enumerate(wb.worksheets):
            ws.reset_dimensions()   # a declared A1:XFD1048576 would otherwise pad every row to 16,384 cells
            for r, row in enumerate(ws.iter_rows(values_only=True)):
                shown = [_cell_text(v) for v in row]
                out.add("\t".join(t for t in shown if t is not None))
                cols = {c for c, t in enumerate(shown) if t is not None and t.startswith("=")}
                if cols:
                    formulas.setdefault(s, {})[r] = cols
    finally:
        wb.close()
    if not formulas:
        return
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        for s, ws in enumerate(wb.worksheets):
            rows = formulas.get(s)
            if not rows:
                continue
            ws.reset_dimensions()
            last = max(rows)
            for r, row in enumerate(ws.iter_rows(values_only=True)):
                if r in rows:
                    out.add("\t".join(str(row[c]) for c in sorted(rows[r]) if c < len(row) and row[c] is not None))
                if r >= last:
                    break
    finally:
        wb.close()


def _cell_text(value: object) -> str | None:
    """A cell as text. An array formula comes back as an object whose formula is its `text`."""
    if value is None:
        return None
    text = getattr(value, "text", None)
    return text if isinstance(text, str) else str(value)


_READERS = {"pdf": _pdf, "docx": _docx, "xlsx": _xlsx}


def main() -> int:
    kind, max_chars, max_memory, max_cpu_secs = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
    _limit(max_memory, max_cpu_secs)
    # A malformed file makes pypdf log a warning per object; that is stderr the app would have to buffer.
    logging.disable(logging.CRITICAL)
    warnings.simplefilter("ignore")
    out = _Text(max_chars)
    try:
        try:
            _READERS[kind](sys.stdin.buffer.read(), out)
        except _Full:
            pass
        sys.stdout.buffer.write(out.value().encode("utf-8", "replace"))
    except NotAPdf as e:
        sys.stderr.write(f"NotAPdf:{e}"[:64])
        return 3
    except PdfUnparsable as e:
        sys.stderr.write(f"PdfUnparsable:{e}"[:64])
        return 4
    except BaseException as e:  # noqa: BLE001 — MemoryError included; the app only needs to know it failed
        sys.stderr.write(type(e).__name__[:64])
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
