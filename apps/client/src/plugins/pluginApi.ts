export const PLUGIN_API_VERSION = 1;
export const MAX_PLUGIN_BYTES = 128 * 1024;
export const MAX_PLUGINS = 12;

const permissions = ['brush', 'layers', 'artwork'] as const;
export type PluginPermission = (typeof permissions)[number];

export interface PluginManifest {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  permissions: PluginPermission[];
  commands: { id: string; label: string }[];
  script: string;
}

export interface PluginContext {
  width: number;
  height: number;
  dpi: number;
}

type Shape = { kind: 'rect' | 'ellipse'; x: number; y: number; width: number; height: number; color: string };
export type PluginAction =
  | { kind: 'message'; text: string }
  | { kind: 'brush'; color?: string; size?: number }
  | { kind: 'layer'; name: string }
  | { kind: 'artwork'; name: string; width: number; height: number; shapes: Shape[] };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}

function label(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid text field.');
  }
  return value.trim();
}

function identifier(value: unknown): string {
  const id = label(value, 80);
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id)) throw new Error('Invalid identifier.');
  return id;
}

export function parsePlugin(value: unknown): PluginManifest {
  const item = record(value);
  if (item.apiVersion !== PLUGIN_API_VERSION) throw new Error('Plugin API version 1 is required.');
  if (!Array.isArray(item.permissions) || item.permissions.length > permissions.length ||
    !item.permissions.every((permission) => permissions.includes(permission)) ||
    new Set(item.permissions).size !== item.permissions.length) throw new Error('Invalid permissions.');
  if (!Array.isArray(item.commands) || item.commands.length < 1 || item.commands.length > 12) {
    throw new Error('Declare between 1 and 12 commands.');
  }
  const commands = item.commands.map((entry) => {
    const command = record(entry);
    return { id: identifier(command.id), label: label(command.label, 60) };
  });
  if (new Set(commands.map(command => command.id)).size !== commands.length) throw new Error('Duplicate command ID.');
  if (typeof item.script !== 'string' || !item.script.trim() || new TextEncoder().encode(item.script).length > MAX_PLUGIN_BYTES) {
    throw new Error('Invalid or oversized script.');
  }
  return {
    apiVersion: PLUGIN_API_VERSION,
    id: identifier(item.id),
    name: label(item.name, 60),
    version: label(item.version, 30),
    author: label(item.author, 60),
    description: item.description === '' || item.description === undefined ? '' : label(item.description, 240),
    permissions: [...item.permissions],
    commands,
    script: item.script,
  };
}

function number(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('Number outside allowed range.');
  return value;
}

function hex(value: unknown) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('Expected a #RRGGBB color.');
  return value;
}

export function parsePluginAction(value: unknown, plugin: PluginManifest): PluginAction {
  const action = record(value);
  const allowed = (permission: PluginPermission) => {
    if (!plugin.permissions.includes(permission)) throw new Error(`Missing permission: ${permission}`);
  };
  switch (action.kind) {
    case 'message':
      return { kind: 'message', text: label(action.text, 240) };
    case 'brush': {
      allowed('brush');
      const color = action.color === undefined ? undefined : hex(action.color);
      const size = action.size === undefined ? undefined : number(action.size, 1, 1000);
      if (color === undefined && size === undefined) throw new Error('No brush setting was provided.');
      return { kind: 'brush', color, size };
    }
    case 'layer':
      allowed('layers');
      return { kind: 'layer', name: label(action.name, 80) };
    case 'artwork': {
      allowed('artwork');
      const width = number(action.width, 1, 4096), height = number(action.height, 1, 4096);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width * height > 4_194_304) {
        throw new Error('Artwork must fit within 4,194,304 pixels.');
      }
      if (!Array.isArray(action.shapes) || !action.shapes.length || action.shapes.length > 1000) {
        throw new Error('Provide between 1 and 1,000 shapes.');
      }
      const shapes = action.shapes.map((entry): Shape => {
        const shape = record(entry);
        if (shape.kind !== 'rect' && shape.kind !== 'ellipse') throw new Error('Unknown shape.');
        return {
          kind: shape.kind, x: number(shape.x, -4096, 4096), y: number(shape.y, -4096, 4096),
          width: number(shape.width, 0.01, 4096), height: number(shape.height, 0.01, 4096), color: hex(shape.color),
        };
      });
      return { kind: 'artwork', name: label(action.name, 80), width, height, shapes };
    }
    default:
      throw new Error('Unknown plugin action.');
  }
}
