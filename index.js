const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));

// ── Puppeteer Browser (einmal starten, wiederverwenden) ───────────────────────
let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
      ],
    });
  }
  return browser;
}

// ── Hilfsfunktion: Farbe parsen ───────────────────────────────────────────────
function parseColor(str) {
  if (!str || str === 'transparent' || str === 'rgba(0, 0, 0, 0)') return null;
  const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  return null;
}

// ── Haupt-Endpoint: POST /render ──────────────────────────────────────────────
// Body: { html: "...", viewportWidth: 800, viewportHeight: 600 }
app.post('/render', async (req, res) => {
  const { html, viewportWidth = 800, viewportHeight = 600 } = req.body;

  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'Missing html field' });
  }

  let page = null;

  try {
    const b = await getBrowser();
    page = await b.newPage();

    await page.setViewport({ width: viewportWidth, height: viewportHeight });

    // HTML direkt laden (kein HTTP-Request nötig)
    await page.setContent(html, { waitUntil: 'domcontentloaded' });

    // ── Alle Elemente mit echtem Layout extrahieren ───────────────────────────
    const tree = await page.evaluate((vw, vh) => {
      const SKIP_TAGS = new Set([
        'script', 'style', 'head', 'meta', 'link',
        'title', 'noscript', 'template',
      ]);

      function extractNode(el) {
        if (!el || el.nodeType !== 1) return null;

        const tag = el.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) return null;

        const rect   = el.getBoundingClientRect();
        const cs     = window.getComputedStyle(el);

        // Unsichtbare Elemente überspringen
        if (cs.display === 'none' || cs.visibility === 'hidden') return null;
        if (rect.width === 0 && rect.height === 0) return null;

        // Text-Inhalt (nur direkter Text, nicht aus Kindern)
        let directText = '';
        for (const child of el.childNodes) {
          if (child.nodeType === 3) {
            const t = child.textContent.replace(/\s+/g, ' ').trim();
            if (t) directText += t + ' ';
          }
        }
        directText = directText.trim();

        // Attribute
        const attrs = {};
        for (const attr of el.attributes) {
          attrs[attr.name] = attr.value;
        }

        // Border-Radius parsen
        const br = parseFloat(cs.borderRadius) || 0;

        // Border-Dicke
        const borderTop    = parseFloat(cs.borderTopWidth)    || 0;
        const borderRight  = parseFloat(cs.borderRightWidth)  || 0;
        const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
        const borderLeft   = parseFloat(cs.borderLeftWidth)   || 0;

        // Border-Farbe
        const borderColor = cs.borderTopColor || null;

        // Kinder rekursiv
        const children = [];
        for (const child of el.children) {
          const node = extractNode(child);
          if (node) children.push(node);
        }

        return {
          tag,
          attrs,
          text: directText || null,

          // Exakte Pixel-Position (relativ zum Viewport)
          x:      Math.round(rect.left),
          y:      Math.round(rect.top),
          width:  Math.round(rect.width),
          height: Math.round(rect.height),

          // Visuelles
          backgroundColor: cs.backgroundColor,
          color:           cs.color,
          borderRadius:    br,
          borderTop,
          borderRight,
          borderBottom,
          borderLeft,
          borderColor,
          opacity:  parseFloat(cs.opacity) || 1,
          overflow: cs.overflow,
          zIndex:   parseInt(cs.zIndex) || 0,

          // Text-Styling
          fontSize:       parseFloat(cs.fontSize)  || 16,
          fontWeight:     cs.fontWeight,
          fontStyle:      cs.fontStyle,
          fontFamily:     cs.fontFamily,
          lineHeight:     cs.lineHeight,
          textAlign:      cs.textAlign,
          textDecoration: cs.textDecoration,
          whiteSpace:     cs.whiteSpace,

          children,
        };
      }

      const body = document.body;
      if (!body) return null;

      // Body-Hintergrundfarbe lesen
      const bodyCs = window.getComputedStyle(body);
      const bodyRect = body.getBoundingClientRect();

      // Gesamthöhe der Seite
      const totalHeight = Math.max(
        body.scrollHeight,
        document.documentElement.scrollHeight
      );

      const children = [];
      for (const child of body.children) {
        const node = extractNode(child);
        if (node) children.push(node);
      }

      return {
        tag: 'body',
        x: 0, y: 0,
        width: vw,
        height: totalHeight,
        backgroundColor: bodyCs.backgroundColor,
        color: bodyCs.color,
        fontSize: parseFloat(bodyCs.fontSize) || 16,
        fontFamily: bodyCs.fontFamily,
        attrs: {},
        text: null,
        borderRadius: 0,
        borderTop: 0, borderRight: 0,
        borderBottom: 0, borderLeft: 0,
        borderColor: null,
        opacity: 1,
        overflow: 'visible',
        zIndex: 0,
        fontWeight: bodyCs.fontWeight,
        fontStyle: 'normal',
        lineHeight: bodyCs.lineHeight,
        textAlign: bodyCs.textAlign,
        textDecoration: 'none',
        whiteSpace: 'normal',
        children,
      };
    }, viewportWidth, viewportHeight);

    await page.close();
    page = null;

    // Gesamthöhe aus dem Tree lesen
    const totalHeight = tree ? tree.height : viewportHeight;

    res.json({
      ok: true,
      viewport: { width: viewportWidth, height: viewportHeight },
      totalHeight,
      tree,
    });

  } catch (err) {
    if (page) await page.close().catch(() => {});
    console.error('Render error:', err);
    res.status(500).json({ error: String(err.message) });
  }
});

// ── Alter Endpoint bleibt (Kompatibilität) ────────────────────────────────────
app.get('/parse', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Keine URL angegeben' });
  try {
    const b = await getBrowser();
    const page = await b.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    const html = await page.content();
    await page.close();
    res.json({ ok: true, html });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health-Check ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Nexus Render Server läuft auf Port ${PORT}`);
  // Browser vorwärmen
  getBrowser().then(() => console.log('Puppeteer bereit'));
});
