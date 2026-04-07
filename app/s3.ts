import "dotenv/config";
import { S3Client } from "@aws-sdk/client-s3";

const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
const region = process.env.AWS_REGION?.trim();

console.log("AWS_ACCESS_KEY_ID type:", typeof accessKeyId);
console.log("AWS_SECRET_ACCESS_KEY type:", typeof secretAccessKey);
console.log("AWS_REGION type:", typeof region);
console.log("AWS_ACCESS_KEY_ID length:", accessKeyId?.length);
console.log("AWS_SECRET_ACCESS_KEY length:", secretAccessKey?.length);

if (!accessKeyId) throw new Error("Missing AWS_ACCESS_KEY_ID");
if (!secretAccessKey) throw new Error("Missing AWS_SECRET_ACCESS_KEY");
if (!region) throw new Error("Missing AWS_REGION");

export const s3 = new S3Client({
  region,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});