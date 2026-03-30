const express = require('express');
const { JSDOM } = require('jsdom');
const app = express();
const PORT = process.env.PORT || 3000;

// Hilfsfunktion: Wandelt CSS-Farben (rgb/hex) in ein Array [R, G, B] um
function parseColor(color) {
    if (!color) return [255, 255, 255];
    // Vereinfachte Logik für Roblox
    return [255, 255, 255]; // Hier könnte eine echte Lib wie 'color-string' genutzt werden
}

app.get('/parse', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: "Keine URL angegeben" });

    try {
        const dom = await JSDOM.fromURL(targetUrl);
        const { document } = dom.window;

        // Wir extrahieren nur das, was Roblox wirklich braucht
        const simplify = (node) => {
            if (node.nodeType !== 1) return null; // Nur Element-Nodes

            const computed = dom.window.getComputedStyle(node);
            
            return {
                tag: node.tagName.toLowerCase(),
                text: node.textContent.trim().substring(0, 100), // Text-Vorschau
                style: {
                    display: computed.display,
                    color: computed.color,
                    backgroundColor: computed.backgroundColor,
                    width: computed.width,
                    height: computed.height
                },
                children: Array.from(node.children).map(simplify).filter(n => n !== null)
            };
        };

        const vDom = simplify(document.body);
        res.json(vDom);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Parser-Server läuft auf Port ${PORT}`);
});