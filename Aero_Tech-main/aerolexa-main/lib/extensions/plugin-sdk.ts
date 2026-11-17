/**
 * Phase 23: Plugin Economy SDK
 *
 * Provides a plugin system for extending application functionality.
 * Plugins can add chart types, analysis tools, integrations, and UI components.
 *
 * Usage:
 *   import { registerPlugin, getPlugins, executePlugin } from "@/lib/extensions/plugin-sdk";
 *
 *   // Register a new plugin
 *   registerPlugin({
 *     id: "my-custom-chart",
 *     name: "Custom Chart",
 *     version: "1.0.0",
 *     type: "chart",
 *     // ... plugin definition
 *   });
 *
 *   // Execute a plugin
 *   const result = await executePlugin("my-custom-chart", { data, options });
 */
import { prisma } from "@/lib/db";

export type PluginType = "chart" | "analysis" | "export" | "integration" | "widget" | "component";

export interface PluginMetadata {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  type: PluginType;
  // Compatibility
  minAppVersion: string;
  maxAppVersion: string;
  // Resources
  iconUrl?: string;
  documentationUrl?: string;
  // Status
  isInstalled: boolean;
  isEnabled: boolean;
  installCount: number;
  // Configuration
  schema?: Record<string, unknown>;
}

export interface PluginDefinition {
  // Core plugin functionality
  execute: (
    args: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  // Optional: configure UI
  configSchema?: Record<string, unknown>;
  // Optional: on install
  onInstall?: () => Promise<void>;
  // Optional: on uninstall
  onUninstall?: () => Promise<void>;
}

/** Plugin registry state. */
const pluginRegistry: Map<string, PluginMetadata & PluginDefinition> = new Map();

/** Register a new plugin. */
export function registerPlugin(
  metadata: PluginMetadata,
  definition: PluginDefinition
): void {
  const combined = { ...metadata, ...definition, isInstalled: false, isEnabled: false, installCount: 0 };
  pluginRegistry.set(metadata.id, combined);
  console.log(`Plugin registered: ${metadata.name} (${metadata.id})`);
}

/** Get all registered plugins. */
export function getPlugins(): (PluginMetadata & PluginDefinition)[] {
  return Array.from(pluginRegistry.values());
}

/** Get a specific plugin by ID. */
export function getPlugin(id: string): (PluginMetadata & PluginDefinition) | undefined {
  return pluginRegistry.get(id);
}

/** Enable a plugin. */
export function enablePlugin(id: string): boolean {
  const plugin = pluginRegistry.get(id);
  if (!plugin) return false;
  plugin.isEnabled = true;
  return true;
}

/** Disable a plugin. */
export function disablePlugin(id: string): boolean {
  const plugin = pluginRegistry.get(id);
  if (!plugin) return false;
  plugin.isEnabled = false;
  return true;
}

/** Execute a plugin with arguments. */
export async function executePlugin(
  id: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const plugin = pluginRegistry.get(id);
  if (!plugin) {
    throw new Error(`Plugin ${id} not found`);
  }
  if (!plugin.isEnabled) {
    throw new Error(`Plugin ${id} is disabled`);
  }
  try {
    const result = await plugin.execute!(args);
    plugin.installCount++;
    return result;
  } catch (error) {
    console.error(`Plugin ${id} execution error:`, error);
    throw error;
  }
}

/** Install a plugin (mark as installed). */
export function installPlugin(id: string): boolean {
  const plugin = pluginRegistry.get(id);
  if (!plugin) return false;
  plugin.isInstalled = true;
  plugin.installCount++;
  return true;
}

/** Uninstall a plugin (mark as uninstalled). */
export function uninstallPlugin(id: string): boolean {
  const plugin = pluginRegistry.get(id);
  if (!plugin) return false;
  plugin.isInstalled = false;
  return true;
}

/** Get installed plugins. */
export function getInstalledPlugins(): (PluginMetadata & PluginDefinition)[] {
  return getPlugins().filter((p) => p.isInstalled);
}

/** Get enabled plugins. */
export function getEnabledPlugins(): (PluginMetadata & PluginDefinition)[] {
  return getPlugins().filter((p) => p.isEnabled);
}