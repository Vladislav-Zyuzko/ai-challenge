"""Точка входа: `python -m doc_index ...`."""
import sys

from .cli import main

if __name__ == "__main__":
    # Консоль Windows по умолчанию работает в cp1251 и падает на «≈», «·»
    # и других символах, которые команды печатают в отчётах.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    sys.exit(main())
