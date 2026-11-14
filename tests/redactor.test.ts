import test from 'node:test';
import assert from 'node:assert/strict';
import { Redactor } from '../src/core/security/redactor';

test('Redactor.redactHeaderValue redacts authorization and cookies', () => {
  const authHeader = Redactor.redactHeaderValue('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9');
  assert.equal(authHeader, 'Bear...[REDACTED]');

  const cookieHeader = Redactor.redactHeaderValue('Cookie', 'sessionId=abcdefgh123456');
  assert.equal(cookieHeader, 'sess...[REDACTED]');

  const safeHeader = Redactor.redactHeaderValue('Content-Type', 'application/json');
  assert.equal(safeHeader, 'application/json');
});

test('Redactor.redactUrl strips sensitive query params', () => {
  const url = 'https://api.example.com/v1/auth?token=supersecret123&user=john&apiKey=key999';
  const redacted = Redactor.redactUrl(url);

  assert.match(redacted, /token=%5BREDACTED%5D/);
  assert.match(redacted, /apiKey=%5BREDACTED%5D/);
  assert.match(redacted, /user=john/);
});
