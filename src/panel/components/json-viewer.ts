export class JsonViewer {
  static render(data: unknown, container: HTMLElement): void {
    container.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'json-viewer-tree';
    root.appendChild(this.buildNode(data, true));
    container.appendChild(root);
  }

  private static buildNode(val: unknown, isRoot: boolean = false): HTMLElement {
    const node = document.createElement('div');
    node.className = 'json-node';

    if (val === null) {
      const span = document.createElement('span');
      span.className = 'json-null';
      span.textContent = 'null';
      node.appendChild(span);
      return node;
    }

    if (typeof val === 'boolean') {
      const span = document.createElement('span');
      span.className = 'json-boolean';
      span.textContent = String(val);
      node.appendChild(span);
      return node;
    }

    if (typeof val === 'number') {
      const span = document.createElement('span');
      span.className = 'json-number';
      span.textContent = String(val);
      node.appendChild(span);
      return node;
    }

    if (typeof val === 'string') {
      const span = document.createElement('span');
      span.className = 'json-string';
      span.textContent = JSON.stringify(val);
      node.appendChild(span);
      return node;
    }

    if (Array.isArray(val)) {
      const isExpanded = isRoot || val.length <= 5;
      const toggle = document.createElement('span');
      toggle.className = `json-toggle ${isExpanded ? 'open' : 'closed'}`;
      toggle.textContent = isExpanded ? '▼' : '▶';

      const label = document.createElement('span');
      label.className = 'json-bracket';
      label.textContent = `Array [${val.length}]`;

      const header = document.createElement('div');
      header.className = 'json-node-header';
      header.appendChild(toggle);
      header.appendChild(label);
      node.appendChild(header);

      const children = document.createElement('div');
      children.className = `json-children ${isExpanded ? '' : 'collapsed'}`;

      val.forEach((item, index) => {
        const itemRow = document.createElement('div');
        itemRow.className = 'json-item-row';
        const indexSpan = document.createElement('span');
        indexSpan.className = 'json-index';
        indexSpan.textContent = `${index}: `;
        itemRow.appendChild(indexSpan);
        itemRow.appendChild(this.buildNode(item));
        children.appendChild(itemRow);
      });

      node.appendChild(children);

      toggle.onclick = (e) => {
        e.stopPropagation();
        const currentlyOpen = toggle.classList.contains('open');
        toggle.classList.toggle('open', !currentlyOpen);
        toggle.classList.toggle('closed', currentlyOpen);
        toggle.textContent = currentlyOpen ? '▶' : '▼';
        children.classList.toggle('collapsed', currentlyOpen);
      };

      return node;
    }

    if (typeof val === 'object') {
      const entries = Object.entries(val);
      const isExpanded = isRoot || entries.length <= 8;

      const toggle = document.createElement('span');
      toggle.className = `json-toggle ${isExpanded ? 'open' : 'closed'}`;
      toggle.textContent = isExpanded ? '▼' : '▶';

      const label = document.createElement('span');
      label.className = 'json-bracket';
      label.textContent = `Object {${entries.length}}`;

      const header = document.createElement('div');
      header.className = 'json-node-header';
      header.appendChild(toggle);
      header.appendChild(label);
      node.appendChild(header);

      const children = document.createElement('div');
      children.className = `json-children ${isExpanded ? '' : 'collapsed'}`;

      entries.forEach(([k, v]) => {
        const propRow = document.createElement('div');
        propRow.className = 'json-prop-row';
        const keySpan = document.createElement('span');
        keySpan.className = 'json-key';
        keySpan.textContent = `"${k}": `;
        propRow.appendChild(keySpan);
        propRow.appendChild(this.buildNode(v));
        children.appendChild(propRow);
      });

      node.appendChild(children);

      toggle.onclick = (e) => {
        e.stopPropagation();
        const currentlyOpen = toggle.classList.contains('open');
        toggle.classList.toggle('open', !currentlyOpen);
        toggle.classList.toggle('closed', currentlyOpen);
        toggle.textContent = currentlyOpen ? '▶' : '▼';
        children.classList.toggle('collapsed', currentlyOpen);
      };

      return node;
    }

    const fallback = document.createElement('span');
    fallback.textContent = String(val);
    node.appendChild(fallback);
    return node;
  }
}
