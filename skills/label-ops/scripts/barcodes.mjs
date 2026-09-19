/**
 * Barcode check digits — the one part of label printing that is verifiable to
 * the last digit, and the part most often shipped wrong.
 *
 * A wrong check digit does not fail loudly. It prints, it looks like a barcode,
 * and it is rejected at the till or at the receiving dock by a scanner in a
 * building you do not work in — usually after several thousand labels.
 *
 * Every function here is cross-validated against bwip-js in the benchmark:
 * the digit this module computes is the digit an independent encoder accepts,
 * and every other digit is rejected.
 */

/* ────────────────────────── GTIN family ────────────────────────── */

/**
 * The GS1 modulo-10 check digit: EAN-13, EAN-8, UPC-A, UPC-E, ITF-14, GTIN-14,
 * SSCC-18, GLN-13 — all of them, one rule.
 *
 * The rule is ALWAYS anchored at the RIGHT: starting from the digit next to the
 * check digit and moving left, weights alternate 3, 1, 3, 1…
 *
 * Anchoring at the left instead is the classic bug, and it is silent: it gives
 * the right answer for even-length payloads and the wrong one for odd, so
 * EAN-13 works, UPC-A does not, and the developer concludes UPC-A is "weird".
 */
export function gs1CheckDigit(digits) {
    const s = String(digits);
    if (!/^\d+$/.test(s)) throw new Error(`GS1 check digit needs digits only, got ${JSON.stringify(digits)}`);
    let sum = 0;
    // i counts from the right-hand end of the PAYLOAD (no check digit yet).
    for (let i = 0; i < s.length; i++) {
        const digit = Number(s[s.length - 1 - i]);
        sum += digit * (i % 2 === 0 ? 3 : 1);
    }
    return (10 - (sum % 10)) % 10;
}

/** Append the check digit. `ean13("590123412345")` → `"5901234123457"`. */
export function withGs1CheckDigit(payload) {
    return `${payload}${gs1CheckDigit(payload)}`;
}

/** Does a complete code carry the right check digit? */
export function verifyGs1(code) {
    const s = String(code);
    if (s.length < 2) return false;
    return gs1CheckDigit(s.slice(0, -1)) === Number(s[s.length - 1]);
}

/** Expected total lengths, check digit included. */
export const GTIN_LENGTHS = { "EAN-8": 8, "UPC-A": 12, "EAN-13": 13, "ITF-14": 14, "GTIN-14": 14, "SSCC": 18 };

/**
 * UPC-A → EAN-13. The rule is "prepend a zero", and **the check digit does not
 * change** — a leading zero contributes nothing to the weighted sum. Recomputing
 * it is harmless; *changing* it because you re-anchored the weights is not.
 */
export function upcaToEan13(upca) {
    const s = String(upca);
    if (s.length !== 12) throw new Error(`UPC-A is 12 digits, got ${s.length}`);
    if (!verifyGs1(s)) throw new Error(`UPC-A ${s} has a bad check digit (expected ${gs1CheckDigit(s.slice(0, -1))})`);
    return `0${s}`;
}

/**
 * ITF-14 (Interleaved 2 of 5) encodes digits in PAIRS.
 *
 * An odd number of digits cannot be encoded. Most encoders "helpfully" pad a
 * leading zero, which silently changes the number you meant to print — so
 * validate before you hand it over, rather than finding out from a pallet.
 */
export function assertItf14(code) {
    const s = String(code);
    if (!/^\d+$/.test(s)) throw new Error(`ITF-14 is digits only, got ${JSON.stringify(code)}`);
    if (s.length % 2 !== 0) {
        throw new Error(
            `ITF-14 needs an even digit count (pairs), got ${s.length}. ` +
                `Padding a leading zero changes the GTIN — fix the source data instead.`
        );
    }
    if (s.length !== 14) throw new Error(`ITF-14 is 14 digits, got ${s.length}`);
    if (!verifyGs1(s)) throw new Error(`ITF-14 ${s} has a bad check digit (expected ${gs1CheckDigit(s.slice(0, -1))})`);
    return s;
}

