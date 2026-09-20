#!/usr/bin/env python3
"""Checks a translation against English: same keys, same {slots}, same HTML tags. Usage: i18n-check.py <lang> [...]"""
import json, re, sys, os
D = os.path.join(os.path.dirname(__file__), "..", "web", "src", "i18n")
slots = lambda s: sorted(re.findall(r"\{(\w+)\}", s))
tags = lambda s: sorted(re.findall(r"</?\w+[^>]*>", s))
bad = 0
for lang in sys.argv[1:]:
    for base in ("", "docs."):
        en = json.load(open(os.path.join(D, f"{base}en.json"), encoding="utf-8"))
        try: tr = json.load(open(os.path.join(D, f"{base}{lang}.json"), encoding="utf-8"))
        except Exception as e: print(f"{base}{lang}.json: {e}"); bad += 1; continue
        for k in en:
            if k not in tr: print(f"{base}{lang}: missing {k}"); bad += 1; continue
            if slots(en[k]) != slots(tr[k]): print(f"{base}{lang}: slots differ in {k}: {slots(en[k])} vs {slots(tr[k])}"); bad += 1
            if tags(en[k]) != tags(tr[k]): print(f"{base}{lang}: tags differ in {k}"); bad += 1
        for k in tr:
            if k not in en: print(f"{base}{lang}: extra key {k}"); bad += 1
print("OK" if not bad else f"{bad} problem(s)")
sys.exit(1 if bad else 0)
