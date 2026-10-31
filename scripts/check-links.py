#!/usr/bin/env python3
"""Битые относительные ссылки и якоря в Markdown. Падает, если что-то не найдено."""
import glob
import os
import re
import sys
import unicodedata


def slug(heading: str) -> str:
    # Якорь заголовка так, как его строит GitHub
    s = heading.strip().lower()
    s = re.sub(r"[`*_~]", "", s)
    s = "".join(ch for ch in s if unicodedata.category(ch)[0] in "LN" or ch in " -")
    return s.replace(" ", "-")


def anchors(path: str) -> set:
    out = set()
    in_code = False
    for line in open(path, encoding="utf-8"):
        if line.startswith("```"):
            in_code = not in_code
        if not in_code and line.startswith("#"):
            out.add(slug(line.lstrip("#")))
    return out


bad = []
for md in glob.glob("**/*.md", recursive=True):
    if "node_modules" in md:
        continue
    text = open(md, encoding="utf-8").read()
    for target in re.findall(r"\]\(([^)\s]+)\)", text):
        if target.startswith(("http://", "https://", "mailto:")):
            continue
        path, _, anchor = target.partition("#")
        full = os.path.normpath(os.path.join(os.path.dirname(md), path)) if path else md
        if not os.path.exists(full):
            bad.append(f"{md}: нет файла {target}")
        elif anchor and full.endswith(".md") and anchor not in anchors(full):
            bad.append(f"{md}: нет якоря {target}")

print("\n".join(bad) if bad else "Ссылки и якоря в порядке")
sys.exit(1 if bad else 0)
