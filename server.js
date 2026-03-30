// Nexus Browser Server
// Empfängt HTML-String von Roblox, gibt fertigen Layout-Baum als JSON zurück.
// Verwendet jsdom + css-tree für echtes CSS-Parsing und Layout-Berechnung.

const express = require("express");
const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

// ─── Farb-Parser ──────────────────────────────────────────────────────────────
function parseColor(str) {
  if (!str || str === "transparent" || str === "none") return null;
  str = str.trim();

  // rgb / rgba
  const rgb = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3] };

  // #rrggbb / #rgb
  if (str.startsWith("#")) {
    let hex = str.slice(1);
    if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
  }

  // Named colors (die wichtigsten)
  const NAMED = {
    white: [255,255,255], black: [0,0,0], red: [255,0,0],
    green: [0,128,0], blue: [0,0,255], gray: [128,128,128],
    grey: [128,128,128], yellow: [255,255,0], orange: [255,165,0],
    purple: [128,0,128], pink: [255,192,203], brown: [165,42,42],
    transparent: null,
  };
  const named = NAMED[str.toLowerCase()];
  if (named === null) return null;
  if (named) return { r: named[0], g: named[1], b: named[2] };

  return null;
}

// ─── CSS-Wert-Parser ──────────────────────────────────────────────────────────
const DEFAULT_FONT_SIZE = 16;
const LINE_HEIGHT_RATIO = 1.2;

function resolveLength(value, fontSize = DEFAULT_FONT_SIZE, containerWidth = 800) {
  if (!value || value === "auto" || value === "none" || value === "inherit") return null;
  value = String(value).trim();
  const px = value.match(/^([\d.]+)px$/);   if (px)  return +px[1];
  const em = value.match(/^([\d.]+)em$/);   if (em)  return +em[1] * fontSize;
  const rem = value.match(/^([\d.]+)rem$/); if (rem) return +rem[1] * DEFAULT_FONT_SIZE;
  const pct = value.match(/^([\d.]+)%$/);   if (pct) return (+pct[1] / 100) * containerWidth;
  const num = parseFloat(value);
  return isNaN(num) ? null : num;
}

function resolve4(style, short, topK, rightK, bottomK, leftK, fs, cw) {
  const parts = (style[short] || "").trim().split(/\s+/).map(v => resolveLength(v, fs, cw) || 0);
  let t = 0, r = 0, b = 0, l = 0;
  if (parts.length === 1) { t = r = b = l = parts[0]; }
  else if (parts.length === 2) { t = b = parts[0]; r = l = parts[1]; }
  else if (parts.length === 3) { t = parts[0]; r = l = parts[1]; b = parts[2]; }
  else if (parts.length >= 4) { [t, r, b, l] = parts; }
  return {
    top:    resolveLength(style[topK],    fs, cw) ?? t,
    right:  resolveLength(style[rightK],  fs, cw) ?? r,
    bottom: resolveLength(style[bottomK], fs, cw) ?? b,
    left:   resolveLength(style[leftK],   fs, cw) ?? l,
  };
}

function parseBorder(value, fs, cw) {
  if (!value || value === "none") return 0;
  const pxMatch = value.match(/(\d+)px/);
  if (pxMatch) return +pxMatch[1];
  if (value.match(/\bsolid\b|\bdashed\b|\bdotted\b/)) return 1;
  return 0;
}

function parseBorderRadius(value, fs, cw) {
  if (!value) return 0;
  const m = value.match(/^([\d.]+)(px|em|rem|%)?/);
  if (!m) return 0;
  const n = +m[1];
  const unit = m[2] || "px";
  if (unit === "em")  return n * fs;
  if (unit === "rem") return n * DEFAULT_FONT_SIZE;
  if (unit === "%")   return n; // simplified
  return n;
}

// ─── JSDOM-basierter Layout-Builder ─────────────────────────────────────────
const { JSDOM } = require("jsdom");

