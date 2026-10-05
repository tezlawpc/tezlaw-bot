pdf.js 4.10.38 (legacy build), Mozilla — Apache License 2.0 (see LICENSE).
Copied unchanged from the npm package "pdfjs-dist":
  legacy/build/pdf.min.mjs, legacy/build/pdf.worker.min.mjs, cmaps/, standard_fonts/

It draws PDF pages in the browser for the e-signature pages
(public/esign-prepare.js and public/esign-sign.js). The server never runs it.
cmaps/ lets it show Chinese, Japanese and Korean PDFs whose fonts are not
embedded; standard_fonts/ does the same for Helvetica, Times and Courier.

To update: replace these files with the same paths from a newer pdfjs-dist
and reload a signing page. Keep the two .mjs files from the SAME version.
