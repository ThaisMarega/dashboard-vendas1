// ===================================
// CONFIGURAÇÃO BÁSICA
// ===================================
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "troque-esse-secret-em-producao";

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "*",
  })
);
app.use(express.json());

// Teste rápido no navegador / Render
app.get("/", (_, res) => res.send("API ON"));

// ===================================
// CONEXÃO COM O BANCO (Postgres Render)
// ===================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// ===================================
// CRIAÇÃO / AJUSTE DAS TABELAS
// ===================================
async function criarTabelas() {
  try {
    // Tabela vendedoras
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendedoras (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) UNIQUE NOT NULL,
        senha_hash VARCHAR(255) NOT NULL,
        is_gerente BOOLEAN DEFAULT false
      );
    `);

    // Garante coluna is_gerente (caso a tabela já existisse antes)
    await pool.query(`
      ALTER TABLE vendedoras
      ADD COLUMN IF NOT EXISTS is_gerente BOOLEAN DEFAULT false;
    `);

    // Tabela vendas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendas (
        id SERIAL PRIMARY KEY,
        vendedora_id INTEGER REFERENCES vendedoras(id),
        valor NUMERIC(10,2) NOT NULL,
        quantidade_pecas INTEGER,
        forma_pagamento VARCHAR(50) NOT NULL,
        cliente_nome VARCHAR(100),
        observacao TEXT,
        data_venda TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE vendas
      ADD COLUMN IF NOT EXISTS quantidade_pecas INTEGER;
    `);

    // Tabela condicionais
    await pool.query(`
      CREATE TABLE IF NOT EXISTS condicionais (
        id SERIAL PRIMARY KEY,
        vendedora_id INTEGER REFERENCES vendedoras(id),
        quantidade_pecas INTEGER NOT NULL,
        valor_total NUMERIC(10,2),
        cliente_nome VARCHAR(100) NOT NULL,
        observacao TEXT,
        data_registro TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Atendimentos por dia
    await pool.query(`
      CREATE TABLE IF NOT EXISTS atendimentos (
        id SERIAL PRIMARY KEY,
        vendedora_id INTEGER REFERENCES vendedoras(id),
        quantidade INTEGER NOT NULL,
        data_registro DATE NOT NULL,
        UNIQUE(vendedora_id, data_registro)
      );
    `);

    // Metas diárias
    await pool.query(`
      CREATE TABLE IF NOT EXISTS metas (
        id SERIAL PRIMARY KEY,
        vendedora_id INTEGER REFERENCES vendedoras(id),
        valor_meta NUMERIC(10,2) NOT NULL,
        data_meta DATE NOT NULL,
        UNIQUE(vendedora_id, data_meta)
      );
    `);

    console.log("✅ Tabelas prontas / ajustadas");
  } catch (err) {
    console.error("❌ Erro ao criar tabelas:", err);
  }
}

// ===================================
// MIDDLEWARE DE AUTENTICAÇÃO
// ===================================
async function autenticar(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ erro: "Token não enviado" });

    const token = auth.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    // busca se é gerente
    const r = await pool.query(
      "SELECT id, nome, is_gerente FROM vendedoras WHERE id = $1",
      [decoded.id]
    );

    if (r.rows.length === 0) {
      return res.status(401).json({ erro: "Usuário não encontrado" });
    }

    req.vendedoraId = r.rows[0].id;
    req.vendedoraNome = r.rows[0].nome;
    req.isGerente = r.rows[0].is_gerente === true;

    next();
  } catch (e) {
    console.error("Erro autenticação:", e);
    return res.status(401).json({ erro: "Token inválido" });
  }
}

// helper para checar gerente
function exigirGerente(req, res) {
  if (!req.isGerente) {
    res.status(403).json({ erro: "Apenas gerente pode fazer isso." });
    return false;
  }
  return true;
}

// ===================================
// LOGIN
// ===================================
app.post("/api/login", async (req, res) => {
  try {
    const { nome, senha } = req.body;

    if (!nome || !senha) {
      return res.status(400).json({ erro: "Informe nome e senha." });
    }

    const r = await pool.query(
      "SELECT * FROM vendedoras WHERE nome = $1",
      [nome]
    );

    if (r.rows.length === 0) {
      return res.status(401).json({ erro: "Usuária não encontrada." });
    }

    const user = r.rows[0];
    const senhaOK = await bcrypt.compare(senha, user.senha_hash);

    if (!senhaOK) {
      return res.status(401).json({ erro: "Senha incorreta." });
    }

    const token = jwt.sign({ id: user.id }, JWT_SECRET, {
      expiresIn: "1d",
    });

    res.json({
      token,
      vendedora: {
        id: user.id,
        nome: user.nome,
        isGerente: user.is_gerente === true,
      },
    });
  } catch (e) {
    console.error("Erro no login:", e);
    res.status(500).json({ erro: "Erro ao fazer login." });
  }
});

// ===================================
// GERENTE: LISTAR / CRIAR VENDEDORAS
// ===================================

// GET /api/vendedoras  (apenas gerente)
app.get("/api/vendedoras", autenticar, async (req, res) => {
  try {
    if (!exigirGerente(req, res)) return;

    const r = await pool.query(
      "SELECT id, nome, is_gerente FROM vendedoras ORDER BY nome ASC"
    );
    res.json(r.rows);
  } catch (e) {
    console.error("Erro ao listar vendedoras:", e);
    res.status(500).json({ erro: "Erro ao listar vendedoras." });
  }
});

// POST /api/vendedoras (apenas gerente)
app.post("/api/vendedoras", autenticar, async (req, res) => {
  try {
    if (!exigirGerente(req, res)) return;

    const { nome, senha, isGerente } = req.body;

    if (!nome || !senha) {
      return res
        .status(400)
        .json({ erro: "Nome e senha são obrigatórios." });
    }

    const hash = await bcrypt.hash(senha, 10);

    const r = await pool.query(
      `
      INSERT INTO vendedoras (nome, senha_hash, is_gerente)
      VALUES ($1, $2, $3)
      RETURNING id, nome, is_gerente;
      `,
      [nome, hash, isGerente === true]
    );

    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === "23505") {
      return res
        .status(400)
        .json({ erro: "Já existe vendedora com esse nome." });
    }

    console.error("Erro ao criar vendedora:", e);
    res.status(500).json({ erro: "Erro ao criar vendedora." });
  }
});

// ===================================
// VENDAS
// ===================================

// POST /api/vendas
app.post("/api/vendas", autenticar, async (req, res) => {
  try {
    const { valor, formaPagamento, clienteNome, observacao, quantidadePecas } =
      req.body;

    if (!valor || !formaPagamento) {
      return res
        .status(400)
        .json({ erro: "Valor e forma de pagamento são obrigatórios." });
    }

    const r = await pool.query(
      `
      INSERT INTO vendas (vendedora_id, valor, quantidade_pecas, forma_pagamento, cliente_nome, observacao)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
      `,
      [
        req.vendedoraId,
        valor,
        quantidadePecas || null,
        formaPagamento,
        clienteNome || null,
        observacao || null,
      ]
    );

    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error("Erro venda:", e);
    res.status(500).json({ erro: "Erro ao salvar venda." });
  }
});

// PUT /api/vendas/:id (editar venda)
app.put("/api/vendas/:id", autenticar, async (req, res) => {
  try {
    const { id } = req.params;
    const { valor, formaPagamento, clienteNome, observacao, quantidadePecas } =
      req.body;

    const r = await pool.query(
      `
      UPDATE vendas
      SET valor = $1,
          quantidade_pecas = $2,
          forma_pagamento = $3,
          cliente_nome = $4,
          observacao = $5
      WHERE id = $6 AND vendedora_id = $7
      RETURNING *;
      `,
      [
        valor,
        quantidadePecas || null,
        formaPagamento,
        clienteNome || null,
        observacao || null,
        id,
        req.vendedoraId,
      ]
    );

    if (r.rows.length === 0) {
      return res.status(404).json({ erro: "Venda não encontrada." });
    }

    res.json(r.rows[0]);
  } catch (e) {
    console.error("Erro ao editar venda:", e);
    res.status(500).json({ erro: "Erro ao editar venda." });
  }
});

// DELETE /api/vendas/:id
app.delete("/api/vendas/:id", autenticar, async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      "DELETE FROM vendas WHERE id = $1 AND vendedora_id = $2",
      [id, req.vendedoraId]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("Erro ao deletar venda:", e);
    res.status(500).json({ erro: "Erro ao deletar venda." });
  }
});

// GET /api/vendas?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD[&vendedoraId=]
app.get("/api/vendas", autenticar, async (req, res) => {
  try {
    let { dataInicio, dataFim, vendedoraId } = req.query;

    if (!dataInicio || !dataFim) {
      return res
        .status(400)
        .json({ erro: "Informe dataInicio e dataFim (YYYY-MM-DD)." });
    }

    let params = [];
    let condicoes = [];

    if (req.isGerente) {
      // gerente pode ver todas ou filtrar por vendedora
      if (vendedoraId) {
        condicoes.push("vendedora_id = $1");
        params.push(vendedoraId);
      }
    } else {
      condicoes.push("vendedora_id = $1");
      params.push(req.vendedoraId);
    }

    condicoes.push("DATE(data_venda) BETWEEN $2 AND $3");
    params.push(dataInicio, dataFim);

    const r = await pool.query(
      `
      SELECT *
      FROM vendas
      WHERE ${condicoes.join(" AND ")}
      ORDER BY data_venda DESC
      `,
      params
    );

    res.json(r.rows);
  } catch (e) {
    console.error("Erro ao buscar vendas:", e);
    res.status(500).json({ erro: "Erro ao buscar vendas." });
  }
});

// ===================================
// CONDICIONAIS
// ===================================
app.post("/api/condicionais", autenticar, async (req, res) => {
  try {
    const { quantidadePecas, valorTotal, clienteNome, observacao } = req.body;

    if (!quantidadePecas || !clienteNome) {
      return res.status(400).json({
        erro: "Informe quantidade de peças e nome da cliente.",
      });
    }

    const r = await pool.query(
      `
      INSERT INTO condicionais (vendedora_id, quantidade_pecas, valor_total, cliente_nome, observacao)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
      `,
      [
        req.vendedoraId,
        quantidadePecas,
        valorTotal || 0,
        clienteNome,
        observacao || null,
      ]
    );

    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error("Erro condicional:", e);
    res.status(500).json({ erro: "Erro ao lançar condicional." });
  }
});

app.get("/api/condicionais", autenticar, async (req, res) => {
  try {
    let condicao = "vendedora_id = $1";
    let params = [req.vendedoraId];

    if (req.isGerente) {
      // gerente vê tudo
      condicao = "1=1";
      params = [];
    }

    const r = await pool.query(
      `
      SELECT *
      FROM condicionais
      WHERE ${condicao}
      ORDER BY data_registro DESC
      `,
      params
    );

    res.json(r.rows);
  } catch (e) {
    console.error("Erro buscar condicionais:", e);
    res.status(500).json({ erro: "Erro ao buscar condicionais." });
  }
});

app.delete("/api/condicionais/:id", autenticar, async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      "DELETE FROM condicionais WHERE id = $1 AND vendedora_id = $2",
      [id, req.vendedoraId]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("Erro deletar condicional:", e);
    res.status(500).json({ erro: "Erro ao deletar condicional." });
  }
});

// ===================================
// ATENDIMENTOS
// ===================================
app.post("/api/atendimentos", autenticar, async (req, res) => {
  try {
    const { quantidade, data } = req.body;

    if (!data) {
      return res.status(400).json({ erro: "Data é obrigatória." });
    }

    const r = await pool.query(
      `
      INSERT INTO atendimentos (vendedora_id, quantidade, data_registro)
      VALUES ($1, $2, $3)
      ON CONFLICT (vendedora_id, data_registro)
      DO UPDATE SET quantidade = EXCLUDED.quantidade
      RETURNING *;
      `,
      [req.vendedoraId, quantidade || 0, data]
    );

    res.json(r.rows[0]);
  } catch (e) {
    console.error("Erro atendimentos:", e);
    res.status(500).json({ erro: "Erro ao salvar atendimentos." });
  }
});

app.get("/api/atendimentos/:data", autenticar, async (req, res) => {
  try {
    const { data } = req.params;

    const r = await pool.query(
      `
      SELECT * FROM atendimentos
      WHERE vendedora_id = $1 AND data_registro = $2
      `,
      [req.vendedoraId, data]
    );

    if (r.rows.length === 0) {
      return res.json({ quantidade: 0 });
    }

    res.json(r.rows[0]);
  } catch (e) {
    console.error("Erro buscar atendimentos:", e);
    res.status(500).json({ erro: "Erro ao buscar atendimentos." });
  }
});

// ===================================
// METAS
// ===================================
app.post("/api/metas", autenticar, async (req, res) => {
  try {
    const { valorMeta, data } = req.body;

    if (!data || valorMeta == null) {
      return res
        .status(400)
        .json({ erro: "Valor da meta e data são obrigatórios." });
    }

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
    console.error("Erro salvar meta:", e);
    res.status(500).json({ erro: "Erro ao salvar meta." });
  }
});

app.get("/api/metas/:data", autenticar, async (req, res) => {
  try {
    const { data } = req.params;

    const r = await pool.query(
      `
      SELECT valor_meta
      FROM metas
      WHERE vendedora_id = $1 AND data_meta = $2
      `,
      [req.vendedoraId, data]
    );

    if (r.rows.length === 0) {
      return res.json({ valor_meta: 0 });
    }

    res.json(r.rows[0]);
  } catch (e) {
    console.error("Erro buscar meta:", e);
    res.status(500).json({ erro: "Erro ao buscar meta." });
  }
});

// ===================================
// START
// ===================================
app.listen(PORT, async () => {
  await criarTabelas();
  console.log(`🔥 API rodando na porta ${PORT}`);
});
