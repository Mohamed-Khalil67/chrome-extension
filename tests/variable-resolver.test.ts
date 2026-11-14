import test from 'node:test';
import assert from 'node:assert/strict';
import { VariableResolver } from '../src/core/services/variable-resolver';
import { Environment, RequestItem } from '../src/core/models/workspace';

test('VariableResolver.resolveString replaces variables correctly', () => {
  const env: Environment = {
    id: 'env_1',
    name: 'Local',
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    variables: [
      { id: '1', key: 'baseUrl', value: 'http://localhost:3000', enabled: true },
      { id: '2', key: 'userId', value: '42', enabled: true },
      { id: '3', key: 'disabledVar', value: 'secret', enabled: false }
    ]
  };

  const template = '{{baseUrl}}/api/users/{{userId}}?disabled={{disabledVar}}';
  const resolved = VariableResolver.resolveString(template, env);

  assert.equal(resolved, 'http://localhost:3000/api/users/42?disabled={{disabledVar}}');
});

test('VariableResolver.resolveRequest resolves URL, headers, auth, and body', () => {
  const env: Environment = {
    id: 'env_1',
    name: 'Staging',
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    variables: [
      { id: '1', key: 'host', value: 'api.example.com', enabled: true },
      { id: '2', key: 'token', value: 'jwt-xyz-123', enabled: true },
      { id: '3', key: 'clientName', value: 'TestClient', enabled: true }
    ]
  };

  const req: RequestItem = {
    id: 'req_1',
    name: 'Get Item',
    method: 'POST',
    url: 'https://{{host}}/items',
    params: [{ id: 'p1', key: 'client', value: '{{clientName}}', enabled: true }],
    headers: [{ id: 'h1', key: 'X-Custom', value: 'Client: {{clientName}}', enabled: true }],
    auth: {
      type: 'bearer',
      bearerToken: '{{token}}'
    },
    body: {
      type: 'json',
      raw: '{"clientId": "{{clientName}}"}'
    },
    executionMode: 'inspected-page',
    createdAt: 0,
    updatedAt: 0
  };

  const resolved = VariableResolver.resolveRequest(req, env);

  assert.equal(resolved.url, 'https://api.example.com/items?client=TestClient');
  assert.equal(resolved.headers['X-Custom'], 'Client: TestClient');
  assert.equal(resolved.headers['Authorization'], 'Bearer jwt-xyz-123');
  assert.equal(resolved.headers['Content-Type'], 'application/json');
  assert.equal(resolved.body, '{"clientId": "TestClient"}');
});
