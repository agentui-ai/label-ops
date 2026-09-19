# Changelog

## 0.1.0

First release. The `label-ops` skill: ZPL for Zebra label printers and ESC/POS for
58mm Bluetooth receipt printers, barcode check digits for the GS1 family plus
Code 39 and Code 128, GS1-128 with FNC1 separators, a ZPL builder that validates
bounds and escapes control characters before the socket opens, an ESC/POS builder
that encodes to a real code page, and a CLI that checks a barcode or lints a .zpl
file.

The check digits are cross-validated against bwip-js as an independent oracle
rather than against this repo's own opinion. Two benchmark cases were rewritten
during development because the naive implementations turned out to be
mathematically no-ops — adding multiples of 43 to a mod-43 sum, and testing
check-digit anchoring on an even-length payload where both anchorings agree.
