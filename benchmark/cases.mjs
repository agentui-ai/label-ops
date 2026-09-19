/**
 * Nine ways a label prints, scans as something else, or does not print at all.
 *
 * The barcode half is verifiable to the digit, so it is verified twice: against
 * the published rule, and against bwip-js as an independent oracle — the digit
 * this repo computes is the digit another encoder accepts, and every other
 * digit is rejected.
 *
 * Deterministic, offline, free: no LLM, no network, no fixtures on disk.
 */
import bwipjs from "bwip-js";
import {
    gs1CheckDigit, withGs1CheckDigit, verifyGs1, assertItf14,
    code39CheckChar, code128bChecksum, buildGs1128,
} from "../skills/label-ops/scripts/barcodes.mjs";
import { ZplLabel, mmToDots, escapeFieldData } from "../skills/label-ops/scripts/zpl.mjs";
import { encodeText, Receipt } from "../skills/label-ops/scripts/escpos.mjs";

const CODE39_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%";

/** Left-anchored weights — the classic bug. Right for even payloads, wrong for odd. */
function naiveGs1CheckDigit(payload) {
    const s = String(payload);
    let sum = 0;
    for (let i = 0; i < s.length; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (sum % 10)) % 10;
}

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

export const CASES = [
    {
        name: "gs1-check-digit-anchoring",
        trap: "Weights are anchored at the RIGHT. Anchoring left gives the right answer for even-length payloads and the wrong one for odd — so EAN-13 works and UPC-A does not.",
        // Published GS1 examples.
        expect: { ean13: "5901234123457", upca: "036000291452", ean8: "96385074", gtin14: "10614141000415" },
        naive() {
            const f = (p) => `${p}${naiveGs1CheckDigit(p)}`;
            return { ean13: f("590123412345"), upca: f("03600029145"), ean8: f("9638507"), gtin14: f("1061414100041") };
        },
        skilled() {
            return {
                ean13: withGs1CheckDigit("590123412345"),
                upca: withGs1CheckDigit("03600029145"),
                ean8: withGs1CheckDigit("9638507"),
                gtin14: withGs1CheckDigit("1061414100041"),
            };
        },
    },

    {
        name: "check-digit-verified-by-another-encoder",
        trap: "A check digit that only your own code agrees with is not a check digit. bwip-js accepts exactly one digit per payload — this asserts it is ours, and that all nine others are refused.",
        expect: { accepted: 1, rejected: 9 },
        async run(digitFor) {
            // An ODD-length payload on purpose: UPC-A is where left-anchoring
            // diverges. On a 12-digit EAN-13 payload both rules agree, and the
            // oracle would declare a broken implementation correct.
            const payload = "03600029145";
            let accepted = 0;
            let rejected = 0;
            for (let d = 0; d <= 9; d++) {
                const candidate = `${payload}${d}`;
                let ok = true;
                try { await bwipjs.toBuffer({ bcid: "upca", text: candidate, scale: 1, height: 10 }); }
                catch { ok = false; }
                const mine = d === digitFor(payload);
                if (ok && mine) accepted++;
                else if (!ok && !mine) rejected++;
            }
            return { accepted, rejected };
        },
        naive() { return this.run(naiveGs1CheckDigit); },
        skilled() { return this.run(gs1CheckDigit); },
    },

    {
        name: "code128-checksum-position-base",
        trap: "Positions start at 1 for the first data character. Using the loop index (0) is wrong for every code whose first character is not value 0.",
        expect: { checksum: 26 }, // HI345678, Code Set B — verified by hand and against the published rule
        naive() {
            const s = "HI345678";
            let sum = 104;
            for (let i = 0; i < s.length; i++) sum += (s.charCodeAt(i) - 32) * i; // i, not i + 1
            return { checksum: sum % 103 };
        },
        skilled() { return { checksum: code128bChecksum("HI345678") }; },
    },

    {
        name: "code39-checksum-excludes-delimiters",
        trap: "Code 39 has no lowercase and the `*` delimiters are framing, not data. An unmapped character scored as 0 produces a plausible wrong check character rather than an error.",
        expect: { check: "-" }, // ABC-1234 → sum 79, 79 mod 43 = 36 → "-"
        naive() {
            // Code 39 has no lowercase. A product code arriving lowercase from a
            // database scores -1 per letter, which a `v < 0 ? 0 : v` guard turns
            // into a plausible wrong character instead of an error.
            const s = "abc-1234";
            let sum = 0;
            for (const ch of s) {
                const v = CODE39_ALPHABET.indexOf(ch);
                sum += v < 0 ? 0 : v;
            }
            return { check: CODE39_ALPHABET[sum % 43] };
        },
        skilled() { return { check: code39CheckChar("ABC-1234") }; },
    },

    {
        name: "itf14-odd-digit-count",
        trap: "Interleaved 2 of 5 encodes digits in pairs. Encoders pad a leading zero to make it fit, which silently changes the GTIN.",
        expect: { rejected: true },
        naive() {
            const odd = "0012345678905"; // 13 digits
            const padded = odd.length % 2 ? `0${odd}` : odd; // "helpful"
            return { rejected: false, printed: padded };
        },
        skilled() {
            try { assertItf14("0012345678905"); return { rejected: false }; }
            catch { return { rejected: true }; }
        },
    },

    {
        name: "zpl-dots-are-not-millimetres",
        trap: "^FO is in DOTS. A layout worked out at 203 dpi and sent to a 300 dpi printer prints at ~68% scale in the top-left corner, with byte-identical ZPL.",
        expect: { at203: 800, at300: 1181 },
        naive() {
            // "203 dpi is standard" — hardcoded conversion.
            const dots = (mm) => Math.round(mm * 8);
            return { at203: dots(100), at300: dots(100) };
        },
        skilled() { return { at203: mmToDots(100, 203), at300: mmToDots(100, 300) }; },
    },

    {
        name: "zpl-control-characters-in-data",
        trap: "^ and ~ are ZPL command prefixes. A product name containing one ends the field and starts a command — 'AC^DC' prints garbage.",
        expect: { safe: true },
        naive() {
            const zpl = `^XA^FO40,40^FDAC^DC Widget^FS^XZ`;
            // One ^FD field, then a stray ^DC command the printer will try to run.
            return { safe: !/\^FD[^^]*\^(?!FS)/.test(zpl) };
        },
        skilled() {
            const l = new ZplLabel({ dpi: 203, widthMm: 100, heightMm: 50 });
            l.text({ xMm: 5, yMm: 5, text: "AC^DC Widget" });
            const zpl = l.build();
            return { safe: zpl.includes("^FH") && !/\^FDAC\^DC/.test(zpl) };
        },
    },

    {
        name: "zpl-field-past-the-label-edge",
        trap: "A field placed beyond the label width is clipped, or not printed at all. The printer never says so — it has no back channel.",
        expect: { flagged: ["FIELD_OVERFLOWS_LABEL"] },
        setup() {
            const l = new ZplLabel({ dpi: 203, widthMm: 100, heightMm: 50 });
            l.text({ xMm: 80, yMm: 5, text: "Long description here", widthMm: 40 });
            return l;
        },
        naive() { return { flagged: [] }; }, // build the string, open the socket, hope
        skilled() {
            return { flagged: this.setup().validate().map((i) => i.code) };
        },
    },

    {
        name: "escpos-text-is-not-utf8",
        trap: "Thermal printers use code pages. UTF-8 makes one accented character into two bytes, so 'café' prints as 'cafÃ©'.",
        expect: { bytes: "63 61 66 82", length: 4 },
        naive() {
            const b = new TextEncoder().encode("café");
            return { bytes: hex(b), length: b.length };
        },
        skilled() {
            const b = encodeText("café", "CP850");
            return { bytes: hex(b), length: b.length };
        },
    },
];
