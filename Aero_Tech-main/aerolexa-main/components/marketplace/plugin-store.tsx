/**
 * Phase 27: Plugin Economy Marketplace
 *
 * A storefront for discovering, reviewing, and installing plugins.
 * Supports creator profiles, revenue sharing, and version management.
 */
import React, { useEffect, useState } from "react";

import { prisma } from "@/lib/db";
import { getInstalledPlugins, executePlugin as executePluginSdk } from "@/lib/extensions/plugin-sdk";

export interface PluginCard {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  type: "chart" | "analysis" | "export" | "integration" | "widget";
  price: "free" | "paid";
  rating: number;
  reviews: number;
  installs: number;
  isInstalled: boolean;
  previewImage?: string;
  // For paid plugins
  priceAmount?: number;
}

export const PluginStore: React.FC = () => {
  const [plugins, setPlugins] = useState<PluginCard[]>([]);
  const [installed, setInstalled] = useState<PluginCard[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchPlugins();
  }, []);

  const fetchPlugins = async () => {
    setLoading(true);

    try {
      // Get installed plugins from SDK
      const allPlugins = getInstalledPlugins();

      // Fetch from database for marketplace listing
      const dbPlugins = await prisma.plugin.findMany({
        orderBy: { rating: "desc" },
      });

      setPlugins(
        dbPlugins.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          version: p.version,
          author: p.author,
          type: p.type as PluginCard["type"],
          price: p.price as PluginCard["price"],
          rating: p.rating,
          reviews: p.reviews,
          installs: p.installCount,
          isInstalled: false,
          previewImage: p.previewImage ?? undefined,
          priceAmount: p.priceAmount ?? undefined,
        }))
      );

      // Get installed ones
      setInstalled(
        allPlugins.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          version: p.version,
          author: p.author,
          type: p.type as PluginCard["type"],
          price: "free", // SDK plugins are free
          rating: 5,
          reviews: 0,
          installs: p.installCount,
          isInstalled: true,
        }))
      );
    } catch (error) {
      console.error("Failed to fetch plugins:", error);
      setPlugins([]);
      setInstalled([]);
    } finally {
      setLoading(false);
    }
  };

  const installPlugin = async (pluginId: string) => {
    try {
      // Try to install via SDK
      installPlugin(pluginId);
      setPlugins(
        plugins.map((p) =>
          p.id === pluginId ? { ...p, isInstalled: true } : p
        )
      );
      setInstalled(
        installed.map((p) =>
          p.id === pluginId ? { ...p, isInstalled: true } : p
        )
      );
      // TODO: Show success notification
    } catch (error) {
      console.error("Failed to install plugin:", error);
      // TODO: Show error notification
    }
  };

  const executePlugin = (pluginId: string, args: any) => {
    return executePluginSdk(pluginId, args);
  };

  if (loading) {
    return <div className="marketplace-loading">Loading marketplace...</div>;
  }

  return (
    <div className="plugin-store">
      <div className="store-header">
        <h2>Plugin Marketplace</h2>
        <p>Extend your analytics capabilities</p>
      </div>

      <div className="store-tabs">
        <button className="tab active">Marketplace</button>
        <button className="tab">My Plugins</button>
      </div>

      <div className="store-content">
        {/* Marketplace tabs would go here */}

        <div className="plugins-grid">
          {loading ? (
            <div>Loading plugins...</div>
          ) : plugins.length === 0 ? (
            <div className="empty-state">
              No plugins available yet.
            </div>
          ) : plugins.map((plugin) => (
            <div
              key={plugin.id}
              className={`plugin-card ${plugin.isInstalled ? "installed" : ""}`}
            >
              {plugin.previewImage ? (
                <img
                  src={plugin.previewImage}
                  alt={plugin.name}
                  className="plugin-preview"
                />
              ) : (
                <div
                  className="plugin-preview"
                  style={{ background: "#f0f2f5", height: "150px", display: "flex", alignItems: "center", justifyContent: "center" }}
                >
                  {plugin.name.substring(0, 2)}
                </div>
              )}

              <div className="plugin-info">
                <h3 className="plugin-name">{plugin.name}</h3>
                <p className="plugin-description">{plugin.description}</p>
                <div className="plugin-rating">
                  {Array(5)
                    .fill(0)
                    .map((_, i) => (
                      <span
                        key={i}
                        className={i < plugin.rating ? "star filled" : "star empty"}
                      />
                    ))}
                  <span className="rating-count">({plugin.reviews})</span>
                </div>
                <div className="plugin-type">{plugin.type}</div>
                {plugin.price === "paid" && plugin.priceAmount
                  ? (
                      <span className="plugin-price">
                        ${plugin.priceAmount}
                      </span>
                    )
                  : (
                      <span className="plugin-free">Free</span>
                    )}
              </div>

              {plugin.isInstalled ? (
                <span className="installed-badge">Installed</span>
              ) : (
                <button
                  className="install-btn"
                  onClick={() => installPlugin(plugin.id)}
                >
                  Install
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};