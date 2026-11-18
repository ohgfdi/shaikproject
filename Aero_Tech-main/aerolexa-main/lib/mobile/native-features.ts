/**
 * Phase 53: Mobile-Native Features (Push Notifications, Biometric Auth)
 *
 * Mobile-native capabilities including push notification handling, biometric
 * authentication, offline caching, and device-specific optimizations. Builds
 * on the React Native mobile dashboard (Phase 29) with native feature integration.
 */
import type { NextRequest } from "next/server";

import type { Industry } from "@/lib/industry";

export type MobilePlatform = "ios" | "android" | "web";

export type BiometricType = "fingerprint" | "face-id" | "iris" | "none";

export interface MobileDeviceInfo {
  platform: MobilePlatform;
  model: string;
  os_version: string;
  app_version: string;
  device_id: string;
  locale: string;
  time_zone: string;
  push_token?: string;
  biometric_enabled: BiometricType;
  offline_capable: boolean;
}

export interface PushNotification {
  id: string;
  title: string;
  body: string;
  type: "info" | "warning" | "critical" | "kpi_alert" | " workflow_alert";
  data: Record<string, any>;
  target_role?: string[];
  target_industry?: Industry[];
  scheduled_at?: Date;
  delivered_at?: Date;
  read_at?: Date;
}

export interface KpiAlert {
  id: string;
  kpi_id: string;
  kpi_name: string;
  current_value: number;
  threshold_value: number;
  operator: ">" | "<" | ">=" | "<=";
  message: string;
  notification_type: "push" | "email" | "sms";
  is_active: boolean;
  triggered_at: Date;
}

export function getPlatformSpecificConfig(
  platform: MobilePlatform
): {
  push_services: string[];
  biometric_supported: BiometricType[];
  offline_storage_limit_mb: number;
  background_refresh_minutes: number;
} {
  const configs: Record<MobilePlatform, {
    push_services: string[];
    biometric_supported: BiometricType[];
    offline_storage_limit_mb: number;
    background_refresh_minutes: number;
  }> = {
    ios: {
      push_services: ["APNs"],
      biometric_supported: ["face-id", "fingerprint"],
      offline_storage_limit_mb: 500,
      background_refresh_minutes: 15,
    },
    android: {
      push_services: ["FCM"],
      biometric_supported: ["face-id", "fingerprint"],
      offline_storage_limit_mb: 500,
      background_refresh_minutes: 15,
    },
    web: {
      push_services: ["Web Push API"],
      biometric_supported: ["none"],
      offline_storage_limit_mb: 200,
      background_refresh_minutes: 30,
    },
  };

  return configs[platform] || configs.web;
}

/** Check if biometric authentication is available for the platform. */
export function isBiometricAvailable(
  platform: MobilePlatform,
  biometricType: BiometricType
): boolean {
  const supported = getPlatformSpecificConfig(platform).biometric_supported;
  return supported.includes(biometricType);
}

/** Get push notification configuration for a platform. */
export function getPushConfig(platform: MobilePlatform): {
  service: string;
  sender_id?: string;
  vapid_keys?: { publicKey: string; privateKey: string };
} {
  const configs: Record<MobilePlatform, {
    service: string;
    sender_id?: string;
    vapid_keys?: { publicKey: string; privateKey: string };
  }> = {
    ios: {
      service: "APNs",
    },
    android: {
      service: "FCM",
      sender_id: process.env.FCM_SENDER_ID,
    },
    web: {
      service: "Web Push API",
      vapid_keys: {
        publicKey: process.env.VAPID_PUBLIC_KEY || "",
        privateKey: process.env.VAPID_PRIVATE_KEY || "",
      },
    },
  };

  return configs[platform] || configs.web;
}

/** API route for mobile native features. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "device-info";

    if (action === "device-info") {
      const platform = searchParams.get("platform") as MobilePlatform || "web";

      const deviceInfo: MobileDeviceInfo = {
        platform,
        model: "Generic Mobile Device",
        os_version: "15.0+",
        app_version: "2.0.0",
        device_id: `device_${Date.now()}`,
        locale: "en-US",
        time_zone: "UTC",
        push_token: undefined,
        biometric_enabled: "none",
        offline_capable: true,
      };

      return new Response(JSON.stringify(deviceInfo), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "push-config") {
      const platform = searchParams.get("platform") as MobilePlatform || "web";
      const config = getPlatformSpecificConfig(platform);

      return new Response(JSON.stringify({ platform, config }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "biometric-check") {
      const platform = searchParams.get("platform") as MobilePlatform || "web";
      const biometricType = searchParams.get(
        "type"
      ) as BiometricType || "face-id";

      const available = isBiometricAvailable(platform, biometricType);

      return new Response(JSON.stringify({ platform, type: biometricType, available }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Default: list capabilities
    const deviceInfo: MobileDeviceInfo = {
      platform: "web",
      model: "Generic Mobile Device",
      os_version: "15.0+",
      app_version: "2.0.0",
      device_id: `device_${Date.now()}`,
      locale: "en-US",
      time_zone: "UTC",
      push_token: undefined,
      biometric_enabled: "none",
      offline_capable: true,
    };

    return new Response(JSON.stringify(deviceInfo), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Mobile native features error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve mobile native features" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}