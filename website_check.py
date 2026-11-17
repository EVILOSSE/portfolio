#!/usr/bin/env python3
"""Read saved HTML and produce bounded, static website diagnostics."""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import asdict, dataclass, field
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit


@dataclass
class Element:
    tag: str
    attrs: dict[str, str]
    line: int
    text: list[str] = field(default_factory=list)
    hidden: bool = False


@dataclass
class Finding:
    rule: str
    severity: str
    line: int
    message: str


class Document(HTMLParser):
    VOID = {
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "param", "source", "track", "wbr",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.elements: list[Element] = []
        self.stack: list[Element] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name: value or "" for name, value in attrs}
        hidden = (
            "hidden" in values
            or values.get("aria-hidden", "").lower() == "true"
            or any(parent.hidden for parent in self.stack)
        )
        element = Element(tag, values, self.getpos()[0], hidden=hidden)
        self.elements.append(element)
        if tag not in self.VOID:
            self.stack.append(element)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, text: str) -> None:
        if any(parent.tag in {"script", "style", "template"} for parent in self.stack):
            return
        if any(parent.hidden for parent in self.stack):
            return
        for parent in self.stack:
            parent.text.append(text)

    def text_of(self, element: Element) -> str:
        return " ".join("".join(element.text).split())

    def has_name(self, element: Element) -> bool:
        if element.attrs.get("aria-label", "").strip():
            return True
        labelled_by = element.attrs.get("aria-labelledby", "").split()
        if labelled_by:
            references = {
                item.attrs["id"]: item
                for item in self.elements
                if item.attrs.get("id")
            }
            if any(ref in references and self.text_of(references[ref]) for ref in labelled_by):
                return True
        if self.text_of(element):
            return True
        # Images and SVG titles may provide an otherwise textless control's name.
        for child in self.elements:
            if child.tag == "img" and child.attrs.get("alt", "").strip():
                # HTMLParser does not give DOM ranges; use a parent reference stored below.
                if element in getattr(child, "parents", ()):
                    return True
        return False


class NamedDocument(Document):
    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        parents = tuple(self.stack)
        super().handle_starttag(tag, attrs)
        self.elements[-1].parents = parents


def analyse_html(source: str, filename: str = "page.html", site_root: Path | None = None) -> dict:
    document = NamedDocument()
    document.feed(source)
    findings: list[Finding] = []

    def flag(rule: str, severity: str, line: int, message: str) -> None:
        findings.append(Finding(rule, severity, line, message))

    html = next((item for item in document.elements if item.tag == "html"), None)
    if not html or not html.attrs.get("lang", "").strip():
        flag("language", "review", html.line if html else 1, "Declare the document language on the html element.")

    titles = [item for item in document.elements if item.tag == "title"]
    if not titles or not any(document.text_of(item) for item in titles):
        flag("title", "review", 1, "Provide a nonempty page title.")
    elif len(titles) > 1:
        flag("title", "review", titles[1].line, "More than one page title is present.")

    viewport = [
        item for item in document.elements
        if item.tag == "meta" and item.attrs.get("name", "").lower() == "viewport"
    ]
    if not viewport:
        flag("viewport", "review", 1, "No viewport meta tag was found; check the mobile layout.")
    else:
        for item in viewport:
            content = item.attrs.get("content", "").lower()
            if re.search(r"user-scalable\s*=\s*(no|0)(?:\s*[,;]|\s*$)", content):
                flag("zoom", "review", item.line, "The viewport disables user zoom.")
            maximum = re.search(r"maximum-scale\s*=\s*([0-9.]+)", content)
            if maximum:
                try:
                    if float(maximum.group(1)) < 2:
                        flag("zoom", "review", item.line, "The viewport restricts zoom below 2x.")
                except ValueError:
                    pass

    identifiers = Counter(item.attrs["id"] for item in document.elements if item.attrs.get("id"))
    reported_ids: set[str] = set()
    labels = {
        item.attrs["for"]
        for item in document.elements
        if item.tag == "label" and item.attrs.get("for") and document.text_of(item)
    }
    for item in document.elements:
        identifier = item.attrs.get("id")
        if identifier and identifiers[identifier] > 1 and identifier not in reported_ids:
            reported_ids.add(identifier)
            flag("duplicate-id", "error", item.line, f"The ID {identifier!r} occurs {identifiers[identifier]} times.")

        if item.tag == "img" and not item.hidden and "alt" not in item.attrs:
            flag("image-alt", "review", item.line, "An image has no alt attribute; supply meaningful text or an empty decorative alternative.")

        is_link = item.tag == "a" and "href" in item.attrs
        is_button = item.tag == "button"
        if (is_link or is_button) and not item.hidden and not document.has_name(item):
            flag("control-name", "review", item.line, f"This {item.tag} has no name detectable in saved HTML; inspect its accessible name in the browser.")

        if item.tag in {"input", "select", "textarea"} and not item.hidden:
            kind = item.attrs.get("type", "text").lower()
            if item.tag == "input" and kind in {"hidden", "submit", "reset", "button", "image"}:
                continue
            parent_label = any(
                parent.tag == "label" and document.text_of(parent)
                for parent in getattr(item, "parents", ())
            )
            aria_name = item.attrs.get("aria-label", "").strip()
            refs = item.attrs.get("aria-labelledby", "").split()
            ref_name = any(
                child.attrs.get("id") in refs and document.text_of(child)
                for child in document.elements
            )
            if not (identifier in labels or parent_label or aria_name or ref_name):
                flag("field-label", "review", item.line, "A form field has no label detectable in saved HTML; placeholder text is insufficient.")

    if site_root is not None:
        root = site_root.resolve()
        current = (root / filename).resolve()
        for item in document.elements:
            attribute = "src" if item.tag in {"img", "script", "source", "video", "audio"} else "href" if item.tag == "link" else None
            if attribute is None:
                continue
            reference = item.attrs.get(attribute, "").strip()
            url = urlsplit(reference)
            if not reference or url.scheme or url.netloc or not url.path:
                continue
            if any(parent.tag == "base" for parent in document.elements):
                # A base URL changes path resolution; avoid pretending relative references are verified.
                continue
            relative = unquote(url.path).replace("\\", "/")
            candidate = (root / relative.lstrip("/")) if relative.startswith("/") else current.parent / relative
            candidate = candidate.resolve()
            try:
                candidate.relative_to(root)
            except ValueError:
                flag("asset-path", "review", item.line, "A resource path resolves outside the selected site root; it was not read.")
                continue
            if not candidate.exists():
                flag("missing-asset", "error", item.line, f"Local resource not found: {reference}")

    counts = Counter(item.rule for item in findings)
    return {
        "file": filename,
        "title": document.text_of(titles[0]) if titles else "",
        "element_count": len(document.elements),
        "finding_count": len(findings),
        "rules": dict(sorted(counts.items())),
        "findings": [asdict(item) for item in findings],
        "limitations": [
            "Static saved-HTML inspection only; JavaScript was not executed.",
            "Findings require contextual review; zero findings is not accessibility conformance.",
            "No visual, keyboard, screen-reader, network, performance, or payment-flow verification.",
            "No CSS background, srcset, script-generated resource, or external URL validation.",
        ],
    }


