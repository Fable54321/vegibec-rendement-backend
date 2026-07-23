import { DeleteObjectCommand, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";


import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

export const deleteObjectFromS3 = async (key: string) => {
  const bucket = process.env.AWS_BUCKET_NAME;

  if (!bucket) {
    throw new Error("Missing AWS_BUCKET_NAME");
  }

  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
};





export const getSignedUrlForKey = async (
  key: string,
  options: {
    expiresIn?: number;
    responseContentDisposition?: string;
    responseContentType?: string;
  } = {}
) => {
  const bucket = process.env.AWS_BUCKET_NAME;

  if (!bucket) {
    throw new Error("AWS_BUCKET_NAME is not defined");
  }

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: options.responseContentDisposition,
    ResponseContentType: options.responseContentType,
  });

  return getSignedUrl(s3, command, { expiresIn: options.expiresIn ?? 60 * 5 });


};


const streamToBuffer = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
};

export const getBufferFromS3 = async (key: string): Promise<Buffer> => {
  const bucket = process.env.AWS_BUCKET_NAME;

  if (!bucket) {
    throw new Error("AWS_BUCKET_NAME is not defined");
  }

  const response = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  if (!response.Body) {
    throw new Error("Fichier introuvable dans S3");
  }

  return streamToBuffer(response.Body as NodeJS.ReadableStream);
};
