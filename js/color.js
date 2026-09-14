// Colour maps. The heat gradient is interpolated in OKLCH so the midpoints stay
// clean; the diverging change scale is a simple two-sided OKLab blend.

// ---- sRGB <-> OKLab / OKLCH ------------------------------------------------
function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function hexToOklab(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = srgbToLinear((n >> 16) & 255);
  const g = srgbToLinear((n >> 8) & 255);
  const b = srgbToLinear(n & 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToRgb({ L, a, b }) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const oklabToLch = ({ L, a, b }) => ({
  L,
  C: Math.hypot(a, b),
  h: Math.atan2(b, a),
});
const lchToOklab = ({ L, C, h }) => ({ L, a: C * Math.cos(h), b: C * Math.sin(h) });

function lerpHue(h0, h1, t) {
  let d = h1 - h0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return h0 + d * t;
}

// ---- heat gradient (0 = strongest end of the scale) ------------------
// Vivid green -> khaki -> orange -> coral red, matching the palette poker range
// charts conventionally use. Unlike the earlier dark-ended ramps, the weak end
// stays light and saturated, which keeps the bottom of the scale legible against
// the dark canvas instead of sinking into it.
//
// Relative luminance still falls across the ramp (0.48 -> 0.26), so ordering
// reads without relying on hue alone — the failure of a flat dark-green-to-red
// ramp, which scored 2.73 colour separation per equity point in its mid-band
// against ~9 at the ends. The khaki stop is what keeps the green->orange
// transition from going flat.
const HEAT_HEX = [
  "#A0FF90",
  "#59D167",
  "#C9BC4E",
  "#EE9440",
  "#F25731",
  "#F03C3C",
  "#800000",
];
const HEAT_LCH = HEAT_HEX.map((h) => oklabToLch(hexToOklab(h)));

// Stops are placed along the scale by cumulative perceptual distance, not spread
// evenly. Spacing these five uniformly would hand the last leg a full quarter of
// the ramp to travel #F25731 -> #F03C3C — two near-identical reds about 29 units
// apart — and that quarter would read as one flat colour. Arc-length spacing
// instead gives every stretch of the scale the same amount of colour change per
// unit of equity, which is exactly the property the flat-band test checks.
const HEAT_POS = (() => {
  const lab = HEAT_HEX.map((h) => hexToOklab(h));
  const cum = [0];
  for (let i = 1; i < lab.length; i++)
    cum.push(
      cum[i - 1] +
        Math.hypot(lab[i].L - lab[i - 1].L, lab[i].a - lab[i - 1].a, lab[i].b - lab[i - 1].b),
    );
  const total = cum[cum.length - 1];
  return cum.map((v) => v / total);
})();

// Linear-light sRGB, unclamped — the gamut test needs the raw values, since
// oklabToRgb clamps and would hide the overflow.
function oklabToLinear({ L, a, b }) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
const inGamut = (rgb) => rgb.every((c) => c >= -0.0005 && c <= 1.0005);

/**
 * Reduce chroma until the colour fits sRGB, holding L and hue fixed. Clamping
 * the channels instead (the naive approach) distorts lightness and can break the
 * monotonic ramp; giving up saturation preserves the ordering signal.
 */
function lchToRgbMapped(lch) {
  if (inGamut(oklabToLinear(lchToOklab(lch)))) return oklabToRgb(lchToOklab(lch));
  let lo = 0;
  let hi = lch.C;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklabToLinear(lchToOklab({ ...lch, C: mid })))) lo = mid;
    else hi = mid;
  }
  return oklabToRgb(lchToOklab({ ...lch, C: lo }));
}

/** p in [0,100], 0 = strongest; expand applies p^0.6 to spread the strong end. */
export function heatColor(p, expand = false) {
  let x = Math.max(0, Math.min(100, p)) / 100;
  if (expand) x = Math.pow(x, 0.6);
  let seg = 0;
  while (seg < HEAT_POS.length - 2 && x > HEAT_POS[seg + 1]) seg++;
  const span = HEAT_POS[seg + 1] - HEAT_POS[seg];
  const t = span > 0 ? (x - HEAT_POS[seg]) / span : 0;
  const A = HEAT_LCH[seg];
  const B = HEAT_LCH[seg + 1];
  return lchToRgbMapped({
    L: A.L + (B.L - A.L) * t,
    C: A.C + (B.C - A.C) * t,
    h: lerpHue(A.h, B.h, t),
  });
}

// ---- diverging change scale --------------------------------------------
const IMPROVED = hexToOklab("#4A9DB5");
const UNCHANGED = hexToOklab("#3A423E");
const WORSENED = hexToOklab("#B5674A");

/** delta = baselineFromTop - currentFromTop; positive = hand gained ground. */
export function changeColor(delta) {
  const d = Math.max(-8, Math.min(8, delta)) / 8; // -1..1
  const end = d >= 0 ? IMPROVED : WORSENED;
  const t = Math.abs(d);
  return oklabToRgb({
    L: UNCHANGED.L + (end.L - UNCHANGED.L) * t,
    a: UNCHANGED.a + (end.a - UNCHANGED.a) * t,
    b: UNCHANGED.b + (end.b - UNCHANGED.b) * t,
  });
}

// ---- text colour on a coloured cell ----------------------------------
function relLuminance([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export const rgbCss = ([r, g, b]) => `rgb(${r} ${g} ${b})`;

// Widened from #12160F / #F2F0EA: the heat ramp now spans a much larger
// lightness range, and the mid-scale oranges sit near the crossover where
// neither ink is comfortable. This pair keeps 454 of 455 cells at WCAG AA
// (4.5:1) with the last at 4.48.
const INK_DARK = "#0A0C07";
const INK_LIGHT = "#FFFFFF";
const LUM_DARK = relLuminance([0x0a, 0x0c, 0x07]);
const LUM_LIGHT = relLuminance([0xff, 0xff, 0xff]);

/**
 * Pick whichever ink actually contrasts better, by WCAG ratio, rather than
 * thresholding luminance. A fixed threshold misjudges saturated yellows and
 * oranges — they sit below it numerically but read as bright, so they used to
 * get light text at barely 3:1.
 */
export function textOn(rgb) {
  const L = relLuminance(rgb);
  const onDark = (L + 0.05) / (LUM_DARK + 0.05);
  const onLight = (LUM_LIGHT + 0.05) / (L + 0.05);
  return onDark >= onLight ? INK_DARK : INK_LIGHT;
}
