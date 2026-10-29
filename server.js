import "dotenv/config";
import express from "express";
import cors from "cors";
import { db, dbType } from "./src/db.js";
import { initDatabase } from "./src/schema.js";
import authRoutes from "./src/routes/auth.js";
import catalogRoutes from "./src/routes/catalog.js";
import orderRoutes, { expireOverdueOrders } from "./src/routes/orders.js";
import adminRoutes from "./src/routes/admin.js";

const app = express();
const PORT = process.env.PORT || 3001;

// Render fica atrás de proxy: necessário para req.protocol virar https.
app.set("trust proxy", 1);

// FRONTEND_URL aceita várias origens separadas por vírgula.
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  ...(process.env.FRONTEND_URL || "").split(",").map((o) => o.trim()),
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      if (/^http:\/\/localhost:\d+$/.test(origin)) return callback(null, true);
      // Domínios e previews da Vercel do projeto (moura-wear*, mourawear*, moreira-wear*, moreirawear* .vercel.app)
      if (/^https:\/\/(moura|moreira)-?wear[a-z0-9-]*\.vercel\.app$/.test(origin)) return callback(null, true);
      console.warn(`CORS bloqueado para origem: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  }),
);
// Limite maior para upload de fotos (base64) pelo admin.
app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => res.send("MoreiraWear API online 🖤"));
app.get("/health", (req, res) => res.json({ status: "ok", db: dbType }));

// Antes de qualquer rota: cancela pedidos via WhatsApp que passaram do prazo de pagamento.
app.use("/api", (req, res, next) => {
  expireOverdueOrders()
    .catch((error) => console.error("❌ Expirar pedidos:", error.message))
    .finally(next);
});

app.use("/api/auth", authRoutes);
app.use("/api", catalogRoutes);
app.use("/api", orderRoutes);
app.use("/api", adminRoutes);

app.use((err, req, res, next) => {
  console.error("❌", err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : "Erro interno no servidor." });
});

initDatabase()
  .then(() => {
    setInterval(() => expireOverdueOrders({ force: true }).catch((e) => console.error("❌ Expirar pedidos:", e.message)), 5 * 60_000);
    app.listen(PORT, () => console.log(`🚀 MoreiraWear API na porta ${PORT} (${dbType})`));
  })
  .catch(async (error) => {
    console.error("❌ Falha ao iniciar o banco:", error);
    await db.destroy();
    process.exit(1);
  });
