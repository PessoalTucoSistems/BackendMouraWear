import crypto from "crypto";
import bcrypt from "bcryptjs";
import { db, now } from "./db.js";

export const ADMIN_EMAIL = "moreirawear@admin.com";
const LEGACY_ADMIN_EMAIL = "mourawear@admin.com";
const DEFAULT_ADMIN_PASSWORD = "12345678";

export const DEFAULT_SETTINGS = {
  announcement: "FRETE GRÁTIS ACIMA DE R$ 299 ✦ NOVO DROP DISPONÍVEL ✦ PARCELE EM ATÉ 6X ✦ TROCA GRÁTIS EM 30 DIAS",
  whatsapp: "",
  instagram: "",
  pixKey: "",
  shippingFee: "19.90",
  freeShippingMin: "299",
};

const DEFAULT_CATEGORIES = ["Camisetas", "Moletons", "Calças", "Bermudas", "Bonés", "Acessórios"];

const SAMPLE_PRODUCTS = [
  { name: "Camiseta Oversized Concrete", category: "Camisetas", price: 129.9, compare: 159.9, featured: true, isNew: true, color: "#1a1a1a",
    description: "Algodão 100% fio 30.1 penteado, modelagem oversized e estampa em silk na costas." },
  { name: "Camiseta Boxy Acid Wash", category: "Camisetas", price: 139.9, featured: true, color: "#4b4b4b",
    description: "Lavagem estonada exclusiva, gola canelada larga e caimento boxy." },
  { name: "Moletom Heavy Hoodie MW", category: "Moletons", price: 289.9, compare: 349.9, featured: true, isNew: true, color: "#2d2f24",
    description: "Moletom flanelado 480g, capuz forrado e bordado MW no peito." },
  { name: "Calça Cargo Utility", category: "Calças", price: 249.9, isNew: true, color: "#3a3a2e",
    description: "Sarja com elastano, seis bolsos e ajuste no tornozelo." },
  { name: "Bermuda Jorts Baggy", category: "Bermudas", price: 179.9, color: "#2b3a55",
    description: "Jeans 14oz, modelagem baggy e barra a fio." },
  { name: "Boné Dad Hat Logo", category: "Bonés", price: 99.9, featured: true, color: "#111111", sizes: ["U"],
    description: "Aba curva, fecho de metal e logo bordado em 3D." },
];

async function createTable(name, build) {
  if (!(await db.schema.hasTable(name))) {
    await db.schema.createTable(name, build);
    console.log(`✅ Tabela '${name}' criada`);
    return true;
  }
  return false;
}

