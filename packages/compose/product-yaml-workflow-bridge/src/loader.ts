import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { type ProductYamlBridgeInput, ProductYamlWorkflowBridgeError } from './types.js';

export function parseProductYaml(source: string): ProductYamlBridgeInput {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'invalid_yaml_structure',
      path: '$',
      message: `Product YAML could not be parsed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProductYamlWorkflowBridgeError({
      code: 'invalid_yaml_structure',
      path: '$',
      message: 'Product YAML must parse to an object.',
    });
  }

  return parsed as ProductYamlBridgeInput;
}

export async function loadProductYamlFile(path: string): Promise<ProductYamlBridgeInput> {
  return parseProductYaml(await readFile(path, 'utf8'));
}
