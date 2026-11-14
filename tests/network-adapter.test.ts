import test from 'node:test';
import assert from 'node:assert/strict';
import { DevToolsNetworkAdapter } from '../src/core/adapters/devtools-network.adapter';

test('DevToolsNetworkAdapter.classifyStatus classifies standard HTTP codes including 304 as success', () => {
  assert.equal(DevToolsNetworkAdapter.classifyStatus(200).classification, 'success');
  assert.equal(DevToolsNetworkAdapter.classifyStatus(304).classification, 'success'); // 304 is cache success
  assert.equal(DevToolsNetworkAdapter.classifyStatus(301).classification, 'redirect');
  assert.equal(DevToolsNetworkAdapter.classifyStatus(404).classification, 'client-error');
  assert.equal(DevToolsNetworkAdapter.classifyStatus(500).classification, 'server-error');
  assert.equal(DevToolsNetworkAdapter.classifyStatus(0).classification, 'transport-error');
});

test('DevToolsNetworkAdapter.classifyStatus detects application errors in HTTP 200 responses', () => {
  const json1 = JSON.stringify({ success: false, message: 'Insufficient balance' });
  const res1 = DevToolsNetworkAdapter.classifyStatus(200, json1, 'application/json');
  assert.equal(res1.classification, 'app-failure');
  assert.equal(res1.appErrorMessage, 'Insufficient balance');

  const json2 = JSON.stringify({ error: 'Invalid token' });
  const res2 = DevToolsNetworkAdapter.classifyStatus(200, json2, 'application/json');
  assert.equal(res2.classification, 'app-failure');
  assert.equal(res2.appErrorMessage, 'Invalid token');

  const json3 = JSON.stringify({ data: null, errors: [{ message: 'Field "secret" not found' }] });
  const res3 = DevToolsNetworkAdapter.classifyStatus(200, json3, 'application/json');
  assert.equal(res3.classification, 'app-failure');
  assert.equal(res3.appErrorMessage, 'Field "secret" not found');

  const json4 = JSON.stringify({ id: 1, name: 'Product A', success: true });
  const res4 = DevToolsNetworkAdapter.classifyStatus(200, json4, 'application/json');
  assert.equal(res4.classification, 'success');
});

test('DevToolsNetworkAdapter.categorizeResource correctly maps types', () => {
  assert.equal(DevToolsNetworkAdapter.categorizeResource('xhr', 'application/json', '/api/users'), 'api');
  assert.equal(DevToolsNetworkAdapter.categorizeResource('fetch', '', '/api/data'), 'api');
  assert.equal(DevToolsNetworkAdapter.categorizeResource('document', 'text/html', '/products'), 'document');
  assert.equal(DevToolsNetworkAdapter.categorizeResource('script', 'application/javascript', '/bundle.js'), 'asset');
  assert.equal(DevToolsNetworkAdapter.categorizeResource('stylesheet', 'text/css', '/styles.css'), 'asset');
  assert.equal(DevToolsNetworkAdapter.categorizeResource('font', 'font/woff2', '/font.woff2'), 'asset');
  assert.equal(DevToolsNetworkAdapter.categorizeResource('', '', '/@vite/client'), 'asset');
});