/* ────────────────────────── Code 39 ────────────────────────── */

const CODE39_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%";

/**
 * Code 39 modulo-43 check character (optional in the symbology, required by
 * several logistics standards).
 *
 * Computed over the DATA ONLY. The `*` start/stop delimiters are framing, not
 * data — including them shifts the sum and produces a character a scanner
 * configured to verify will reject.
 */
export function code39CheckChar(data) {
    const s = String(data).toUpperCase();
    let sum = 0;
    for (const ch of s) {
        const v = CODE39_ALPHABET.indexOf(ch);
        if (v < 0) throw new Error(`${JSON.stringify(ch)} cannot be encoded in Code 39. Allowed: ${CODE39_ALPHABET}`);
        sum += v;
    }
    return CODE39_ALPHABET[sum % 43];
}

export function withCode39CheckChar(data) {
    return `${String(data).toUpperCase()}${code39CheckChar(data)}`;
}

/* ────────────────────────── Code 128 ────────────────────────── */

export const CODE128_START = { A: 103, B: 104, C: 105 };

/**
 * Code 128 modulo-103 check symbol.
 *
 * `checksum = (startValue + Σ position × value) mod 103`, where **position
 * starts at 1** for the first data character. Starting at 0 — the natural thing
 * for a loop index — is wrong for every code whose first character is not
 * value 0, which is almost all of them.
 *
 * Values here are Code Set B (ASCII 32–126 → 0–94), the set that covers normal
 * alphanumeric label data.
 */
export function code128bChecksum(data) {
    const s = String(data);
    let sum = CODE128_START.B;
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code < 32 || code > 126) {
            throw new Error(
                `${JSON.stringify(s[i])} (char ${code}) is outside Code Set B (ASCII 32-126). ` +
                    `Use Code Set A for control characters, or strip it.`
            );
        }
        sum += (code - 32) * (i + 1);
    }
    return sum % 103;
}

/* ────────────────────────── GS1-128 ────────────────────────── */

/** Application Identifiers whose data is FIXED length — no separator needed after these. */
export const GS1_FIXED_LENGTH_AIS = {
    "00": 18, "01": 14, "02": 14, "03": 14, "04": 16,
    11: 6, 12: 6, 13: 6, 14: 6, 15: 6, 16: 6, 17: 6, 18: 6, 19: 6,
    20: 2, 31: 6, 32: 6, 33: 6, 34: 6, 35: 6, 36: 6, 41: 13,
};

/**
 * Build a GS1-128 data string from Application Identifiers.
 *
 * **Variable-length AIs must be terminated by FNC1** when another AI follows.
 * Concatenating without it is the single most common GS1-128 defect: the
 * scanner reads the next AI as more of the previous value, so a batch number
 * swallows the expiry date and nothing anywhere reports an error.
 *
 * FNC1 is rendered as the ASCII Group Separator (0x1D) in the decoded data, and
 * written as `>8` in ZPL's `^FD` when `^BC` is in GS1 mode.
 */
export function buildGs1128(pairs, { separator = "\x1D" } = {}) {
    const parts = [];
    pairs.forEach(([ai, value], index) => {
        const key = String(ai);
        const v = String(value);
        const fixed = GS1_FIXED_LENGTH_AIS[key] ?? GS1_FIXED_LENGTH_AIS[Number(key)];
        if (fixed !== undefined && v.length !== fixed) {
            throw new Error(`AI (${key}) is fixed at ${fixed} characters, got ${v.length}: ${JSON.stringify(v)}`);
        }
        parts.push(key + v);
        const isLast = index === pairs.length - 1;
        if (fixed === undefined && !isLast) parts.push(separator);
    });
    return parts.join("");
}
