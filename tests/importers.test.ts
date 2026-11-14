import test from 'node:test';
import assert from 'node:assert/strict';
import { CurlImporter } from '../src/core/importers/curl.importer';
import { EnvironmentImporter } from '../src/core/importers/environment.importer';
import { OpenApiImporter } from '../src/core/importers/openapi.importer';
import { PostmanImporter } from '../src/core/importers/postman.importer';

test('CurlImporter parses methods, headers, and payload', () => {
  const curl = `curl -X POST 'https://api.example.com/v1/users' \\
    -H 'Authorization: Bearer my-token' \\
    -H 'Content-Type: application/json' \\
    -d '{"name": "Alice", "role": "admin"}'`;

  const req = CurlImporter.parse(curl);
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://api.example.com/v1/users');
  assert.equal(req.body?.type, 'json');
  assert.equal(req.body?.raw, '{"name": "Alice", "role": "admin"}');
  assert.ok(req.headers?.some(h => h.key === 'Authorization' && h.value === 'Bearer my-token'));
});

test('PostmanImporter parses collections, folders, and request properties', () => {
  const postmanJson = JSON.stringify({
    info: {
      name: 'Test Postman Collection',
      description: 'API test collection'
    },
    item: [
      {
        name: 'Auth Folder',
        item: [
          {
            name: 'Login User',
            request: {
              method: 'POST',
              url: { raw: 'https://api.example.com/login' },
              header: [{ key: 'Accept', value: 'application/json' }],
              body: { mode: 'raw', raw: '{"email":"test@example.com"}' }
            }
          }
        ]
      },
      {
        name: 'Get Products',
        request: {
          method: 'GET',
          url: 'https://api.example.com/products'
        }
      }
    ]
  });

  const { collection, requests } = PostmanImporter.parse(postmanJson);
  assert.equal(collection.name, 'Test Postman Collection');
  assert.equal(requests.length, 2);
  assert.ok(collection.children);
  assert.equal(collection.children.length, 2);
  assert.equal(collection.children[0]!.type, 'folder');
  assert.equal(collection.children[0]!.name, 'Auth Folder');
  assert.equal(collection.children[1]!.type, 'request');
  assert.equal(collection.children[1]!.name, 'Get Products');

  const loginReq = requests.find(r => r.name.includes('Login User'))!;
  assert.equal(loginReq.method, 'POST');
  assert.equal(loginReq.url, 'https://api.example.com/login');
  assert.equal(loginReq.body.type, 'json');

  const productsReq = requests.find(r => r.name === 'Get Products')!;
  assert.equal(productsReq.method, 'GET');
  assert.equal(productsReq.url, 'https://api.example.com/products');
});

test('OpenApiImporter parses OpenAPI JSON specification', () => {
  const openApiJson = JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Petstore API', version: '1.0.0' },
    servers: [{ url: 'https://petstore.example.com/api' }],
    paths: {
      '/pets': {
        get: {
          summary: 'List all pets',
          parameters: [{ name: 'limit', in: 'query', schema: { default: 20 } }]
        },
        post: {
          summary: 'Create a pet',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { name: { type: 'string', example: 'Fido' } }
                }
              }
            }
          }
        }
      }
    }
  });

  const { collection, requests } = OpenApiImporter.parse(openApiJson);
  assert.equal(collection.name, 'Petstore API');
  assert.equal(requests.length, 2);
  assert.ok(collection.children);
  assert.equal(collection.children[0]!.type, 'folder');
  assert.equal(collection.children[0]!.name, 'Pets');

  const getReq = requests.find(r => r.method === 'GET')!;
  assert.equal(getReq.url, 'https://petstore.example.com/api/pets');
  assert.ok(getReq.params.some(p => p.key === 'limit' && p.value === '20'));

  const postReq = requests.find(r => r.method === 'POST')!;
  assert.equal(postReq.body.type, 'json');
  assert.match(postReq.body.raw || '', /Fido/);
});

test('OpenApiImporter parses OpenAPI YAML specification', () => {
  const openApiYaml = `
openapi: 3.1.0
info:
  title: Users Service
  version: 2.0.0
servers:
  - url: https://users.example.com/v2
paths:
  /users:
    get:
      summary: Retrieve all users
`;

  const { collection, requests } = OpenApiImporter.parse(openApiYaml);
  assert.equal(collection.name, 'Users Service');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, 'https://users.example.com/v2/users');
});

test('EnvironmentImporter parses Postman and simple environment JSON', () => {
  const postmanEnv = JSON.stringify({
    name: 'Development Env',
    values: [
      { key: 'baseUrl', value: 'http://localhost:3000', enabled: true },
      { key: 'secretKey', value: '12345', enabled: false }
    ]
  });

  const env1 = EnvironmentImporter.parse(postmanEnv);
  assert.equal(env1.name, 'Development Env');
  assert.equal(env1.variables.length, 2);
  assert.equal(env1.variables[0]!.key, 'baseUrl');

  const simpleEnv = JSON.stringify({
    baseUrl: 'https://api.myapp.com',
    authToken: 'token-abc'
  });

  const env2 = EnvironmentImporter.parse(simpleEnv);
  assert.equal(env2.variables.length, 2);
});

test('PostmanImporter parses complex auth objects, variables, and reconstructs URLs', () => {
  const complexPostman = JSON.stringify({
    info: {
      name: 'Complex E-commerce App',
      description: 'Test complex collection'
    },
    variable: [
      { key: 'baseUrl', value: 'https://ecommerce.example.com' },
      { key: 'token', value: 'secret-token-123' }
    ],
    item: [
      {
        name: 'Cart (v2)',
        item: [
          {
            name: 'Add Product To Cart (v2)',
            request: {
              method: 'POST',
              auth: {
                type: 'bearer',
                bearer: {
                  basicConfig: [{ key: 'token', value: '<token>' }]
                }
              },
              url: {
                protocol: 'https',
                host: ['ecommerce', 'example', 'com'],
                path: ['api', 'v2', 'cart']
              }
            }
          }
        ]
      }
    ]
  });

  const { collection, requests, environment } = PostmanImporter.parse(complexPostman);
  assert.equal(collection.name, 'Complex E-commerce App');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, 'https://ecommerce.example.com/api/v2/cart');
  assert.equal(requests[0]!.auth.type, 'bearer');
  assert.equal(requests[0]!.auth.bearerToken, '<token>');
  assert.ok(environment);
  assert.equal(environment.name, 'Complex E-commerce App Env');
  assert.equal(environment.variables.length, 2);
  assert.equal(environment.variables[0]!.key, 'baseUrl');
  assert.equal(environment.variables[0]!.value, 'https://ecommerce.example.com');
});
