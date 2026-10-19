import "dotenv/config";
import { GetBucketCorsCommand, PutBucketCorsCommand, S3Client } from "@aws-sdk/client-s3";
import { r2Settings } from "./storage.js";

const settings = r2Settings();
const origins = [
  ...(process.env.FRONTEND_ORIGIN || "").split(","),
  ...(process.env.PUBLIC_SITE_ORIGINS || "https://creationsbysneha.in,https://www.creationsbysneha.in").split(","),
]
  .map((origin) => origin.trim())
  .filter(Boolean);

const client = new S3Client({
  region: "auto",
  endpoint: settings.endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
});

await client.send(
  new PutBucketCorsCommand({
    Bucket: settings.publicBucket,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: [...new Set(origins)],
          AllowedMethods: ["GET", "HEAD"],
          AllowedHeaders: ["*"],
          ExposeHeaders: ["ETag", "Cache-Control", "Content-Type"],
          MaxAgeSeconds: 3600,
        },
      ],
    },
  }),
);

const current = await client.send(new GetBucketCorsCommand({ Bucket: settings.publicBucket }));
console.log(JSON.stringify(current.CORSRules, null, 2));
