import { Environment, EnvironmentVariable } from '../models/workspace';

export class EnvironmentImporter {
  static parse(jsonStr: string): Environment {
    if (!jsonStr || !jsonStr.trim()) {
      throw new Error('Environment JSON is empty');
    }

    let data: unknown;
    try {
      data = JSON.parse(jsonStr);
    } catch {
      throw new Error('Invalid JSON format for Environment');
    }

    const envId = `env_${Date.now()}`;

    // Case 1: Postman Environment format
    if (data && typeof data === 'object' && 'values' in data && Array.isArray((data as { values: unknown[] }).values)) {
      const postman = data as { name?: string; values: Array<{ key: string; value: string; enabled?: boolean }> };
      const variables: EnvironmentVariable[] = postman.values.map(v => ({
        id: Math.random().toString(),
        key: v.key || '',
        value: v.value || '',
        enabled: v.enabled !== false
      }));

      return {
        id: envId,
        name: postman.name || 'Imported Environment',
        variables,
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
    }

    // Case 2: Plain key-value object
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const obj = data as Record<string, string>;
      const variables: EnvironmentVariable[] = Object.entries(obj).map(([key, value]) => ({
        id: Math.random().toString(),
        key,
        value: String(value),
        enabled: true
      }));

      return {
        id: envId,
        name: 'Imported Environment',
        variables,
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
    }

    throw new Error('Unrecognized environment JSON format');
  }
}
