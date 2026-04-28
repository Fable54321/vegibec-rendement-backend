// Utils/s3Visitors.ts
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3 } from "../../../s3"; // adjust path to your existing s3 client

const BUCKET = process.env.AWS_S3_BUCKET_NAME!;

export const uploadVisitorSignatureToS3 = async (
  key: string,
  buffer: Buffer,
) => {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: "image/png",
    }),
  );
};

export const getSignedUrlForVisitorSignature = async (key: string) => {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
    }),
    { expiresIn: 60 * 60 },
  );
};