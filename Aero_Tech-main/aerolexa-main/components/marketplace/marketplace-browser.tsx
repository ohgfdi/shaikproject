/**
 * Phase 14: Marketplace Browser
 *
 * A component for discovering and installing plugins, themes, and integrations.
 * Shows available extensions with ratings, reviews, and installation status.
 */
import Image from "next/image";
import React, { useCallback, useState, useEffect } from "react";

import { prisma } from "@/lib/db";

export interface MarketplacePlugin {
  id: string;
  name: string;
  description: string;
  category: "chart" | "analysis" | "export" | "integration" | "theme";
  price: "free" | "paid";
  priceAmount?: number;
  rating: number;
  reviews: number;
  imageUrl?: string;
  isInstalled: boolean;
  installCount: number;
  // For integration plugins
  supportedPlatforms?: string[];
  // For theme plugins
  previewUrl?: string;
}

export interface MarketplaceBrowserProps {
  category?:
    | "chart"
    | "analysis"
    | "export"
    | "integration"
    | "theme";
  searchQuery?: string;
}

export const MarketplaceBrowser: React.FC<MarketplaceBrowserProps> = ({
  category,
  searchQuery,
}) => {
  const [plugins, setPlugins] = useState<MarketplacePlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterCategory, setFilterCategory] = useState<
    | "chart"
    | "analysis"
    | "export"
    | "integration"
    | "theme"
    | undefined
  >(category);

  const fetchPlugins = useCallback(async () => {
    setLoading(true);

    try {
      const data = await prisma.marketplacePlugin.findMany({
        where: {
          ...(filterCategory && { category: filterCategory }),
          // Search query filter (mock - in production would search title/description)
          ...(searchQuery && { name: { contains: searchQuery } }),
        },
        orderBy: { rating: "desc" },
      });

      setPlugins(
        data.map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          description: plugin.description,
          category: plugin.category as MarketplacePlugin["category"],
          price: plugin.price as "free" | "paid",
          priceAmount: plugin.priceAmount ?? undefined,
          rating: plugin.rating,
          reviews: plugin.reviews,
          imageUrl: plugin.imageUrl ?? undefined,
          isInstalled: plugin.isInstalled,
          installCount: plugin.installCount,
          supportedPlatforms: Array.isArray(plugin.supportedPlatforms)
            ? plugin.supportedPlatforms.filter((p): p is string => typeof p === "string")
            : undefined,
          previewUrl: plugin.previewUrl ?? undefined,
        }))
      );
    } catch (error) {
      console.error("Failed to fetch marketplace plugins:", error);
      setPlugins([]);
    } finally {
      setLoading(false);
    }
  }, [filterCategory, searchQuery]);

  useEffect(() => {
    void fetchPlugins();
    setFilterCategory(category);
  }, [category, fetchPlugins]);

  if (loading) {
    return <div className="marketplace-loading">Loading marketplace...</div>;
  }

  const filteredPlugins = category
    ? plugins.filter((p) => p.category === category)
    : plugins;

  return (
    <div className="marketplace-browser">
      <div className="marketplace-header">
        <h2>Marketplace</h2>
        <p>Discover extensions and integrations</p>
      </div>

      <div className="marketplace-filters">
        <select
          value={filterCategory}
          onChange={(_e) => {
            // Reload with new category
          }}
        >
          <option value="">All Categories</option>
          <option value="chart">Charts & Visualizations</option>
          <option value="analysis">Analysis & Insights</option>
          <option value="export">Export & Reporting</option>
          <option value="integration">Integrations</option>
          <option value="theme">Themes & UI</option>
        </select>
      </div>

      <div className="marketplace-search">
        <input
          type="text"
          placeholder="Search plugins..."
          value={searchQuery || ""}
          onChange={(_e) => {
            // Handle search
          }}
        />
      </div>

      <div className="marketplace-cards">
        {filteredPlugins.length === 0 ? (
          <div className="marketplace-empty">
            No plugins found.
          </div>
        ) : (
          <div className="plugin-grid">
            {filteredPlugins.map((plugin) => (
              <div
                key={plugin.id}
                className="plugin-card"
                onClick={() => {
                  // TODO: Install or open details
                }}
              >
                {plugin.imageUrl ? (
                  <Image
                    src={plugin.imageUrl}
                    alt={plugin.name}
                    className="plugin-preview"
                    width={320}
                    height={160}
                    unoptimized
                  />
                ) : (
                  <div
                    className="plugin-preview"
                    style={{ background: "#f0f2f5" }}
                  >
                    {plugin.name.substring(0, 2)}
                  </div>
                )}

                <div className="plugin-info">
                  <h3 className="plugin-name">{plugin.name}</h3>
                  <p className="plugin-description">
                    {plugin.description}
                  </p>
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
                  <div className="plugin-category">
                    {plugin.category}
                  </div>
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
                    onClick={() => {
                      // TODO: Install plugin
                    }}
                  >
                    Install
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};