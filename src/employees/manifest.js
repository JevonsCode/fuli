import { z } from 'zod';
import { ApplicationError } from '../app/application-error.js';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const toolIdentifier = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const relativeFile = z.string().min(1).max(160).refine(
  (value) => !value.startsWith('/') && !value.includes('\\') &&
    !value.split('/').some((part) => !part || part === '.' || part === '..') &&
    !value.includes(':'),
  'Employee package paths must stay inside the package'
);

export const employeeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: identifier,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string().trim().min(1).max(100),
  role: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1000),
  occupationEmoji: z.string().min(1).max(32),
  capabilities: z.array(z.string().min(1).max(180)).max(24),
  workKinds: z.array(z.string().min(1).max(180)).max(24),
  initialPreferences: z.array(z.string().min(1).max(512)).max(24),
  permissions: z.array(z.string().regex(/^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+$/)).max(24),
  defaultProjectScope: z.enum(['selected', 'all']).optional(),
  taskEntry: z.object({
    boardTool: toolIdentifier,
    titleTool: toolIdentifier.optional(),
  }).strict().optional(),
  runtime: z.object({
    apiVersion: z.literal(1),
    entry: relativeFile,
    webRoot: relativeFile
  }).strict().nullable()
}).strict();

export function parseEmployeeManifest(value) {
  const parsed = employeeManifestSchema.safeParse(value);
  if (!parsed.success) throw new TypeError('Invalid employee package manifest');
  return parsed.data;
}

export const employeeAgentId = (id) => `employee.${identifier.parse(id)}`;
export const employeeCapability = (id) => `fuli.employee:${identifier.parse(id)}`;

export class EmployeeError extends ApplicationError {
  constructor(message, status = 400, code = 'employee_error') {
    super(code, message);
    this.name = 'EmployeeError';
    this.status = status;
    this.code = code;
  }
}
