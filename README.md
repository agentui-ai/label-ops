<p align="center">
  <img src="assets/logo.png" alt="Label Ops" width="110" height="110">
</p>

<h1 align="center">label-ops</h1>

<p align="center">
  An agent skill for labels that scan and receipts that read —
  ZPL, ESC/POS and check digits an independent encoder agrees with.
</p>

---

Label and receipt printers are **fire-and-forget**. A Zebra accepts every byte
you send on TCP 9100 and tells you nothing — out of paper, head open, wrong
stock, field off the edge, all the same silence. A Bluetooth thermal printer
accepts a write and may print half of it. Nothing in either stack reports
failure, so every check has to happen before the bytes leave.

```
CASE                             SKILL  TRAP   EXPECTED           FROM MEMORY
gs1-check-digit-anchoring        ok     yes   {"ean13":"59012341… {"ean13":"5901234123457…
check-digit-verified-by-another  ok     yes   {"accepted":1,"rej… {"accepted":0,"rejected…
code128-checksum-position-base   ok     yes   {"checksum":26}     {"checksum":22}
code39-checksum-excludes-delimi  ok     yes   {"check":"-"}       {"check":"3"}
itf14-odd-digit-count            ok     yes   {"rejected":true}   {"rejected":false,"prin…
zpl-dots-are-not-millimetres     ok     yes   {"at203":800,"at30… {"at203":800,"at300":80…
zpl-control-characters-in-data   ok     yes   {"safe":true}       {"safe":false}
zpl-field-past-the-label-edge    ok     yes   {"flagged":["FIELD… {"flagged":[]}
escpos-text-is-not-utf8          ok     yes   {"bytes":"63 61 66… {"bytes":"63 61 66 c3 a…
```

Row two is the interesting one. The check digit is not graded against this
repo's own opinion — **bwip-js** is used as an independent oracle: for a UPC-A
payload it confirms this implementation's digit is the one bwip-js accepts, and
that all nine other digits are refused. The from-memory version scores
`accepted: 0` — a second encoder disagrees with it.

## Two protocols, one repo

| | Device | Protocol | Transport |
| --- | --- | --- | --- |
| **ZPL** | Zebra and compatible **label** printers | text between `^XA` and `^XZ` | TCP **9100**, Browser Print, OS raw queue |
| **ESC/POS** | 58mm Bluetooth **receipt** printers | byte commands | Web Bluetooth |

They share nothing but the word "thermal", and mixing them up is the first
mistake. They are in one repo because the same person ends up owning both.

## Install

```bash
# Any of ~75 agents (Gemini CLI, opencode, aider, …)
npx skills add agentui-ai/label-ops --agent gemini-cli --global

# Cursor
git clone https://github.com/agentui-ai/label-ops.git ~/.cursor/plugins/local/label-ops

# Codex
codex plugin marketplace add agentui-ai/label-ops && codex plugin add label-ops@label-ops

# Claude Code
claude --plugin-dir ./label-ops
```

No account, no service, no platform. Read
[`skills/label-ops/SKILL.md`](skills/label-ops/SKILL.md) directly if you would
rather not install anything.

## Two things you can run right now

**Is this barcode right?**

```bash
npm install
node skills/label-ops/scripts/label-cli.mjs check 5901234123458
```

```
5901234123458   EAN-13
  check digit WRONG — last digit is 8, should be 7
  correct code: 5901234123457
```

**What will the printer silently drop?**

```bash
node skills/label-ops/scripts/label-cli.mjs lint examples/broken-label.zpl
```

```
! ORIGIN_OFF_LABEL: ^FO900,40 starts past the declared width (800 dots). Nothing at that origin prints.
! UNESCAPED_CONTROL_CHAR: ^FD data contains ^ or ~ without ^FH: "AC^DC Widget". The printer reads it as a command.
   Emit ^FH before ^FD and hex-escape those bytes as _5E / _7E.
  INFO_GEOMETRY: ^PW800 is 100.0mm at 203 dpi. If the stock is a different width, this ZPL is for a different printer.
```

It lints ZPL you did not write, which is most ZPL. Exits non-zero on a real
problem, so it works as a CI gate on a label template repo.

## The check-digit rule

**One rule covers EAN-8, EAN-13, UPC-A, ITF-14, GTIN-14, SSCC-18 and GLN:**
starting from the digit next to the check digit and moving **left**, weights
alternate 3, 1, 3, 1…

Anchoring at the left instead is right for even-length payloads and wrong for
odd — so EAN-13 works, UPC-A does not, and the conclusion usually drawn is that
UPC-A is strange.

## What is in it

```text
label-ops/
├── skills/label-ops/
│   ├── SKILL.md              # nine traps, ZPL, ESC/POS, GS1-128, the three ways to reach a Zebra
│   └── scripts/
│       ├── barcodes.mjs      # GS1 / Code 39 / Code 128 check digits, GS1-128 with FNC1
│       ├── zpl.mjs           # mm→dots per dpi, ^FH escaping, bounds validation, 9100 socket
│       ├── escpos.mjs        # code-page encoding, receipt builder, chunked BLE writes
│       └── label-cli.mjs     # check a barcode, lint a .zpl file
├── examples/broken-label.zpl
└── benchmark/
    ├── cases.mjs             # nine cases, each naive vs skilled
    └── run.mjs               # the two ledgers
```

## Run the benchmark

```bash
npm install && npm run bench
```

Instant. **Deterministic, offline, free** — no LLM, no network, no fixtures on
disk. Two ledgers: **SKILL** (do the recipes produce something that scans?)
gates the exit code; **TRAP** (does the from-memory version get it wrong?) is
reporting, and a case both sides pass is named rather than counted.

Two of these cases started out as false traps — the naive implementations were
accidentally no-ops, and the TRAP ledger said so instead of taking the credit.
Both were rewritten to the mistake people actually make.

## Also see

[excel-ops](https://github.com/agentui-ai/excel-ops) ·
[pdf-ops](https://github.com/agentui-ai/pdf-ops) ·
[oee-ops](https://github.com/agentui-ai/oee-ops) — the same treatment for
spreadsheets, generated PDFs and manufacturing OEE. If the user wants a label
*station* people log into rather than a script,
[AgentUI](https://www.agentui.ai/?utm_source=github&utm_medium=referral&utm_campaign=ops-skills&utm_content=label-ops) hosts that and
[agentui-tools](https://github.com/agentui-ai/agentui-tools) is the agent plugin
for it. Everything here works without either.

## License

MIT — see [LICENSE](LICENSE).