async function addColumns(table, columns) {
  for (const [name, build] of Object.entries(columns)) {
    if (!(await db.schema.hasColumn(table, name))) {
      await db.schema.alterTable(table, build);
      console.log(`✅ Coluna '${table}.${name}' criada`);
    }
  }
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export async function getSetting(key) {
  const row = await db("settings").where({ key }).first();
  return row ? row.value : DEFAULT_SETTINGS[key];
}

async function setSetting(key, value) {
  const exists = await db("settings").where({ key }).first();
  if (exists) await db("settings").where({ key }).update({ value });
  else await db("settings").insert({ key, value });
}

// Cria o admin na primeira subida. Depois disso a senha pode ser trocada pela
// aba Usuários; ela só é sobrescrita quando a variável ADMIN_PASSWORD do Render
// muda de valor (guardamos o hash da última aplicada para comparar).
async function ensureAdmin() {
  const envPassword = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
  const envHash = sha256(envPassword);

  // A marca mudou de MouraWear para MoreiraWear: renomeia o admin antigo mantendo a senha.
  const legacy = await db("users").where({ email: LEGACY_ADMIN_EMAIL }).first();
  if (legacy && !(await db("users").where({ email: ADMIN_EMAIL }).first())) {
    await db("users").where({ id: legacy.id }).update({ email: ADMIN_EMAIL, name: "Admin MoreiraWear" });
    console.log(`👤 Admin renomeado: ${LEGACY_ADMIN_EMAIL} → ${ADMIN_EMAIL}`);
  }

  const admin = await db("users").where({ email: ADMIN_EMAIL }).first();

  if (!admin) {
    await db("users").insert({
      id: crypto.randomUUID(),
      name: "Admin MoreiraWear",
      email: ADMIN_EMAIL,
      password_hash: await bcrypt.hash(envPassword, 10),
      role: "admin",
      created_at: now(),
    });
    await setSetting("_adminEnvPasswordHash", envHash);
    console.log(`👤 Admin criado: ${ADMIN_EMAIL}`);
    return;
  }

  const appliedHash = await getSetting("_adminEnvPasswordHash");
  if (process.env.ADMIN_PASSWORD && appliedHash !== envHash) {
    await db("users")
      .where({ id: admin.id })
      .update({ password_hash: await bcrypt.hash(envPassword, 10), role: "admin" });
    await setSetting("_adminEnvPasswordHash", envHash);
    console.log("🔑 Senha do admin atualizada a partir de ADMIN_PASSWORD");
  }
}

export async function initDatabase() {
  await createTable("users", (t) => {
    t.string("id").primary();
    t.string("name").notNullable();
    t.string("email").notNullable().unique();
    t.string("password_hash").notNullable();
    t.string("phone");
    t.string("role").notNullable().defaultTo("customer");
    t.string("created_at");
  });

  const newCategories = await createTable("categories", (t) => {
    t.string("id").primary();
    t.string("name").notNullable().unique();
    t.integer("sort_order").defaultTo(0);
  });

  const newProducts = await createTable("products", (t) => {
    t.string("id").primary();
    t.string("name").notNullable();
    t.text("description");
    t.decimal("price", 10, 2).notNullable();
    t.decimal("compare_at_price", 10, 2);
    t.string("category");
    t.text("images"); // JSON: string[]
    t.text("sizes"); // JSON: [{ size, stock }]
    t.boolean("featured").defaultTo(false);
    t.boolean("is_new").defaultTo(false);
    t.boolean("active").defaultTo(true);
    t.string("color"); // cor de fundo do card quando não há foto
    t.string("created_at");
  });

  await createTable("banners", (t) => {
    t.string("id").primary();
    t.text("image").notNullable();
    t.string("title");
    t.string("subtitle");
    t.string("button_label");
    t.string("category"); // categoria para onde o botão leva
    t.integer("sort_order").defaultTo(0);
    t.boolean("active").defaultTo(true);
  });

  await createTable("orders", (t) => {
    t.string("id").primary();
    t.string("user_id");
    t.string("customer_name");
    t.string("customer_email");
    t.string("customer_phone");
    t.text("items").notNullable(); // JSON
    t.decimal("subtotal", 10, 2).notNullable();
    t.decimal("shipping", 10, 2).defaultTo(0);
    t.decimal("total", 10, 2).notNullable();
    t.text("address"); // JSON
    t.string("payment_method");
    t.string("status").notNullable().defaultTo("pending");
    t.string("payment_id");
    t.text("payment_url");
    t.text("notes");
    t.string("created_at");
    t.string("updated_at");
  });

  // Colunas adicionadas depois do primeiro deploy (bancos existentes ganham via ALTER).
  await addColumns("orders", {
    expires_at: (t) => t.string("expires_at"), // reserva de estoque dos pedidos via WhatsApp
    cancel_reason: (t) => t.string("cancel_reason"), // "expired" quando cancelado automaticamente
    notice_seen: (t) => t.boolean("notice_seen").defaultTo(true), // aviso de cancelamento já visto pelo cliente
  });

  // Imagens enviadas pelo admin ficam no banco: o disco do Render é efêmero.
  await createTable("images", (t) => {
    t.string("id").primary();
    t.string("mime").notNullable();
    t.text("data").notNullable(); // base64
    t.string("created_at");
  });

  await createTable("settings", (t) => {
    t.string("key").primary();
    t.text("value");
  });

  await ensureAdmin();

  if (newCategories) {
    await db("categories").insert(
      DEFAULT_CATEGORIES.map((name, index) => ({ id: crypto.randomUUID(), name, sort_order: index })),
    );
  }

  if (newProducts) {
    await db("products").insert(
      SAMPLE_PRODUCTS.map((p) => ({
        id: crypto.randomUUID(),
        name: p.name,
        description: p.description,
        price: p.price,
        compare_at_price: p.compare || null,
        category: p.category,
        images: "[]",
        sizes: JSON.stringify((p.sizes || ["P", "M", "G", "GG"]).map((size) => ({ size, stock: 10 }))),
        featured: !!p.featured,
        is_new: !!p.isNew,
        active: true,
        color: p.color,
        created_at: now(),
      })),
    );
    console.log("🧥 Produtos de exemplo inseridos");
  }
}
