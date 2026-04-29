#!/usr/bin/env python3
# ============================================================
#  eyecite_runner.py
#  One-shot Python script invoked from Node via subprocess.
#  Reads JSON request from stdin, writes JSON response to stdout.
#
#  This file lives alongside Node files in the same Render service.
#  No separate web service needed.
#
#  REQUIRES: pip install eyecite==2.6.5
#  Add to package.json or buildCommand:
#    pip install --break-system-packages eyecite==2.6.5
# ============================================================

import sys
import json
from eyecite import get_citations, clean_text, resolve_citations
from eyecite.models import (
    FullCaseCitation, ShortCaseCitation, SupraCitation, IdCitation,
    ReferenceCitation, FullLawCitation, FullJournalCitation,
    UnknownCitation
)

CITE_TYPE_MAP = {
    FullCaseCitation:    "full_case",
    ShortCaseCitation:   "short_case",
    SupraCitation:       "supra",
    IdCitation:          "id",
    ReferenceCitation:   "reference",
    FullLawCitation:     "full_law",
    FullJournalCitation: "full_journal",
    UnknownCitation:     "unknown",
}

def cite_type(cite):
    for cls, name in CITE_TYPE_MAP.items():
        if isinstance(cite, cls):
            return name
    return "other"

def serialize_citation(c):
    out = {
        "type":          cite_type(c),
        "cite":          "",
        "span":          list(c.span()) if hasattr(c, 'span') else None,
        "parenthetical": None,
        "pin_cite":      None,
        "plaintiff":     None,
        "defendant":     None,
        "year":          None,
        "court":         None,
        "volume":        None,
        "reporter":      None,
        "page":          None,
        "extra":         None,
    }
    try:
        if hasattr(c, 'corrected_citation') and callable(c.corrected_citation):
            out["cite"] = c.corrected_citation()
        elif hasattr(c, 'matched_text') and callable(c.matched_text):
            out["cite"] = c.matched_text()
        elif hasattr(c, 'token') and c.token:
            out["cite"] = str(getattr(c.token, 'data', c.token))
        else:
            out["cite"] = str(c)
    except Exception:
        out["cite"] = str(c)

    md = getattr(c, 'metadata', None)
    if md:
        out["parenthetical"] = getattr(md, 'parenthetical', None)
        out["pin_cite"]      = getattr(md, 'pin_cite', None)
        out["plaintiff"]     = getattr(md, 'plaintiff', None)
        out["defendant"]     = getattr(md, 'defendant', None)
        out["year"]          = getattr(md, 'year', None)
        out["court"]         = getattr(md, 'court', None)
        out["extra"]         = getattr(md, 'extra', None)

    grp = getattr(c, 'groups', None)
    if grp and isinstance(grp, dict):
        out["volume"]   = grp.get("volume")
        out["reporter"] = grp.get("reporter")
        out["page"]     = grp.get("page")
    return out


def main():
    try:
        request = json.loads(sys.stdin.read() or "{}")
    except Exception as e:
        print(json.dumps({"error": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    action = request.get("action", "extract")
    text = request.get("text", "")
    clean_steps = request.get("clean", ["all_whitespace"])

    if not text:
        print(json.dumps({"error": "Missing 'text' field"}))
        sys.exit(1)

    try:
        cleaned = clean_text(text, clean_steps)
    except Exception as e:
        print(json.dumps({"error": f"Text cleaning failed: {e}"}))
        sys.exit(1)

    try:
        if action == "clean":
            print(json.dumps({"cleaned": cleaned}))
            return

        citations = get_citations(cleaned)

        if action == "resolve":
            resolutions = resolve_citations(citations)
            out = []
            for resource, resolved in resolutions.items():
                out.append({
                    "resource_id":   id(resource),
                    "resource_type": type(resource).__name__,
                    "resource_str":  str(resource),
                    "citations":     [serialize_citation(c) for c in resolved],
                })
            print(json.dumps({"resolutions": out}))
            return

        # Default: extract
        result = [serialize_citation(c) for c in citations]
        print(json.dumps(result))

    except Exception as e:
        print(json.dumps({"error": f"Eyecite error: {e}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
