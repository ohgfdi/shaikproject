import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const bucket = process.env.S3_BUCKET ?? "ledgerly-documents";
const region = process.env.S3_REGION ?? "us-east-1";
const endpoint = process.env.S3_ENDPOINT;

export const s3Client = new S3Client({
  region,
  endpoint,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
  },
});

/**
 * Upload a file to S3 and return the public URL.
 */
export async function uploadFileToS3(file: Buffer, key: string): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: file,
  });
  await s3Client.send(command);

  if (endpoint) {
    return `${endpoint}/${bucket}/${key}`;
  }
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}