import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';


const TEMPLATE_URL = new URL('../../app/templates/index.html', import.meta.url);
const CSS_URL = new URL('../../app/static/css/main.css', import.meta.url);
const COMMAND_PALETTE_CONTROLLER_URL = new URL(
    '../../app/static/js/modules/command-palette/command-palette-controller.js',
    import.meta.url,
);


test('enabled tabs expose an outline folder indicator inside the hover trigger', async () => {
    const [templateSource, cssSource, commandPaletteControllerSource] = await Promise.all([
        readFile(TEMPLATE_URL, 'utf8'),
        readFile(CSS_URL, 'utf8'),
        readFile(COMMAND_PALETTE_CONTROLLER_URL, 'utf8'),
    ]);

    const hoverZoneStart = templateSource.indexOf('id="tab-hover-zone"');
    const hoverZoneEnd = templateSource.indexOf('</div>', hoverZoneStart);
    const hoverZoneSource = templateSource.slice(hoverZoneStart, hoverZoneEnd);

    assert.ok(hoverZoneStart >= 0);
    assert.ok(hoverZoneEnd > hoverZoneStart);
    assert.match(hoverZoneSource, /class="tab-ui-folder-icon"/);
    assert.match(hoverZoneSource, /class="tab-ui-folder-icon-back"/);
    assert.match(hoverZoneSource, /class="tab-ui-folder-icon-front"/);
    assert.match(
        hoverZoneSource,
        /class="tab-ui-folder-icon-back"[\s\S]*V20a2\.5 2\.5 0 0 1-2\.5 2\.5H12A2\.5 2\.5 0 0 1 9\.5 20z/,
    );
    assert.match(cssSource, /\.controls \.tab-ui-folder-icon\s*\{[\s\S]*stroke: var\(--search-shell-ink\);/);
    assert.match(
        cssSource,
        /\.controls \.tab-ui-folder-icon\s*\{[\s\S]*left: 6px;[\s\S]*transform: translateY\(-50%\);/,
    );
    assert.match(
        cssSource,
        /\.controls \.search-results-count\s*\{[\s\S]*right: 6px;/,
    );
    assert.match(
        templateSource,
        /id="search-results-count" class="search-results-count">0<\/div>/,
    );
    assert.match(
        cssSource,
        /\.controls \.search-results-count\s*\{[\s\S]*flex-direction: column;[\s\S]*align-items: flex-end;/,
    );
    assert.match(
        cssSource,
        /\.controls \.search-controls\s*\{[\s\S]*--search-input-width:\s*clamp\(140px, calc\(100% - 184px\), 500px\);[\s\S]*--search-input-half-width:\s*clamp\(70px, calc\(50% - 92px\), 250px\);/,
    );
    assert.doesNotMatch(
        cssSource,
        /@container search-shell \(max-width: 440px\)\s*\{[\s\S]*?\.controls \.search-results-count\s*\{[\s\S]*?display:\s*none;/,
    );
    assert.match(
        cssSource,
        /body:not\(\.pref-show-search-results-count\) \.controls \.search-results-count\s*\{[\s\S]*?display:\s*none;/,
    );
    assert.match(
        commandPaletteControllerSource,
        /'pref\.show_search_results_count',[\s\S]*?true,[\s\S]*?'pref-show-search-results-count'/,
    );
    assert.match(cssSource, /\.controls \.tab-ui-folder-icon-front\s*\{[\s\S]*fill: var\(--search-shell-surface\);/);
    assert.match(
        cssSource,
        /body\.pref-show-tab-ui \.controls \.tab-ui-folder-icon\s*\{[\s\S]*opacity: 0\.78;/,
    );
});


test('the light theme search bar is black with white, readable controls', async () => {
    const cssSource = await readFile(new URL('../../app/static/css/main.css', import.meta.url), 'utf8');
    const rootTokens = cssSource.match(/:root\s*\{([^}]*)\}/);
    assert.ok(rootTokens, 'expected the :root token block');
    // A token is #rrggbb, or rgba(r, g, b, a) composited over the bar.
    const colourToken = (name, over) => {
        const hex = rootTokens[1].match(new RegExp(`--${name}:\\s*#([0-9a-f]{6})`, 'i'));
        if (hex) {
            return [0, 2, 4].map((offset) => parseInt(hex[1].slice(offset, offset + 2), 16));
        }
        const rgba = rootTokens[1].match(new RegExp(`--${name}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([0-9.]+)\\)`, 'i'));
        assert.ok(rgba, `expected --${name} in :root as #rrggbb or rgba()`);
        const alpha = Number(rgba[4]);
        return [1, 2, 3].map((index, channel) => Number(rgba[index]) * alpha + over[channel] * (1 - alpha));
    };
    const luminance = (channels) => {
        const [r, g, b] = channels.map((channel) => {
            const value = channel / 255;
            return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const surface = colourToken('search-shell-surface', [0, 0, 0]);
    const ink = colourToken('search-shell-ink', surface);
    assert.ok(Math.max(...surface) <= 0x10, 'the search bar is black, as it long was');
    assert.ok(Math.min(...ink) >= 0xd0, 'the tabs icon and the count are white on it');
    const contrast = (luminance(ink) + 0.05) / (luminance(surface) + 0.05);
    assert.ok(contrast >= 4.5, `icon and count need 4.5:1 contrast on the bar, got ${contrast.toFixed(2)}`);

    assert.match(cssSource, /(?:^|\n)\.controls\s*\{[^}]*background:\s*var\(--search-shell-surface\)/);
    assert.match(cssSource, /\.controls \.search-results-count\s*\{[^}]*color:\s*var\(--search-shell-ink\)/);
    assert.match(cssSource, /\.controls \.search-validation-message\s*\{[^}]*color:\s*var\(--search-shell-warning\)/);
});


test('dark theme tabs dropdown is an opaque grey panel that stands out from the notes under it', async () => {
    const cssSource = await readFile(new URL('../../app/static/css/main.css', import.meta.url), 'utf8');
    const rule = cssSource.match(/html\[data-theme="dark"\] #search-contexts-list\s*\{([^}]*)\}/);
    assert.ok(rule, 'expected a dark theme rule for the tabs dropdown');
    const background = rule[1].match(/background:\s*#([0-9a-f]{6})\s*;/i);
    assert.ok(background, 'tabs dropdown needs an opaque background so notes do not show through');
    const darkTokens = cssSource.match(/html\[data-theme="dark"\]\s*\{([^}]*)\}/)[1];
    const noteSurface = darkTokens.match(/--app-surface-1:\s*#([0-9a-f]{6})/i)[1];
    const red = (hex) => parseInt(hex.slice(0, 2), 16);
    assert.ok(red(background[1]) - red(noteSurface) >= 24, `#${background[1]} must stand out from notes #${noteSurface}`);
    assert.match(rule[1], /border:\s*1px solid rgba\(255, 255, 255, 0\.\d+\)/);
});
