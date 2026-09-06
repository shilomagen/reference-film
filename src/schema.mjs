import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SCHEMA_PATHS = Object.freeze({
  config: path.join(ROOT, "schemas", "project-config.schema.json"),
  brief: path.join(ROOT, "schemas", "creator-brief.schema.json"),
  lyrics: path.join(ROOT, "schemas", "lyrics.schema.json"),
  plan: path.join(ROOT, "schemas", "scene-plan.schema.json"),
  timings: path.join(ROOT, "schemas", "timings.schema.json"),
});

export function readJson(filePath, label = "JSON") {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`${label} could not be read at ${filePath}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is malformed JSON at ${filePath}: ${error.message}`);
  }
}

export function loadCanonicalSchema(name) {
  const schemaPath = SCHEMA_PATHS[name];
  if (!schemaPath) throw new Error(`Unknown canonical schema '${name}'`);
  return readJson(schemaPath, `${name} schema`);
}

function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value, type) {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return false;
}

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function visit(schema, value, pointer, errors) {
  if (schema.anyOf) {
    const branchErrors = schema.anyOf.map((branch) => {
      const candidate = [];
      visit(branch, value, pointer, candidate);
      return candidate;
    });
    if (!branchErrors.some((candidate) => candidate.length === 0)) {
      errors.push(`${pointer} must match one of the supported alternatives`);
    }
    return;
  }
  if (schema.const !== undefined && !equal(value, schema.const)) {
    errors.push(`${pointer} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((item) => equal(value, item))) {
    errors.push(`${pointer} must be one of ${schema.enum.map(JSON.stringify).join(", ")}`);
  }
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${pointer} must be ${schema.type}, received ${describe(value)}`);
    return;
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${pointer} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${pointer} is too long`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${pointer} does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${pointer} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${pointer} must be <= ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${pointer} must be > ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(`${pointer} must be < ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${pointer} must contain at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${pointer} must contain at most ${schema.maxItems} item(s)`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${pointer} must contain unique items`);
    if (schema.items) value.forEach((item, index) => visit(schema.items, item, `${pointer}/${index}`, errors));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(`${pointer} must contain at least ${schema.minProperties} properties`);
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) errors.push(`${pointer}/${required} is required`);
    }
    for (const key of keys) {
      if (schema.properties?.[key]) visit(schema.properties[key], value[key], `${pointer}/${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${pointer}/${key} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        visit(schema.additionalProperties, value[key], `${pointer}/${key}`, errors);
      }
    }
  }
}

/**
 * Validate the bounded JSON Schema vocabulary used by this repository's
 * canonical schemas. Supported assertions: type, required, properties,
 * additionalProperties, items, anyOf, enum, const, pattern, string/array/
 * object sizes, uniqueItems, and numeric bounds. This is deliberately not a
 * general-purpose JSON Schema implementation.
 */
export function validateSchema(schema, value, label = "document") {
  const errors = [];
  visit(schema, value, "$", errors);
  if (errors.length) throw new Error(`${label} failed schema validation:\n- ${errors.join("\n- ")}`);
  return value;
}

export function validateCanonical(name, value, label = name) {
  return validateSchema(loadCanonicalSchema(name), value, label);
}
