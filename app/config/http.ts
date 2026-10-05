import cors from "cors";
import express, { Express } from "express";
import cookieParser from "cookie-parser";

const allowedOrigins = [
  "http://localhost:5173",
  "https://vegibec-rendement.netlify.app",
  "https://vegibec-usda.netlify.app",
  "http://localhost:5174",
  "https://vegibec-portail.netlify.app",
  "https://vegibec-portail.com",
  "https://gestion-entreposage.netlify.app",
  "https://feuilles-de-temps.netlify.app",
  "https://signature-digitale.netlify.app",
  "https://tb-agrivision.netlify.app",
  "https://punch.vegibec-portail.com",
  "https://rendement.vegibec-portail.com",
  "https://agrivision.vegibec-portail.com",
  "https://signature.vegibec-portail.com",
  "https://plan-du-site-vegibec.netlify.app",
  "http://10.0.1.115:5173",
  "https://inventario-de-cofres.netlify.app",
  "https://picture-transfer.netlify.app",
  "https://horaire-tet.netlify.app",
  "https://horario.vegibec-portail.com",
  "https://devis.vegibec-portail.com",
  "https://achats.vegibec-portail.com",
  "https://agenda.vegibec-portail.com",
  "https://evaluacion.vegibec-portail.com",
  "https://frigos.vegibec-portail.com",
];

const defaultJsonParser = express.json();
const generatedImageJsonParser = express.json({ limit: "50mb" });
const documentScanJsonParser = express.json({ limit: "15mb" });
const routePlanJsonParser = express.json({ limit: "10mb" });

const jsonParser: express.RequestHandler = (req, res, next) => {
  if (req.path.endsWith("/get-url/generated-images")) {
    return generatedImageJsonParser(req, res, next);
  }

  if (
    req.path === "/transport/analyze-document" ||
    /^\/transport\/public-scan\/[^/]+\/analyze-document$/.test(req.path)
  ) {
    return documentScanJsonParser(req, res, next);
  }

  if (/^\/transport\/route-plans(?:\/[^/]+)?$/.test(req.path)) {
    return routePlanJsonParser(req, res, next);
  }

  return defaultJsonParser(req, res, next);
};

const jsonParserErrorHandler: express.ErrorRequestHandler = (
  error,
  _req,
  res,
  next,
) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body is too large" });
  }

  return next(error);
};

export function configureHttp(app: Express): void {
  app.use(jsonParser);
  app.use(jsonParserErrorHandler);
  app.use(cookieParser());
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
          return callback(null, true);
        }

        return callback(new Error("Not allowed by CORS policy"));
      },
      credentials: true,
    }),
  );

  app.set("trust proxy", 1);
}
