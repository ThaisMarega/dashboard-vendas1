require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "segredo-temporario";

app.use(cors());
app.use(express.json());

app.get("/", (_, res) => res.send("API ON"));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// =============================
// Criar tabelas
// =============================
async function criarTabelas() {
  const sql = `
    CREATE TABLE IF NOT EXISTS vendedoras (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(100) UNIQUE NOT NULL,
      senha_hash VARCHAR(255) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vendas (
      id SERIAL PRIMARY KEY,
      vendedora_id INTEGER REFERENCES vendedoras(id),
      valor NUMERIC(10,2) NOT NULL,
      forma_pagamento VARCHAR(50) NOT NULL,
      cliente_nome VARCHAR(100),
      observacao TEXT,
      data_venda TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS condicionais (
      id SERIAL PRIMARY KEY,
      vendedora_id INTEGER REFERENCES vendedoras(id),
      quantidade_pecas INTEGER NOT NULL,
      valor_total NUMERIC(10,2),
      cliente_nome VARCHAR(100) NOT NULL,
      observacao TEXT,
      data_registro TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS atendimentos (
      id SERIAL PRIMARY KEY,
      vendedora_id INTEGER REFERENCES vendedoras(id),
      quantidade INTEGER NOT NULL,
      data_registro DATE NOT NULL,
      UNIQUE(vendedora_id, data_registro)
    );

    CREATE TABLE IF NOT EXISTS metas (
      id SERIAL PRIMARY KEY,
      vendedora_id INTEGER REFERENCES vendedoras(id),
      valor_meta NUMERIC(10,2) NOT NULL,
      data_meta DATE NOT NULL,
      UNIQUE(vendedora_id, data_meta)
    );
  `;
  await pool.query(sql);
  console.log("✓ Tabelas prontas");
}

// =============================
// Middleware autenticação
// =============================
function autenticar(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ erro: "Token não enviado" });

  const token = auth.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.vendedoraId = decoded.id;
    next();
  } catch (e) {
    return res.status(401).json({ erro: "Token inválido" });
  }
}

// =============================
// LOGIN
// =============================
app.post("/api/login", async (req, res) => {
  try {
    const { nome, senha } = req.body;
    const query = await pool.query(
      "SELECT * FROM vendedoras WHERE nome = $1",
      [nome]
    );

    if (query.rows.length === 0) {
      return res.status(401).json({ erro: "Usuária não encontrada" });
    }

    const user = query.rows[0];
    const senhaOK = await bcrypt.compare(senha, user.senha_hash);
    if (!senhaOK) return res.status(401).json({ erro: "Senha incorreta" });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "1d" });

    res.json({ token, vendedora: { id: user.id, nome: user.nome } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "Erro no login" });
  }
});

// =============================
// VENDAS
// =============================
app.post("/api/vendas", autenticar, async (req, res) => {
  try {
    const { valor, formaPagamento, clienteNome, observacao } = req.body;

    const r = await pool.query(
      `
      INSERT INTO vendas (vendedora_id, valor, forma_pagamento, cliente_nome, observacao)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
      `,
      [req.vendedoraId, valor, formaPagamento, clienteNome, observacao]
    );

    res.json(r.rows[0]);
  } catch (e) {
    console.error("Erro venda:", e);
    res.status(500).json({ erro: "Erro ao salvar venda" });
  }
});

app.get("/api/vendas", autenticar, async (req, res) => {
  try {
    const { dataInicio, dataFim } = req.query;

    const r = await pool.query(
      `
      SELECT *
      FROM vendas
      WHERE vendedora_id = $1
      AND DATE(data_venda) BETWEEN $2 AND $3
      ORDER BY data_venda DESC
      `,
      [req.vendedoraId, dataInicio, dataFim]
    );

    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "Erro ao buscar vendas" });
  }
});

// =============================
// CONDICIONAIS
// =============================
app.post("/api/condicionais", autenticar, async (req, res) => {
  try {
    const { quantidadePecas, valorTotal, clienteNome, observacao } = req.body;

    const r = await pool.query(
      `
      INSERT INTO condicionais (vendedora_id, quantidade_pecas, valor_total, cliente_nome, observacao)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
      `,
      [req.vendedoraId, quantidadePecas, valorTotal, clienteNome, observacao]
    );

    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "Erro ao lançar condicional" });
  }
});

app.get("/api/condicionais", autenticar, async (req, res) => {
  try {
    const r = await pool.query(
      `
      SELECT *
      FROM condicionais
      WHERE vendedora_id = $1
      ORDER BY data_registro DESC
      `,
      [req.vendedoraId]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ erro: "Erro ao buscar condicionais" });
  }
});

app.delete("/api/condicionais/:id", autenticar, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM condicionais WHERE id = $1 AND vendedora_id = $2",
      [req.params.id, req.vendedoraId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: "Erro ao remover" });
  }
});

// =============================
// ATENDIMENTOS
// =============================
app.post("/api/atendimentos", autenticar, async (req, res) => {
  try {
    const { quantidade, data } = req.body;

    const r = await pool.query(
      `
      INSERT INTO atendimentos (vendedora_id, quantidade, data_registro)
      VALUES ($1, $2, $3)
      ON CONFLICT (vendedora_id, data_registro)
      DO UPDATE SET quantidade = EXCLUDED.quantidade
      RETURNING *;
      `,
      [req.vendedoraId, quantidade, data]
    );

    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ erro: "Erro ao salvar atendimentos" });
  }
});

app.get("/api/atendimentos/:data", autenticar, async (req, res) => {
  try {
    const r = await pool.query(
      `
      SELECT * FROM atendimentos
      WHERE vendedora_id = $1 AND data_registro = $2
      `,
      [req.vendedoraId, req.params.data]
    );

    if (r.rows.length === 0) return res.json({ quantidade: 0 });

    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ erro: "Erro ao buscar atendimentos" });
  }
});

// =============================
// METAS
// =============================
app.post("/api/metas", autenticar, async (req, res) => {
  try {
    const { valorMeta, data } = req.body;

    const r = await pool.query(
      `
      INSERT INTO metas (vendedora_id, valor_meta, data_meta)
      VALUES ($1, $2, $3)
      ON CONFLICT (vendedora_id, data_meta)
      DO UPDATE SET valor_meta = EXCLUDED.valor_meta
      RETURNING *;
      `,
      [req.vendedoraId, valorMeta, data]
    );

    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ erro: "Erro ao salvar meta" });
  }
});

app.get("/api/metas/:data", autenticar, async (req, res) => {
  try {
    const r = await pool.query(
      `
      SELECT valor_meta
      FROM metas
      WHERE vendedora_id = $1 AND data_meta = $2
      `,
      [req.vendedoraId, req.params.data]
    );

    if (r.rows.length === 0) return res.json({ valor_meta: 0 });

    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ erro: "Erro ao buscar meta" });
  }
});

// =============================
// Start
// =============================
app.listen(PORT, async () => {
  await criarTabelas();
  console.log("🔥 API rodando na porta", PORT);
});
