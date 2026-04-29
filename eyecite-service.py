# ============================================================
#  eyecite-service.py
#  Citation parsing sidecar service for Tez Law's Research module
#
#  Deploys as a separate Render web service (Starter plan ~$7/mo)
#  Called from Node.js eyecite-bridge.js via HTTP POST
#
#  ENDPOINTS:
#    POST /extract       — extract all citations from text
#    POST /resolve       — extract + resolve short forms / supra / id
#    POST /clean         — clean text (strip HTML, normalize whitespace)
#    GET  /health        — health check
#
#  REQUIREMENTS (requirements.txt):
#    flask==3.0.0
#    eyecite==2.6.5
#    gunicorn==21.2.0
#
#  RENDER START COMMAND:
#    gunicorn eyecite-service:app --workers 2 --timeout 30
# ============================================================

import os
from flask import Flask, request, jsonify
from eyecite import get_citations, clean_text, resolve_citations
from eyecite.models import (
    FullCaseCitation, ShortCaseCitation, SupraCitation, IdCitation,
    ReferenceCitation, FullLawCitation, FullJournalCitation,
    UnknownCitation
)

app = Flask(__name__)

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
    """Serialize an eyecite citation object to JSON-safe dict."""
    out = {
        "type":           cite_type(c),
        "cite":           "",
        "span":           list(c.span()) if hasattr(c, 'span') else None,
        "parenthetical":  None,
        "pin_cite":       None,
        "plaintiff":      None,
        "defendant":      None,
        "year":           None,
        "court":          None,
        "volume":         None,
        "reporter":       None,
        "page":           None,
        "extra":          None,
    }

    # Citation text
    try:
        if hasattr(c, 'corrected_citation') and callable(c.corrected_citation):
            out["cite"] = c.corrected_citation()
        elif hasattr(c, 'matched_text') and callable(c.matched_text):
            out["cite"] = c.matched_text()
        elif hasattr(c, 'token') and c.token:
            out["cite"] = str(c.token.data) if hasattr(c.token, 'data') else str(c.token)
        else:
            out["cite"] = str(c)
    except Exception:
        out["cite"] = str(c)

    # Metadata
    md = getattr(c, 'metadata', None)
    if md:
        out["parenthetical"] = getattr(md, 'parenthetical', None)
        out["pin_cite"]      = getattr(md, 'pin_cite', None)
        out["plaintiff"]     = getattr(md, 'plaintiff', None)
        out["defendant"]     = getattr(md, 'defendant', None)
        out["year"]          = getattr(md, 'year', None)
        out["court"]         = getattr(md, 'court', None)
        out["extra"]         = getattr(md, 'extra', None)

    # Reporter info
    grp = getattr(c, 'groups', None)
    if grp and isinstance(grp, dict):
        out["volume"]   = grp.get("volume")
        out["reporter"] = grp.get("reporter")
        out["page"]     = grp.get("page")

    return out

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"ok": True, "service": "eyecite-bridge", "version": "1.0"})

@app.route('/extract', methods=['POST'])
def extract():
    """
    POST /extract
    Body: { "text": "...", "clean": ["html", "all_whitespace"] (optional) }
    Returns: [ { type, cite, span, parenthetical, pin_cite, ... } ]
    """
    body = request.get_json(silent=True) or {}
    text = body.get('text', '')
    if not text:
        return jsonify({"error": "Missing 'text' field"}), 400

    clean_steps = body.get('clean', ['all_whitespace'])
    try:
        cleaned = clean_text(text, clean_steps)
    except Exception as e:
        return jsonify({"error": f"Text cleaning failed: {e}"}), 400

    try:
        citations = get_citations(cleaned)
    except Exception as e:
        return jsonify({"error": f"Citation extraction failed: {e}"}), 500

    return jsonify([serialize_citation(c) for c in citations])

@app.route('/resolve', methods=['POST'])
def resolve():
    """
    POST /resolve
    Body: { "text": "...", "clean": [...] (optional) }
    Returns resolved citations — short forms / supra / id mapped back to full citations.
    """
    body = request.get_json(silent=True) or {}
    text = body.get('text', '')
    if not text:
        return jsonify({"error": "Missing 'text' field"}), 400

    clean_steps = body.get('clean', ['all_whitespace'])
    try:
        cleaned = clean_text(text, clean_steps)
        citations = get_citations(cleaned)
        resolutions = resolve_citations(citations)
    except Exception as e:
        return jsonify({"error": f"Resolution failed: {e}"}), 500

    out = []
    for resource, resolved_cites in resolutions.items():
        resource_dict = {
            "resource_id":   id(resource),
            "resource_type": type(resource).__name__,
            "resource_str":  str(resource),
            "citations":     [serialize_citation(c) for c in resolved_cites],
        }
        out.append(resource_dict)

    return jsonify({"resolutions": out})

@app.route('/clean', methods=['POST'])
def clean():
    """
    POST /clean
    Body: { "text": "...", "steps": ["html", "all_whitespace", "underscores", "xml"] }
    Returns: { "cleaned": "..." }
    """
    body = request.get_json(silent=True) or {}
    text = body.get('text', '')
    steps = body.get('steps', ['all_whitespace'])
    try:
        return jsonify({"cleaned": clean_text(text, steps)})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
