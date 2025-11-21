process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

console.log("Iniciando server.js...");

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "troque-este-secret";

// MIDDLEWARES
app.use(
  cors({
    origin: "*",
  })
);
app.use(express.json());

// TESTE RÁPIDO
app.get("/", (_, res) => res.send("API OK"));

// CONEXÃO COM BANCO
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// CRIAÇÃO DAS TABELAS
const criarTabelas = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendedoras (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(100) NOT NULL UNIQUE,
      senha_hash VARCHAR(255) NOT NULL,
      email VARCHAR(100),
      meta_padrao DECIMAL(10,2) DEFAULT 15000,
      ativo BOOLEAN DEFAULT true,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vendas (
      id SERIAL PRIMARY KEY,
      vendedora_id INTEGER REFERENCES vendedoras(id),
      valor DECIMAL(10,2) NOT NULL,
      forma_pagamento VARCHAR(50) NOT NULL,
      pecas INTEGER DEFAULT 0,
      cliente_nome VARCHAR(100),
      observacao TEXT,
      data_venda TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS condicionais (
      id SERIAL PRIMARY KEY,
      vendedora_id INTEGER REFERENCES vendedoras(id),
      quantidade_pecas INTEGER NOT NULL,
      valor_total DECIMAL(10,2) NOT NULL,
      cliente_nome VARCHAR(100),
      observacao TEXT,
      data_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS atendimentos (
      id SERIAL PRIMARY KEY,
      vendedora_id INTEGER REFERENCES vendedoras(id),
      quantidade INTEGER NOT NULL,
      pecas INTEGER DEFAULT 0,
      data_registro DATE NOT NULL,
      UNIQUE(vendedora_id, data_registro)
    );

    CREATE TABLE IF NOT EXISTS metas (
      id SERIAL PRIMARY KEY,
      vendedora_id INTEGER REFERENCES vendedoras(id),
      valor_meta DECIMAL(10,2) NOT NULL,
      data_meta DATE NOT NULL,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(vendedora_id, data_meta)
    );
  `);

  console.log("✅ Tabelas criadas com sucesso!");
};

// --------------------------- AUTENTICAÇÃO --------------------------- //

const autenticar = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ erro: "Token não fornecido" });

    const decoded = jwt.verify(token, JWT_SECRET);
    req.vendedoraId = decoded.id;

    next();
  } catch (error) {
    return res.status(401).json({ erro: "Token inválido" });
  }
};

// LOGIN
app.post("/api/login", async (req, res) => {
  try {
    const { nome, senha } = req.body;

    const result = await pool.query(
      "SELECT * FROM vendedoras WHERE nome = $1 AND ativo = true",
      [nome]
    );

    if (result.rows.length === 0)
      return res.status(401).json({ erro: "Credenciais inválidas" });

    const vendedora = result.rows[0];

    const senhaValida = await bcrypt.compare(senha, vendedora.senha_hash);
    if (!senhaValida)
      return res.status(401).json({ erro: "Credenciais inválidas" });

    const token = jwt.sign({ id: vendedora.id }, JWT_SECRET, {
      expiresIn: "24h",
    });

    res.json({
      token,
      vendedora: {
        id: vendedora.id,
        nome: vendedora.nome,
        email: vendedora.email,
        metaPadrao: parseFloat(vendedora.meta_padrao),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro no servidor" });
  }
});

// --------------------------- VENDAS --------------------------- //

app.post("/api/vendas", autenticar, async (req, res) => {
  try {
    const { valor, formaPagamento, clienteNome, observacao, pecas } = req.body;

    const result = await pool.query(
      `INSERT INTO vendas (vendedora_id, valor, forma_pagamento, cliente_nome, observacao, pecas)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.vendedoraId, valor, formaPagamento, clienteNome, observacao, pecas]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao salvar venda" });
  }
});

app.get("/api/vendas/hoje", autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM vendas 
       WHERE vendedora_id = $1 
       AND DATE(data_venda) = CURRENT_DATE
       ORDER BY data_venda DESC`,
      [req.vendedoraId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao buscar vendas" });
  }
});

// --------------------------- ATENDIMENTOS --------------------------- //

app.post("/api/atendimentos", autenticar, async (req, res) => {
  try {
    const { quantidade, pecas } = req.body;

    const result = await pool.query(
      `INSERT INTO atendimentos (vendedora_id, quantidade, pecas, data_registro)
       VALUES ($1,$2,$3,CURRENT_DATE)
       ON CONFLICT (vendedora_id, data_registro)
       DO UPDATE SET quantidade = $2, pecas = $3
       RETURNING *`,
      [req.vendedoraId, quantidade, pecas]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao salvar atendimento" });
  }
});

// --------------------------- METAS --------------------------- //

app.get("/api/metas/hoje", autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM metas WHERE vendedora_id = $1 AND data_meta = CURRENT_DATE`,
      [req.vendedoraId]
    );

    if (result.rows.length === 0) {
      const vend = await pool.query(
        "SELECT meta_padrao FROM vendedoras WHERE id = $1",
        [req.vendedoraId]
      );

      return res.json({ valor_meta: vend.rows[0].meta_padrao });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao buscar meta" });
  }
});

// --------------------------- INICIAR SERVIDOR --------------------------- //

app.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  await criarTabelas();
});
