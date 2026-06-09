import crypto from "crypto";
import path from "path";

 const getPictureExtension = (file: Express.Multer.File) => {
  const extension = path.extname(file.originalname).toLowerCase();

  if (extension && extension.length <= 10) {
    return extension;
  }

  if (file.mimetype === "image/png") return ".png";
  if (file.mimetype === "image/webp") return ".webp";
  if (file.mimetype === "image/jpeg") return ".jpg";

  return ".jpg";
}; 

export const createPurchaseRequestPictureKey = (
  purchaseRequestId: number,
  file: Express.Multer.File,
  index: number
) => {
  const randomId = crypto.randomBytes(16).toString("hex");
  const extension = getPictureExtension(file);

  return `purchase-requests/${purchaseRequestId}/pictures/${index + 1}-${randomId}${extension}`;
};