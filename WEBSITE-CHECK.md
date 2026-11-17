# Website Check

An original Python work sample prepared through an AI-assisted workflow to inspect saved HTML before a website repair. It reports source-level findings as Markdown or JSON.

[Download complete source, tests and MIT license](website-check-source.zip)

View [source](website_check.py) and [tests](test_website_check.py) directly.

Checks cover language/title/viewport, restrictive zoom, duplicate IDs, missing image alternatives, unnamed controls, unlabelled fields and missing local resources. File checks stay within an explicitly supplied site root.

## Verification — 17 November 2026

`python -m unittest -v test_website_check.py`: 7 tests passed, 0 failed. Tests cover the CLI output/status, hidden/script content, image alternatives, duplicate IDs, bounded local files, control labels and restrictive zoom.

Requires Python 3.10+, without third-party dependencies or outbound requests. Reads the inspected files and writes the requested report; does not modify the website.

It cannot establish the rendered DOM, keyboard behavior, contrast, performance, payments or live application behavior. Findings require review; an empty report is not certification.
