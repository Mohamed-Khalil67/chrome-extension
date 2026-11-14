import { BoxDimensions, InspectedElementData } from '../core/models/debugger';

export class DomDiagnosticEngine {
  static parsePixels(val: string): number {
    const num = parseFloat(val);
    return isNaN(num) ? 0 : Math.round(num);
  }

  static inspectElement(el: Element): InspectedElementData {
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    const dimensions: BoxDimensions = {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      margin: {
        top: this.parsePixels(cs.marginTop),
        right: this.parsePixels(cs.marginRight),
        bottom: this.parsePixels(cs.marginBottom),
        left: this.parsePixels(cs.marginLeft)
      },
      border: {
        top: this.parsePixels(cs.borderTopWidth),
        right: this.parsePixels(cs.borderRightWidth),
        bottom: this.parsePixels(cs.borderBottomWidth),
        left: this.parsePixels(cs.borderLeftWidth)
      },
      padding: {
        top: this.parsePixels(cs.paddingTop),
        right: this.parsePixels(cs.paddingRight),
        bottom: this.parsePixels(cs.paddingBottom),
        left: this.parsePixels(cs.paddingLeft)
      }
    };

    const warnings: string[] = [];

    // Diagnostic 1: Horizontal viewport overflow
    if (rect.right > window.innerWidth + 1) {
      warnings.push(`Element extends ${Math.round(rect.right - window.innerWidth)}px beyond the viewport width (potential horizontal scrollbar).`);
    }

    // Diagnostic 2: Internal scroll overflow
    if (el.scrollWidth > el.clientWidth && cs.overflowX !== 'hidden' && cs.overflowX !== 'scroll' && cs.overflowX !== 'auto') {
      warnings.push('Content overflows horizontally and may cause unexpected clipping or scrolling.');
    }

    // Diagnostic 3: Invisible interactive element
    const interactiveTags = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);
    if (interactiveTags.has(el.tagName)) {
      if (dimensions.width === 0 || dimensions.height === 0) {
        warnings.push('Interactive element has zero width or height and cannot be clicked by users.');
      } else if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) {
        warnings.push('Interactive element is hidden from view (display:none, visibility:hidden, or opacity:0).');
      }
    }

    // Diagnostic 4: Image accessibility
    if (el.tagName === 'IMG' && !el.hasAttribute('alt')) {
      warnings.push('Image is missing an alt attribute (Accessibility issue: WCAG 1.1.1).');
    }

    // Diagnostic 5: Input without accessible name
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
      const hasAria = el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby');
      const hasId = el.id ? document.querySelector(`label[for="${el.id}"]`) !== null : false;
      const isWrapped = el.closest('label') !== null;
      if (!hasAria && !hasId && !isWrapped && el.getAttribute('type') !== 'hidden') {
        warnings.push('Form input lacks an associated label or aria-label (Accessibility issue).');
      }
    }

    // Build selector
    let selector = el.tagName.toLowerCase();
    if (el.id) {
      selector += `#${el.id}`;
    } else if (el.classList.length > 0) {
      selector += `.${Array.from(el.classList).slice(0, 3).join('.')}`;
    }

    const attributes: Record<string, string> = {};
    for (let i = 0; i < el.attributes.length; i++) {
      const attr = el.attributes[i];
      if (attr && !attr.name.startsWith('data-v-')) {
        attributes[attr.name] = attr.value;
      }
    }

    return {
      tagName: el.tagName.toLowerCase(),
      id: el.id,
      selector,
      classes: Array.from(el.classList),
      dimensions,
      computedStyles: {
        display: cs.display,
        position: cs.position,
        overflow: cs.overflow,
        flexDirection: cs.display.includes('flex') ? cs.flexDirection : undefined,
        gridTemplateColumns: cs.display.includes('grid') ? cs.gridTemplateColumns : undefined,
        zIndex: cs.zIndex,
        boxSizing: cs.boxSizing
      },
      warnings,
      attributes
    };
  }
}

// Global inspector helper on window for devtools eval
if (typeof window !== 'undefined') {
  (window as unknown as { __FRONTEND_LENS_INSPECT__: (el: Element | null) => string }).__FRONTEND_LENS_INSPECT__ = (el: Element | null) => {
    const target = el || document.activeElement || document.body;
    if (!target) return JSON.stringify({ error: 'No element found' });
    try {
      return JSON.stringify(DomDiagnosticEngine.inspectElement(target));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return JSON.stringify({ error: msg });
    }
  };
}
