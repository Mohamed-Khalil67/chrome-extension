import { CollectionFolder, CollectionNode, CollectionRequest, RequestItem } from '../models/workspace';

export class CollectionTreeService {
  /**
   * Recursively gathers all RequestItem objects from a tree of CollectionNodes.
   */
  static flattenRequests(nodes: CollectionNode[]): RequestItem[] {
    const requests: RequestItem[] = [];
    for (const node of nodes) {
      if (node.type === 'request') {
        requests.push(node.request);
      } else if (node.type === 'folder' && Array.isArray(node.children)) {
        requests.push(...this.flattenRequests(node.children));
      }
    }
    return requests;
  }

  /**
   * Recursively finds a node by ID anywhere in the tree.
   */
  static findNode(nodes: CollectionNode[], id: string): CollectionNode | null {
    for (const node of nodes) {
      if (node.id === id) return node;
      if (node.type === 'folder' && Array.isArray(node.children)) {
        const found = this.findNode(node.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Finds the parent folder and index of a node with the given ID.
   * If the node is at the root level, parent is null.
   */
  static findParent(
    nodes: CollectionNode[],
    id: string,
    currentParent: CollectionFolder | null = null
  ): { parent: CollectionFolder | null; index: number } | null {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i]!.id === id) {
        return { parent: currentParent, index: i };
      }
      if (nodes[i]!.type === 'folder') {
        const folder = nodes[i] as CollectionFolder;
        const res = this.findParent(folder.children, id, folder);
        if (res) return res;
      }
    }
    return null;
  }

  /**
   * Inserts a new node into the tree. If parentFolderId is null or not found,
   * inserts at the root of `nodes`.
   */
  static insertNode(nodes: CollectionNode[], parentFolderId: string | null, newNode: CollectionNode): boolean {
    if (!parentFolderId) {
      nodes.push(newNode);
      return true;
    }

    const parentNode = this.findNode(nodes, parentFolderId);
    if (parentNode && parentNode.type === 'folder') {
      parentNode.children.push(newNode);
      return true;
    }

    nodes.push(newNode);
    return false;
  }

  /**
   * Removes a node with the given ID from the tree, returning the removed node or null.
   */
  static removeNode(nodes: CollectionNode[], id: string): CollectionNode | null {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i]!.id === id) {
        return nodes.splice(i, 1)[0] || null;
      }
      if (nodes[i]!.type === 'folder') {
        const folder = nodes[i] as CollectionFolder;
        const removed = this.removeNode(folder.children, id);
        if (removed) return removed;
      }
    }
    return null;
  }

  /**
   * Renames a node with the given ID. If it is a request node, also updates request.name.
   */
  static renameNode(nodes: CollectionNode[], id: string, newName: string): boolean {
    const node = this.findNode(nodes, id);
    if (!node) return false;

    node.name = newName;
    if (node.type === 'request') {
      node.request.name = newName;
      node.request.updatedAt = Date.now();
    }
    return true;
  }

  /**
   * Recursively collects all folder IDs in the node list.
   */
  static collectAllFolderIds(nodes: CollectionNode[]): string[] {
    const ids: string[] = [];
    for (const node of nodes) {
      if (node.type === 'folder') {
        ids.push(node.id);
        if (Array.isArray(node.children)) {
          ids.push(...this.collectAllFolderIds(node.children));
        }
      }
    }
    return ids;
  }

  /**
   * Recursively filters nodes matching a query string.
   * If a folder matches or contains matching descendants, it is retained.
   */
  static filterTree(
    nodes: CollectionNode[],
    query: string
  ): { filteredNodes: CollectionNode[]; matchedIds: Set<string> } {
    const q = query.trim().toLowerCase();
    const matchedIds = new Set<string>();

    if (!q) {
      return { filteredNodes: [...nodes], matchedIds };
    }

    const filterRecursive = (items: CollectionNode[]): CollectionNode[] => {
      const result: CollectionNode[] = [];

      for (const item of items) {
        if (item.type === 'request') {
          const nameMatches = item.name.toLowerCase().includes(q);
          const urlMatches = item.request.url.toLowerCase().includes(q);
          const methodMatches = item.method.toLowerCase().includes(q);

          if (nameMatches || urlMatches || methodMatches) {
            matchedIds.add(item.id);
            result.push(item);
          }
        } else if (item.type === 'folder') {
          const folderNameMatches = item.name.toLowerCase().includes(q);
          const filteredChildren = filterRecursive(item.children || []);

          if (folderNameMatches) {
            matchedIds.add(item.id);
            // Include folder with all its original children or filtered children
            result.push({
              ...item,
              children: filteredChildren.length > 0 ? filteredChildren : item.children
            });
          } else if (filteredChildren.length > 0) {
            // Folder name doesn't match, but children do
            matchedIds.add(item.id);
            result.push({
              ...item,
              children: filteredChildren
            });
          }
        }
      }

      return result;
    };

    return {
      filteredNodes: filterRecursive(nodes),
      matchedIds
    };
  }
}
