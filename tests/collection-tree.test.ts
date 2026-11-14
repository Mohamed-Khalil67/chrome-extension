import test from 'node:test';
import assert from 'node:assert/strict';
import { CollectionFolder, CollectionNode, CollectionRequest } from '../src/core/models/workspace';
import { CollectionTreeService } from '../src/core/services/collection-tree.service';

function createSampleTree(): CollectionNode[] {
  const req1: CollectionRequest = {
    id: 'req_1',
    name: 'Get Products',
    type: 'request',
    method: 'GET',
    request: {
      id: 'req_1',
      name: 'Get Products',
      method: 'GET',
      url: 'https://api.example.com/products',
      headers: [],
      params: [],
      auth: { type: 'none' },
      body: { type: 'none' },
      executionMode: 'inspected-page',
      createdAt: 1000,
      updatedAt: 1000
    }
  };

  const req2: CollectionRequest = {
    id: 'req_2',
    name: 'Create Product',
    type: 'request',
    method: 'POST',
    request: {
      id: 'req_2',
      name: 'Create Product',
      method: 'POST',
      url: 'https://api.example.com/products',
      headers: [],
      params: [],
      auth: { type: 'none' },
      body: { type: 'none' },
      executionMode: 'inspected-page',
      createdAt: 1000,
      updatedAt: 1000
    }
  };

  const subReq: CollectionRequest = {
    id: 'req_3',
    name: 'Get SubCategories',
    type: 'request',
    method: 'GET',
    request: {
      id: 'req_3',
      name: 'Get SubCategories',
      method: 'GET',
      url: 'https://api.example.com/categories/sub',
      headers: [],
      params: [],
      auth: { type: 'none' },
      body: { type: 'none' },
      executionMode: 'inspected-page',
      createdAt: 1000,
      updatedAt: 1000
    }
  };

  const subFolder: CollectionFolder = {
    id: 'fld_sub',
    name: 'SubCategories',
    type: 'folder',
    children: [subReq]
  };

  const parentFolder: CollectionFolder = {
    id: 'fld_cat',
    name: 'Categories',
    type: 'folder',
    children: [subFolder]
  };

  return [req1, req2, parentFolder];
}

test('CollectionTreeService.flattenRequests extracts all nested requests', () => {
  const tree = createSampleTree();
  const requests = CollectionTreeService.flattenRequests(tree);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(r => r.id).sort(), ['req_1', 'req_2', 'req_3'].sort());
});

test('CollectionTreeService.findNode finds root, folder, and deeply nested nodes', () => {
  const tree = createSampleTree();

  const rootReq = CollectionTreeService.findNode(tree, 'req_1');
  assert.ok(rootReq);
  assert.equal(rootReq?.name, 'Get Products');

  const folder = CollectionTreeService.findNode(tree, 'fld_cat');
  assert.ok(folder);
  assert.equal(folder?.type, 'folder');

  const deepNode = CollectionTreeService.findNode(tree, 'req_3');
  assert.ok(deepNode);
  assert.equal(deepNode?.name, 'Get SubCategories');

  const missing = CollectionTreeService.findNode(tree, 'non_existent');
  assert.equal(missing, null);
});

test('CollectionTreeService.insertNode inserts into folder and root', () => {
  const tree = createSampleTree();

  const newReq: CollectionRequest = {
    id: 'req_new',
    name: 'New Node',
    type: 'request',
    method: 'GET',
    request: {
      id: 'req_new',
      name: 'New Node',
      method: 'GET',
      url: 'https://api.example.com/new',
      headers: [],
      params: [],
      auth: { type: 'none' },
      body: { type: 'none' },
      executionMode: 'inspected-page',
      createdAt: 1000,
      updatedAt: 1000
    }
  };

  // Insert into subfolder
  const okSub = CollectionTreeService.insertNode(tree, 'fld_sub', newReq);
  assert.equal(okSub, true);

  const subFolder = CollectionTreeService.findNode(tree, 'fld_sub') as CollectionFolder;
  assert.equal(subFolder.children.length, 2);
  assert.equal(subFolder.children[1]!.id, 'req_new');
});

test('CollectionTreeService.removeNode deletes node anywhere in tree', () => {
  const tree = createSampleTree();

  const removed = CollectionTreeService.removeNode(tree, 'req_3');
  assert.ok(removed);
  assert.equal(removed?.id, 'req_3');

  const check = CollectionTreeService.findNode(tree, 'req_3');
  assert.equal(check, null);
});

test('CollectionTreeService.renameNode renames folders and requests', () => {
  const tree = createSampleTree();

  const ok = CollectionTreeService.renameNode(tree, 'req_1', 'Renamed Products');
  assert.equal(ok, true);

  const node = CollectionTreeService.findNode(tree, 'req_1') as CollectionRequest;
  assert.equal(node.name, 'Renamed Products');
  assert.equal(node.request.name, 'Renamed Products');
});

test('CollectionTreeService.collectAllFolderIds collects all folder IDs', () => {
  const tree = createSampleTree();
  const folderIds = CollectionTreeService.collectAllFolderIds(tree);
  assert.deepEqual(folderIds.sort(), ['fld_cat', 'fld_sub'].sort());
});

test('CollectionTreeService.filterTree filters matching requests and preserves folder ancestors', () => {
  const tree = createSampleTree();

  // Search for "SubCategories"
  const { filteredNodes, matchedIds } = CollectionTreeService.filterTree(tree, 'SubCategories');
  assert.ok(matchedIds.has('req_3') || matchedIds.has('fld_sub'));
  assert.equal(filteredNodes.length, 1);
  assert.equal(filteredNodes[0]!.id, 'fld_cat');
});
