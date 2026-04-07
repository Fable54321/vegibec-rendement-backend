import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "../s3";

export const uploadBufferToS3 = async ({
  key,
  buffer,
  contentType,
}: {
  key: string;
  buffer: Buffer;
  contentType: string;
}) => {
  const bucket = process.env.AWS_BUCKET_NAME;

  if (!bucket) {
    throw new Error("Missing AWS_BUCKET_NAME");
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  return key;
};




