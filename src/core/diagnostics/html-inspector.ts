import { HtmlDiagnosisResult } from '../models/debugger';

export class HtmlInspector {
  static analyze(html: string): HtmlDiagnosisResult {
    if (!html || !html.trim()) {
      return {
        strategy: 'undetermined',
        title: 'Empty Document',
        description: 'The server returned an empty HTML document response.',
        elementCount: 0,
        hasRenderedText: false,
        detectedShellTags: []
      };
    }

    const lower = html.toLowerCase();
    const detectedShellTags: string[] = [];

    // Check for common client-side rendering root tags
    const shellPatterns = [
      { name: '<app-root>', pattern: /<app-root[^>]*>\s*<\/app-root>/i },
      { name: '<div id="root">', pattern: /<div[^>]*id=["']root["'][^>]*>\s*<\/div>/i },
      { name: '<div id="app">', pattern: /<div[^>]*id=["']app["'][^>]*>\s*<\/div>/i },
      { name: '<div id="__next">', pattern: /<div[^>]*id=["']__next["'][^>]*>\s*<\/div>/i }
    ];

    for (const item of shellPatterns) {
      if (item.pattern.test(html)) {
        detectedShellTags.push(item.name);
      }
    }

    // Extract content inside body if present
    let bodyContent = html;
    const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    if (bodyMatch && bodyMatch[1]) {
      bodyContent = bodyMatch[1];
    }

    // Remove script and style tags to measure actual rendered markup/text
    const strippedScripts = bodyContent
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');

    // Extract text characters
    const textOnly = strippedScripts.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // Count content-bearing HTML elements
    const elementMatches = strippedScripts.match(/<(p|h[1-6]|article|section|main|li|table|tr|td|span|div)\b[^>]*>/gi);
    const elementCount = elementMatches ? elementMatches.length : 0;
    const hasRenderedText = textOnly.length > 80;

    if (detectedShellTags.length > 0 && textOnly.length < 50) {
      return {
        strategy: 'client-shell',
        title: 'Initial HTML appears to contain an application shell',
        description: `Found empty root placeholder ${detectedShellTags.join(', ')}. Client-side JavaScript likely renders the page content (CSR).`,
        elementCount,
        hasRenderedText,
        detectedShellTags
      };
    }

    if (hasRenderedText && elementCount >= 5) {
      return {
        strategy: 'rendered-content',
        title: 'Initial HTML contains rendered content',
        description: `Server delivered structured HTML content with ${elementCount} rendered elements and substantial text. Indicates Server-Side Rendering (SSR) or Static Site Generation (SSG).`,
        elementCount,
        hasRenderedText,
        detectedShellTags
      };
    }

    return {
      strategy: 'undetermined',
      title: 'Rendering strategy cannot be determined',
      description: 'Initial HTML contains minimal markup without obvious client-side shells or large rendered DOM trees.',
      elementCount,
      hasRenderedText,
      detectedShellTags
    };
  }
}