function buildLayoutNode(domNode, computedStyles, containerWidth, offsetX, offsetY) {
  if (!domNode || domNode.nodeType === 8) return null; // Comment

  // Text-Node
  if (domNode.nodeType === 3) {
    const text = (domNode.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    const parent = domNode.parentElement;
    const ps = parent ? computedStyles.get(parent) || {} : {};
    const fs = resolveLength(ps["font-size"]) || DEFAULT_FONT_SIZE;
    const lh = fs * LINE_HEIGHT_RATIO;
    // Schätze Textbreite (Server hat kein TextService)
    const charW = fs * 0.5;
    const estW = Math.min(text.length * charW, containerWidth - offsetX);
    return {
      type: "text",
      text,
      x: offsetX,
      y: offsetY,
      width: estW,
      height: lh,
      fontSize: fs,
      lineHeight: lh,
      fontWeight: ps["font-weight"] || "normal",
      fontStyle: ps["font-style"] || "normal",
      textDecoration: ps["text-decoration"] || "none",
      fontFamily: ps["font-family"] || "sans-serif",
      textAlign: ps["text-align"] || "left",
      color: parseColor(ps["color"] || "rgb(0,0,0)"),
    };
  }

  if (domNode.nodeType !== 1) return null; // Kein Element

  const el = domNode;
  const tag = el.tagName.toLowerCase();

  // Unsichtbare Tags überspringen
  if (["script", "style", "head", "meta", "link", "title", "noscript"].includes(tag)) return null;

  const style = computedStyles.get(el) || {};
  const display = style["display"] || "block";
  if (display === "none") return null;

  const fs = resolveLength(style["font-size"]) || DEFAULT_FONT_SIZE;
  const lh = style["line-height"]
    ? (resolveLength(style["line-height"], fs, containerWidth) || fs * LINE_HEIGHT_RATIO)
    : fs * LINE_HEIGHT_RATIO;

  // Box-Model
  const pad  = resolve4(style, "padding",       "padding-top","padding-right","padding-bottom","padding-left", fs, containerWidth);
  const mar  = resolve4(style, "margin",         "margin-top","margin-right","margin-bottom","margin-left", fs, containerWidth);
  const bord = resolve4(style, "border-width",   "border-top-width","border-right-width","border-bottom-width","border-left-width", fs, containerWidth);

  // Wenn border shorthand gesetzt, nutze das
  const borderW = parseBorder(style["border"], fs, containerWidth);
  if (borderW > 0) {
    bord.top = bord.right = bord.bottom = bord.left = borderW;
  }

  // Dimensionen
  const explicitW = resolveLength(style["width"], fs, containerWidth);
  const explicitH = resolveLength(style["height"], fs, containerWidth);

  // Position
  const position = style["position"] || "static";
  let boxX = offsetX + mar.left;
  let boxY = offsetY + mar.top;

  if (position === "absolute" || position === "fixed") {
    const left = resolveLength(style["left"], fs, containerWidth);
    const top  = resolveLength(style["top"],  fs, containerWidth);
    if (left !== null) boxX = left;
    if (top  !== null) boxY = top;
  }

  const innerX = boxX + bord.left + pad.left;
  const innerY = boxY + bord.top  + pad.top;
  const innerW = (explicitW != null)
    ? explicitW - pad.left - pad.right - bord.left - bord.right
    : containerWidth - boxX - pad.right - bord.right - mar.right;

  // Attribute
  const attrs = {};
  for (const attr of el.attributes) {
    attrs[attr.name] = attr.value;
  }

  // Kinder-Nodes rendern
  const children = [];
  let childY = innerY;
  let childX = innerX;
  const isFlex = display === "flex" || display === "inline-flex";
  const isGrid = display === "grid" || display === "inline-grid";
  const flexDir = style["flex-direction"] || "row";
  const gap = resolveLength(style["gap"] || style["column-gap"], fs, innerW) || 0;

  for (const child of el.childNodes) {
    const childNode = buildLayoutNode(child, computedStyles, innerW, isFlex ? childX - innerX : 0, isFlex ? childY - innerY : childY - innerY);
    if (!childNode) continue;

    if (isFlex && flexDir === "row") {
      childNode.x = childX - innerX;
      childNode.y = innerY - innerY; // 0
      childX += childNode.width + gap;
    } else {
      childNode.x = childNode.x;
      childNode.y = childY - innerY;
      childY += childNode.height + (childNode.marginBottom || 0);
    }

    children.push(childNode);
  }

  const contentH = isFlex
    ? Math.max(...children.map(c => c.height), 0)
    : children.reduce((sum, c) => sum + c.height, 0);

  const boxW = explicitW != null ? explicitW : containerWidth - mar.left - mar.right;
  const boxH = explicitH != null ? explicitH
    : pad.top + pad.bottom + bord.top + bord.bottom + contentH;

  return {
    type: "element",
    tag,
    attrs,
    x: boxX - offsetX, // relativ zum Parent
    y: boxY - offsetY,
    width: Math.max(boxW, 0),
    height: Math.max(boxH, 0),
    paddingTop: pad.top, paddingRight: pad.right,
    paddingBottom: pad.bottom, paddingLeft: pad.left,
    marginTop: mar.top, marginRight: mar.right,
    marginBottom: mar.bottom, marginLeft: mar.left,
    borderTop: bord.top, borderRight: bord.right,
    borderBottom: bord.bottom, borderLeft: bord.left,
    borderRadius: parseBorderRadius(style["border-radius"] || style["border-top-left-radius"], fs, containerWidth),
    borderColor: parseColor(style["border-color"] || style["border-top-color"]),
    backgroundColor: parseColor(style["background-color"] || style["background"]),
    color: parseColor(style["color"]),
    fontSize: fs,
    lineHeight: lh,
    fontWeight: style["font-weight"] || "normal",
    fontStyle: style["font-style"] || "normal",
    fontFamily: style["font-family"] || "sans-serif",
    textDecoration: style["text-decoration"] || "none",
    textAlign: style["text-align"] || "left",
    display,
    position,
    opacity: parseFloat(style["opacity"] || "1"),
    overflow: style["overflow"] || "visible",
    zIndex: parseInt(style["z-index"] || "0"),
    flexDirection: flexDir,
    gap,
    children,
  };
}

// ─── Computed Styles via JSDOM ────────────────────────────────────────────────
function extractComputedStyles(document, window) {
  const map = new Map();

  function walkElement(el) {
    if (el.nodeType !== 1) return;
    try {
      const cs = window.getComputedStyle(el);
      const style = {};
      const PROPS = [
        "display","position","width","height","min-width","min-height","max-width","max-height",
        "padding","padding-top","padding-right","padding-bottom","padding-left",
        "margin","margin-top","margin-right","margin-bottom","margin-left",
        "border","border-width","border-top-width","border-right-width","border-bottom-width","border-left-width",
        "border-color","border-top-color","border-style",
        "border-radius","border-top-left-radius","border-top-right-radius",
        "background-color","background","color",
        "font-size","font-weight","font-style","font-family","line-height",
        "text-align","text-decoration","white-space",
        "flex-direction","gap","column-gap","row-gap","flex-wrap",
        "top","left","right","bottom","z-index","overflow","opacity",
        "list-style-type",
      ];
      for (const prop of PROPS) {
        const val = cs.getPropertyValue(prop);
        if (val) style[prop] = val;
      }
      map.set(el, style);
    } catch (e) {}
    for (const child of el.children) walkElement(child);
  }

  walkElement(document.documentElement);
  return map;
}

// ─── Inline-CSS injizieren (aus <style>-Tags) ─────────────────────────────────
// JSDOM verarbeitet <style> bereits nativ – kein manuelles Parsen nötig.

// ─── API Endpoints ────────────────────────────────────────────────────────────

// POST /render  – Hauptendpoint
// Body: { html: "<html>...", viewportWidth: 800, viewportHeight: 600 }
app.post("/render", async (req, res) => {
  const { html, viewportWidth = 800, viewportHeight = 600 } = req.body;

  if (!html || typeof html !== "string") {
    return res.status(400).json({ error: "Missing html field" });
  }

  try {
    const dom = new JSDOM(html, {
      pretendToBeVisual: true,
      resources: "usable",
      runScripts: "outside-only",
    });

    const { window } = dom;
    const { document } = window;

    // Warte kurz auf DOM-Initialisierung
    await new Promise(r => setTimeout(r, 50));

    const computedStyles = extractComputedStyles(document, window);
    const layoutRoot = buildLayoutNode(document.body || document.documentElement, computedStyles, viewportWidth, 0, 0);

    // Gesamthöhe berechnen
    const totalHeight = layoutRoot ? layoutRoot.height : viewportHeight;

    window.close();

    res.json({
      ok: true,
      viewport: { width: viewportWidth, height: viewportHeight },
      totalHeight,
      tree: layoutRoot,
    });
  } catch (err) {
    console.error("Render error:", err);
    res.status(500).json({ error: String(err.message) });
  }
});

// GET /health
app.get("/health", (_, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`Nexus Render Server läuft auf Port ${PORT}`));
