#!/usr/bin/env python3
"""
uscis_form_rebuild.py — rewrite a USCIS form PDF so pdf-lib can fill it.

    python3 scripts/uscis_form_rebuild.py in.pdf out.pdf

Called by scripts/uscis-form-prep.js. It does one thing: read the file and
write it back out, which rebuilds the cross-reference table.

WHY PYTHON FOR THIS ONE STEP
USCIS forms are static-XFA hybrids whose AcroForm dictionary sits behind
object references pdf-lib's parser rejects — it cannot load one well enough to
save it again. pypdf reads them. So the rebuild happens here, once, offline,
and the result is committed; the app itself is Node only and never runs this.

Nothing is changed but the file structure. The form's fields, their names and
the printed page are untouched.
"""

import sys

try:
    from pypdf import PdfReader, PdfWriter
except ImportError:
    sys.exit("pypdf is not installed:  pip3 install pypdf")


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: uscis_form_rebuild.py <in.pdf> <out.pdf>")
    src, dst = sys.argv[1], sys.argv[2]

    reader = PdfReader(src)
    # USCIS ships these encrypted: an empty owner password with the permission
    # bits set, which is not protection against anyone and does stop every
    # library that does not ask. Needs pypdf's crypto backend:
    #   pip3 install pypdf cryptography
    if reader.is_encrypted:
        reader.decrypt("")

    fields = reader.get_fields() or {}
    if not fields:
        sys.exit(f"{src} has no fillable fields — nothing to rebuild")

    writer = PdfWriter(clone_from=reader)
    with open(dst, "wb") as fh:
        writer.write(fh)

    print(f"rebuilt {src} -> {dst}  ({len(fields)} field nodes, {len(reader.pages)} pages)")


if __name__ == "__main__":
    main()
