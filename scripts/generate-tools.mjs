import fs from "node:fs/promises";
import { parse as parseYaml } from "yaml";

const DEFAULT_SPEC_PATH = "outline-openapi.yml";
const OUTPUT_PATH = "src/generated/outlineTools.ts";
const MAX_SCHEMA_DEPTH = 8;

const READ_ONLY_PATTERN =
  /list|info|search|config|redirect|export|history|diff|view|views|count|counts|stats|ping|check/i;
const DESTRUCTIVE_PATTERN = /delete|remove|destroy/i;

const toSnakeCase = (value) =>
  value
    .replace(/^\//, "")
    .replace(/\./g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/__+/g, "_")
    .toLowerCase();

const resolveRef = (spec, ref) => {
  if (!ref.startsWith("#/")) {
    throw new Error(`Unsupported $ref: ${ref}`);
  }
  const parts = ref.slice(2).split("/");
  let current = spec;
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = current[part];
    } else {
      throw new Error(`Unresolvable $ref: ${ref}`);
    }
  }
  return current;
};

const mergeAllOfSchemas = (spec, schemas, seenRefs, depth) => {
  const mergedProperties = {};
  const mergedRequired = [];

  for (const schema of schemas) {
    const resolved = derefSchema(spec, schema, seenRefs, depth + 1);
    if (resolved?.properties) {
      Object.assign(mergedProperties, resolved.properties);
    }
    if (Array.isArray(resolved?.required)) {
      mergedRequired.push(...resolved.required);
    }
  }

  return {
    type: "object",
    properties: mergedProperties,
    required: mergedRequired.length > 0 ? mergedRequired : undefined
  };
};

const derefSchema = (spec, schema, seenRefs, depth) => {
  if (!schema) {
    return {};
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    return {};
  }
  if (schema.$ref) {
    if (seenRefs.has(schema.$ref)) {
      return {};
    }
    seenRefs.add(schema.$ref);
    return derefSchema(spec, resolveRef(spec, schema.$ref), seenRefs, depth + 1);
  }
  if (schema.allOf) {
    return mergeAllOfSchemas(spec, schema.allOf, seenRefs, depth);
  }
  return schema;
};

const literalExpression = (value) => `z.literal(${JSON.stringify(value)})`;

const schemaToZodExpression = (
  spec,
  schema,
  options,
  depth = 0,
  seenRefs = new Set()
) => {
  const resolved = derefSchema(spec, schema, seenRefs, depth);
  if (!resolved || depth > MAX_SCHEMA_DEPTH) {
    return "z.any()";
  }

  if (resolved.oneOf || resolved.anyOf) {
    return "z.any()";
  }

  const isOutput = options?.mode === "output";
  let expression = "z.any()";
  const schemaType = resolved.type;
  const hasProperties = resolved.properties && typeof resolved.properties === "object";

  if (schemaType === "object" || hasProperties) {
    const properties = resolved.properties ?? {};
    const required = new Set(resolved.required ?? []);
    const entries = Object.entries(properties).map(([key, propertySchema]) => {
      let propertyExpression = schemaToZodExpression(
        spec,
        propertySchema,
        options,
        depth + 1,
        new Set(seenRefs)
      );
      if (!required.has(key)) {
        propertyExpression = `${propertyExpression}.optional()`;
        if (isOutput) {
          propertyExpression = `${propertyExpression}.nullable()`;
        }
      }
      return `${JSON.stringify(key)}: ${propertyExpression}`;
    });

    expression = `z.object({ ${entries.join(", ")} })`;

    if (isOutput) {
      expression = `${expression}.passthrough()`;
    } else if (resolved.additionalProperties) {
      if (resolved.additionalProperties === true) {
        expression = `${expression}.passthrough()`;
      } else {
        const catchallExpression = schemaToZodExpression(
          spec,
          resolved.additionalProperties,
          options,
          depth + 1,
          new Set(seenRefs)
        );
        expression = `${expression}.catchall(${catchallExpression})`;
      }
    } else {
      expression = `${expression}.strict()`;
    }
  } else if (schemaType === "array") {
    const itemExpression = resolved.items
      ? schemaToZodExpression(
          spec,
          resolved.items,
          options,
          depth + 1,
          new Set(seenRefs)
        )
      : "z.any()";
    expression = `z.array(${itemExpression})`;
  } else if (schemaType === "string") {
    if (Array.isArray(resolved.enum) && resolved.enum.length > 0) {
      const stringValues = resolved.enum.filter((value) => typeof value === "string");
      if (isOutput) {
        expression = "z.string()";
      } else if (stringValues.length === resolved.enum.length) {
        expression = `z.enum(${JSON.stringify(stringValues)})`;
      } else {
        const literals = resolved.enum.map((value) => literalExpression(value));
        expression = literals.length === 1 ? literals[0] : `z.union([${literals.join(", ")}])`;
      }
    } else {
      expression = "z.string()";
    }
  } else if (schemaType === "integer" || schemaType === "number") {
    expression = "z.number()";
  } else if (schemaType === "boolean") {
    expression = "z.boolean()";
  } else if (Array.isArray(resolved.enum) && resolved.enum.length > 0) {
    expression = isOutput ? "z.any()" : `z.union([${resolved.enum.map(literalExpression).join(", ")}])`;
  }

  if (resolved.nullable) {
    expression = `${expression}.nullable()`;
  }

  const descriptionParts = [];
  if (resolved.description) {
    descriptionParts.push(resolved.description);
  }
  if (resolved.example !== undefined) {
    descriptionParts.push(`Example: ${JSON.stringify(resolved.example)}`);
  }
  if (descriptionParts.length > 0) {
    expression = `${expression}.describe(${JSON.stringify(descriptionParts.join(" "))})`;
  }

  return expression;
};