def markdown_report(reports: list[dict]) -> str:
    lines = [
        "# Saved HTML diagnostic report", "",
        "These checks inspect saved source. They do not establish live behaviour, visual quality or accessibility conformance.", "",
    ]
    for report in reports:
        safe_file = report["file"].replace("`", "")
        lines.extend([f"## {safe_file}", "", f"Elements: {report['element_count']}. Findings for review: {report['finding_count']}.", ""])
        if report["findings"]:
            lines.extend(["| Rule | Line | Finding |", "| --- | ---: | --- |"])
            for item in report["findings"]:
                message = item["message"].replace("|", "\\|").replace("\n", " ")
                lines.append(f"| {item['rule']} | {item['line']} | {message} |")
            lines.append("")
        else:
            lines.extend(["No findings from the implemented static checks.", ""])
    lines.extend(["## Limits", ""] + [f"- {value}" for value in reports[0]["limitations"]] if reports else ["No pages inspected."])
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", type=Path, help="Saved HTML files or folders; folders are read recursively.")
    parser.add_argument("--site-root", type=Path, help="Optional local build root for checking resource-file presence.")
    parser.add_argument("--format", choices=["json", "markdown"], default="markdown")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--fail-on-error", action="store_true", help="Return 1 for duplicate IDs or missing local assets.")
    arguments = parser.parse_args(argv)
    paths: list[Path] = []
    for selected in arguments.paths:
        if selected.is_dir():
            paths.extend(selected.rglob("*.html"))
        elif selected.is_file():
            paths.append(selected)
        else:
            parser.error(f"Input does not exist: {selected}")
    paths = sorted(set(path.resolve() for path in paths))
    if not paths:
        parser.error("No HTML files were found.")
    root = arguments.site_root.resolve() if arguments.site_root else None
    if root and not root.is_dir():
        parser.error("--site-root must be an existing directory.")
    reports = []
    for path in paths:
        if root:
            try:
                name = path.relative_to(root).as_posix()
            except ValueError:
                parser.error("Every input file must be inside --site-root.")
        else:
            name = path.name
        try:
            source = path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeError) as error:
            parser.error(f"Cannot read {name}: {error}")
        reports.append(analyse_html(source, name, root))
    result = json.dumps(reports, indent=2, ensure_ascii=False) + "\n" if arguments.format == "json" else markdown_report(reports)
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(result, encoding="utf-8")
    else:
        print(result, end="")
    return int(arguments.fail_on_error and any(item["severity"] == "error" for report in reports for item in report["findings"]))


if __name__ == "__main__":
    raise SystemExit(main())
