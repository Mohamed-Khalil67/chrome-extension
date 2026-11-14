import test from 'node:test';
import assert from 'node:assert/strict';
import { HtmlInspector } from '../src/core/diagnostics/html-inspector';

test('HtmlInspector detects empty client-side application shell', () => {
  const csrHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>App</title></head>
      <body>
        <div id="root"></div>
        <script src="/bundle.js"></script>
      </body>
    </html>
  `;
  const result = HtmlInspector.analyze(csrHtml);
  assert.equal(result.strategy, 'client-shell');
  assert.match(result.title, /application shell/i);
  assert.ok(result.detectedShellTags.includes('<div id="root">'));
});

test('HtmlInspector detects server-rendered structured content', () => {
  const ssrHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>Products Store</title></head>
      <body>
        <main>
          <h1>Welcome to our Store</h1>
          <p>Explore our wide selection of developer tools and productivity software.</p>
          <div class="products">
            <article><h2>Tool A</h2><p>High performance debugger for web developers.</p></article>
            <article><h2>Tool B</h2><p>Automated testing platform with zero configuration.</p></article>
            <article><h2>Tool C</h2><p>Real-time analytics engine and monitoring dashboard.</p></article>
          </div>
        </main>
      </body>
    </html>
  `;
  const result = HtmlInspector.analyze(ssrHtml);
  assert.equal(result.strategy, 'rendered-content');
  assert.match(result.title, /rendered content/i);
  assert.equal(result.hasRenderedText, true);
  assert.ok(result.elementCount >= 5);
});
