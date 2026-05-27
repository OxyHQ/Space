/// <reference path="./.sst/platform/config.d.ts" />

/**
 * Oxy Space SST Infrastructure
 *
 * Manages:
 * - DigitalOcean App Platform (API service + static frontend)
 * - DigitalOcean Spaces bucket (file storage)
 *
 * Shared resources (MongoDB, Valkey) are managed externally
 * and referenced via environment variables.
 *
 * Auth:
 *   export DIGITALOCEAN_TOKEN=dop_v1_...
 *   export CLOUDFLARE_API_TOKEN=...
 *
 * LIVE-INFRA NOTE: Renaming the SST app name, the DO App Platform app, or the
 * Spaces bucket name causes SST to provision NEW resources and orphan the old
 * ones (this can lose data and require manual cleanup). Coordinate any live
 * production rename with operations and migrate file contents first.
 */

export default $config({
  app(input) {
    return {
      name: "oxyspace",
      home: "local",
      removal: input.stage === "production" ? "retain" : "remove",
      providers: {
        digitalocean: "4.63.0",
        cloudflare: "6.14.0",
      },
    };
  },

  async run() {
    const isProd = $app.stage === "production";
    const region = "ams3";

    // -------------------------------------------------------
    // DigitalOcean Spaces bucket for file uploads
    // -------------------------------------------------------
    const bucket = new digitalocean.SpacesBucket("OxySpaceBucket", {
      name: isProd ? "bucket-oxyspace" : `bucket-oxyspace-${$app.stage}`,
      region,
      acl: "private",
    });

    // CORS for the bucket
    new digitalocean.SpacesBucketCorsConfiguration("OxySpaceBucketCors", {
      bucket: bucket.id,
      region,
      corsRules: [
        {
          allowedHeaders: ["*"],
          allowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
          allowedOrigins: isProd
            ? ["https://space.oxy.so", "https://api.space.oxy.so"]
            : ["*"],
          maxAgeSeconds: 3600,
        },
      ],
    });

    // -------------------------------------------------------
    // DigitalOcean App Platform
    // -------------------------------------------------------
    const app = new digitalocean.App("OxySpaceApp", {
      spec: {
        name: isProd ? "oxyspace-production" : `oxyspace-${$app.stage}`,
        region: "ams",

        // --- API service ---
        services: [
          {
            name: "oxyspace-api",
            github: {
              repo: "OxyHQ/Clarity",
              branch: isProd ? "main" : $app.stage,
              deployOnPush: true,
            },
            buildCommand: [
              "ELECTRON_SKIP_BINARY_DOWNLOAD=1",
              "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
              "bun run build:api",
            ].join(" "),
            runCommand: "bun run start:api",
            sourceDir: "/",
            environmentSlug: "node-js",
            instanceSizeSlug: isProd ? "apps-s-2vcpu-4gb" : "apps-s-1vcpu-1gb",
            instanceCount: isProd ? 2 : 1,
            httpPort: 8080,
            healthCheck: {
              httpPath: "/health",
              initialDelaySeconds: 30,
              periodSeconds: 10,
              timeoutSeconds: 5,
              successThreshold: 1,
              failureThreshold: 3,
            },
            envs: [
              // Shared DB references (external, not managed by SST)
              { key: "MONGODB_URI", value: "${db-oxy.DATABASE_URL}" },
              { key: "CA_CERT", value: "${db-oxy.CA_CERT}" },
              { key: "REDIS_URL", value: "${db-valkey.DATABASE_URL}" },
              { key: "REDIS_CA_CERT", value: "${db-valkey.CA_CERT}" },
              // Service config
              { key: "SERVICE_SECRET", type: "SECRET" },
              {
                key: "WEB_URL",
                value: isProd
                  ? "https://space.oxy.so"
                  : `https://${$app.stage}.space.oxy.so`,
              },
              // S3/Spaces
              { key: "AWS_REGION", value: region },
              { key: "AWS_ACCESS_KEY_ID", type: "SECRET" },
              { key: "AWS_SECRET_ACCESS_KEY", type: "SECRET" },
              {
                key: "AWS_ENDPOINT_URL",
                value: `https://${region}.digitaloceanspaces.com`,
              },
              { key: "AWS_S3_BUCKET", value: bucket.name },
              // Stripe
              { key: "STRIPE_SECRET_KEY", type: "SECRET" },
              { key: "STRIPE_WEBHOOK_SECRET", type: "SECRET" },
              // LiveKit
              { key: "LIVEKIT_URL", value: "wss://livekit.oxy.so" },
              { key: "LIVEKIT_API_KEY", type: "SECRET" },
              { key: "LIVEKIT_API_SECRET", type: "SECRET" },
              { key: "LIVEKIT_INTERNAL_URL", value: "wss://livekit.oxy.so" },
            ],
          },
        ],

        // --- Static frontend ---
        staticSites: [
          {
            name: "oxyspace-app",
            github: {
              repo: "OxyHQ/Clarity",
              branch: isProd ? "main" : $app.stage,
              deployOnPush: true,
            },
            buildCommand: [
              "ELECTRON_SKIP_BINARY_DOWNLOAD=1",
              "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
              "bun run build:app",
            ].join(" "),
            sourceDir: "/",
            environmentSlug: "node-js",
            outputDir: "apps/app/dist",
            catchallDocument: "index.html",
          },
        ],

        // --- Managed databases (shared, referenced by name) ---
        databases: [
          {
            name: "db-oxy",
            engine: "MONGODB",
            version: "8",
            production: isProd,
            clusterName: "db-oxy",
          },
          {
            name: "db-valkey",
            engine: "REDIS",
            version: "7",
            production: isProd,
            clusterName: "db-valkey-ams3-04785",
          },
        ],

        // --- Domains ---
        ...(isProd && {
          domains: [
            { domain: "space.oxy.so", type: "PRIMARY", zone: "oxy.so" },
            { domain: "api.space.oxy.so", type: "ALIAS", zone: "oxy.so" },
          ],
        }),

        // --- Alerts ---
        alerts: [
          { rule: "DEPLOYMENT_FAILED" },
          { rule: "DOMAIN_FAILED" },
          { rule: "DEPLOYMENT_LIVE" },
        ],
      },
    });

    return {
      appUrl: app.liveUrl,
      bucketName: bucket.name,
      bucketUrn: bucket.urn,
      stage: $app.stage,
    };
  },
});