const buildInputSchemaExpression = (spec, operation) => {
  const requestSchema =
    operation?.requestBody?.content?.["application/json"]?.schema;

  if (!requestSchema) {
    return "z.object({}).strict()";
  }

  const resolved = derefSchema(spec, requestSchema, new Set(), 0);
  const schemaType = resolved?.type;
  const hasProperties = resolved?.properties && typeof resolved.properties === "object";

  if (schemaType === "object" || hasProperties) {
    return schemaToZodExpression(spec, resolved, { mode: "input" }, 0, new Set());
  }

  const payloadExpression = schemaToZodExpression(
    spec,
    resolved,
    { mode: "input" },
    0,
    new Set()
  );
  return `z.object({ payload: ${payloadExpression} }).strict()`;
};

const buildOutputSchemaExpression = (spec, operation) => {
  const responses = operation?.responses ?? {};
  const responseSchema =
    responses?.["200"]?.content?.["application/json"]?.schema ||
    responses?.["201"]?.content?.["application/json"]?.schema;

  if (!responseSchema) {
    return null;
  }

  const resolved = derefSchema(spec, responseSchema, new Set(), 0);
  const isObjectSchema =
    resolved?.type === "object" ||
    (resolved?.properties && typeof resolved.properties === "object");

  if (!isObjectSchema) {
    return null;
  }

  return schemaToZodExpression(spec, responseSchema, { mode: "output" }, 0, new Set());
};

const hasPagination = (spec, operation) => {
  const requestSchema =
    operation?.requestBody?.content?.["application/json"]?.schema;
  if (!requestSchema) {
    return false;
  }

  const resolved = derefSchema(spec, requestSchema, new Set(), 0);
  const properties = resolved?.properties ?? {};
  return "limit" in properties || "offset" in properties;
};

const loadSpec = async (specPath) => {
  const specContent = await fs.readFile(specPath, "utf8");
  return parseYaml(specContent);
};

const generateTools = (spec) => {
  const paths = spec.paths ?? {};
  const tools = [];

  for (const [pathKey, pathItem] of Object.entries(paths)) {
    const methods = ["post", "get", "put", "patch", "delete"];
    for (const method of methods) {
      const operation = pathItem?.[method];
      if (!operation) {
        continue;
      }

      const methodName = pathKey.replace(/^\//, "");
      const operationId = operation.operationId ?? methodName;
      const toolName = `outline_${toSnakeCase(operationId)}`;
      const title = operation.summary ?? toolName;
      let description = operation.description ?? operation.summary ?? "";
      const inputSchema = buildInputSchemaExpression(spec, operation);
      const outputSchema = buildOutputSchemaExpression(spec, operation);
      const readOnlyHint = READ_ONLY_PATTERN.test(operationId);
      const destructiveHint = DESTRUCTIVE_PATTERN.test(operationId);

      if (hasPagination(spec, operation)) {
        description = description
          ? `${description}\n\nPagination: use limit and offset to page results.`
          : "Pagination: use limit and offset to page results.";
      }

      tools.push({
        name: toolName,
        title,
        description,
        methodName,
        inputSchema,
        outputSchema,
        annotations: {
          readOnlyHint,
          destructiveHint,
          idempotentHint: readOnlyHint,
          openWorldHint: true
        }
      });
    }
  }

  return tools;
};

const writeOutput = async (tools) => {
  const lines = [];
  lines.push("import { z } from \"zod\";");
  lines.push("");
  lines.push("export type OutlineToolDefinition = {");
  lines.push("  name: string;");
  lines.push("  title: string;");
  lines.push("  description: string;");
  lines.push("  methodName: string;");
  lines.push("  inputSchema: z.ZodTypeAny;");
  lines.push("  outputSchema?: z.ZodTypeAny;");
  lines.push("  annotations: {");
  lines.push("    readOnlyHint: boolean;");
  lines.push("    destructiveHint: boolean;");
  lines.push("    idempotentHint: boolean;");
  lines.push("    openWorldHint: boolean;");
  lines.push("  };");
  lines.push("};");
  lines.push("");
  lines.push("export const outlineTools: OutlineToolDefinition[] = [");

  for (const tool of tools) {
    lines.push("  {");
    lines.push(`    name: ${JSON.stringify(tool.name)},`);
    lines.push(`    title: ${JSON.stringify(tool.title)},`);
    lines.push(`    description: ${JSON.stringify(tool.description)},`);
    lines.push(`    methodName: ${JSON.stringify(tool.methodName)},`);
    lines.push(`    inputSchema: ${tool.inputSchema},`);
    lines.push(
      `    outputSchema: ${tool.outputSchema ?? "undefined"},`
    );
    lines.push("    annotations: {");
    lines.push(`      readOnlyHint: ${tool.annotations.readOnlyHint},`);
    lines.push(`      destructiveHint: ${tool.annotations.destructiveHint},`);
    lines.push(`      idempotentHint: ${tool.annotations.idempotentHint},`);
    lines.push(`      openWorldHint: ${tool.annotations.openWorldHint}`);
    lines.push("    }");
    lines.push("  },");
  }

  lines.push("];");

  await fs.writeFile(OUTPUT_PATH, `${lines.join("\n")}\n`, "utf8");
};

const main = async () => {
  const specPath = process.argv[2] ?? DEFAULT_SPEC_PATH;
  const spec = await loadSpec(specPath);
  const tools = generateTools(spec);
  await writeOutput(tools);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
