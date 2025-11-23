// ===========================================
// IMAGEM MODAS - DASHBOARD DE VENDAS
// Backend completo com gerente + vendedoras
// Metas mensais automáticas + edição de vendas
// ===========================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "imgmodas-secret";

// CORS liberado para seu frontend oficial:
app.use(
  cors({
    origin: "*",
  })
);

app.use(express.json());

// ---------------------------
// Conexão com o banco Render
// ---------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// =====================================================
// 1. CRIAÇÃO DAS TABELAS + USUÁRIA GERENTE AUTOMÁTICA
// =====================================================
async function inicializarBanco() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendedoras (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL UNIQUE,
        senha_hash VARCHAR(255) NOT NULL,
        email VARCHAR(100),
        meta_padrao DECIMAL(10,2) DEFAULT 15000,
        role VARCHAR(20) DEFAULT 'vendedora',
        ativo BOOLEAN DEFAULT true,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS vendas (
        id SERIAL PRIMARY KEY,
        vendedora_id INTEGER REFERENCES vendedoras(id),
        valor DECIMAL(10,2) NOT NULL,
        forma_pagamento VARCHAR(50) NOT NULL,
        cliente_nome VARCHAR(100),
        observacao TEXT,
        pecas INTEGER DEFAULT 1,
        data_venda TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS condicionais (
        id SERIAL PRIMARY KEY,
        vendedora_id INTEGER REFERENCES vendedoras(id),
        quantidade_pecas INTEGER NOT NULL,
        valor_total DECIMAL(10,2),
        cliente_nome VARCHAR(100) NOT NULL,
        observacao TEXT,
        data_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS atendimentos (
        id SERIAL PRIMARY KEY,
        vendedora_id INTEGER REFERENCES vendedoras(id),
        quantidade INTEGER NOT NULL,
        data_registro DATE NOT NULL,
        UNIQUE(vendedora_id, data_registro)
      );

      CREATE TABLE IF NOT EXISTS metas_mensais (
        id SERIAL PRIMARY KEY,
        vendedora_id INTEGER REFERENCES vendedoras(id),
        ano INTEGER NOT NULL,
        mes INTEGER NOT NULL,
        meta_total DECIMAL(12,2) NOT NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(vendedora_id, ano, mes)
      );
    `);

    console.log("✅ Tabelas criadas/checadas com sucesso.");

    // -------------------------
    // Criar gerente automática
    // -------------------------
    const gerenteExiste = await pool.query(
      "SELECT * FROM vendedoras WHERE role = 'gerente' LIMIT 1"
    );

    if (gerenteExiste.rows.length === 0) {
      const hash = await bcrypt.hash("gerente2025", 10);

      await pool.query(
        `INSERT INTO vendedoras (nome, senha_hash, email, role, meta_padrao)
         VALUES ('gerente', $1, 'gerente@imagemmodas.com.br', 'gerente', 15000)`,
        [hash]
      );

      console.log("👑 Gerente criada automaticamente (login: gerente / senha: gerente2025)");
    }
  } catch (e) {
    console.error("❌ ERRO AO INICIALIZAR BANCO:", e);
  }
}

// =====================================================
// 2. MIDDLEWARE DE AUTENTICAÇÃO
// =====================================================
const autenticar = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token)
      return res.status(401).json({ erro: "Token não fornecido." });

    const decoded = jwt.verify(token, JWT_SECRET);
    req.vendedoraId = decoded.id;
    req.role = decoded.role;
    next();
  } catch (e) {
    return res.status(401).json({ erro: "Token inválido." });
  }
};

// --------------------------
// Middleware: somente gerente
// --------------------------
const somenteGerente = (req, res, next) => {
  if (req.role !== "gerente") {
    return res.status(403).json({ erro: "Acesso restrito à gerente." });
  }
  next();
};

// =====================================================
// 3. LOGIN (VENDEDORA + GERENTE)
// =====================================================
app.post("/api/login", async (req, res) => {
  try {
    const { nome, senha } = req.body;

    const r = await pool.query(
      "SELECT * FROM vendedoras WHERE nome = $1 AND ativo = true",
      [nome]
    );

    if (r.rows.length === 0)
      return res.status(401).json({ erro: "Credenciais inválidas." });

    const v = r.rows[0];

    const senhaOK = await bcrypt.compare(senha, v.senha_hash);
    if (!senhaOK)
      return res.status(401).json({ erro: "Credenciais inválidas." });

    const token = jwt.sign(
      { id: v.id, role: v.role, nome: v.nome },
      JWT_SECRET,
      { expiresIn: "24h" }
    );

    res.json({
      token,
      vendedora: {
        id: v.id,
        nome: v.nome,
        email: v.email,
        role: v.role,
        metaPadrao: v.meta_padrao,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "Erro no login." });
  }
});
// =====================================================
// 4. CADASTRO / EDIÇÃO / LISTAGEM DE VENDEDORAS (GERENTE)
// =====================================================

// Listar todas as vendedoras
app.get("/api/vendedoras", autenticar, somenteGerente, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT id, nome, email, role, meta_padrao, ativo FROM vendedoras ORDER BY nome"
    );
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "Erro ao listar vendedoras." });
  }
});

// Criar vendedora
app.post("/api/vendedoras", autenticar, somenteGerente, async (req, res) => {
  try {
    const { nome, senha, email, metaPadrao, role } = req.body;

    const hash = await bcrypt.hash(senha, 10);

    const r = await pool.query(
      `INSERT INTO vendedoras (nome, senha_hash, email, meta_padrao, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nome, email, role, meta_padrao`,
      [nome, hash, email, metaPadrao || 15000, role || "vendedora"]
    );

    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === "23505") {
      return res.status(400).json({ erro: "Nome já cadastrado." });
    }
    console.error(e);
    res.status(500).json({ erro: "Erro ao cadastrar vendedora." });
  }
});

// Editar vendedora
app.put("/api/vendedoras/:id", autenticar, somenteGerente, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, metaPadrao, ativo } = req.body;

    await pool.query(
      `UPDATE vendedoras SET email=$1, meta_padrao=$2, ativo=$3 WHERE id=$4`,
      [email, metaPadrao, ativo, id]
    );

    res.json({ mensagem: "Vendedora atualizada." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "Erro ao atualizar vendedora." });
  }
});

// =====================================================
// 5. VENDAS (CRUD COMPLETO)
// =====================================================

// Listar vendas por período
app.get("/api/vendas", autenticar, async (req, res) => {
  try {
    const { dataInicio, dataFim } = req.query;

    let query = `
      SELECT * FROM vendas
      WHERE data_venda::date BETWEEN $1 AND $2
    `;

    let params = [dataInicio, dataFim];

    // Se não for gerente, filtra apenas dela
    if (req.role !== "gerente") {
      query += " AND vendedora_id = $3";
      params.push(req.vendedoraId);
    }

    query += " ORDER BY data_venda DESC";

    const r = await pool.query(query, params);

    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "Erro ao buscar vendas." });
  }
});

// Criar venda
app.post("/api/vendas", autenticar, async (req, res) => {
  try {
    const {
      valor,
      formaPagamento,
      clienteNome,
      observacao,
      pecas = 1,
    } = req.body;

    const r = await pool.query(
      `INSERT INTO vendas (vendedora_id, valor, forma_pagamento, cliente_nome, observacao, pecas)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        req.vendedoraId,
        valor,
        formaPagamento,
        clienteNome || null,
        observacao || null,
        pecas,
      ]
    );

    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "Erro ao lançar venda." });
  }
});

// Editar venda
app.put("/api/vendas/:id", autenticar, async (req, res) => {
  try {
    const { id } = req.params;
    const { valor, formaPagamento, clienteNome, observacao, pecas } = req.body;

    const r = await pool.query(
      `UPDATE vendas
       SET valor=$1, forma_pagamento=$2, cliente_nome=$3, observacao=$4, pecas=$5
       WHERE id=$6 AND vendedora_id=$7
       RETURNING *`,
      [
        valor,
        formaPagamento,
        clienteNome,
        observacao,
        pecas,
        id,
        req.vendedoraId,
      ]
    );

    if (r.rows.length === 0)
      return res.status(400).json({ erro: "Venda não encontrada." });

    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "Erro ao editar venda." });
  }
});

// Deletar venda
app.delete("/api/vendas/:id", autenticar, async (req, res) => {
  try {
    const { id } = req.params;

    const r = await pool.query(
      `DELETE FROM vendas
       WHERE id=$1 AND vendedora_id=$2`,
      [id, req.vendedoraId]
    );

    res.json({ mensagem: "Venda removida." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "Erro ao remover venda." });
  }
});

// =====================================================
// 6. CONDICIONAIS
// =====================================================

app.get("/api/condicionais", autenticar, async (req, res) => {
  try {
    let r;

    if (req.role === "gerente") {
      r = await pool.query("SELECT * FROM condicionais ORDER BY id DESC");
    } else {
      r = await pool.query(
        "SELECT * FROM condicionais WHERE vendedora_id=$1 ORDER BY id DESC",
        [req.vendedoraId]
      );
    }

    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "Erro ao buscar condicionais." });
  }
});

app.post("/api/condicionais", autenticar, async (req, res) => {
  try {
    const { quantidadePecas, valorTotal, clienteNome, observacao } = req.body;

    const r = await pool.query(
      `INSERT INTO condicionais (vendedora_id, quantidade_pecas, valor_total, cliente_nome, observacao)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        req.vendedoraId,
        quantidadePecas,
        valorTotal,
        clienteNome,
        observacao,
      ]
    );

    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "Erro ao lançar condicional." });
  }
});

app.delete("/api/condicionais/:id", autenticar, async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      `DELETE FROM condicionais WHERE id=$1 AND vendedora_id=$2`,
      [id, req.vendedoraId]
    );

    res.json({ mensagem: "Condicional removido." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "Erro ao remover condicional." });
  }
});
// =====================================================
// 7. METAS MENSAIS + META DINÂMICA DIÁRIA
// =====================================================

// Calcula dias úteis (seg–sáb)
function diasUteisRestantes() {
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth();
  const ultimoDia = new Date(ano, mes + 1, 0).getDate();

  let dias = 0;
  for (let d = hoje.getDate(); d <= ultimoDia; d++) {
    const data = new Date(ano, mes, d);
    const diaSemana = data.getDay(); // 0 dom – 6 sáb
    if (diaSemana !== 0) dias++; // exceto domingo
  }

  return dias;
}

// Meta diária ajustada
function calcularMetaDinamica(metaMensal, vendidoAteHoje) {
  const diasRestantes = diasUteisRestantes();
  if (diasRestantes <= 0) return metaMensal; // fallback

  const restante = metaMensal - vendidoAteHoje;

  return Math.max(restante / diasRestantes, 0);
}

// Buscar meta mensal
app.get("/api/meta-mensal", autenticar, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT meta_mensal FROM metas_gerais WHERE id=1"
    );

    const valor = r.rows.length ? Number(r.rows[0].meta_mensal) : 0;
    res.json({ metaMensal: valor });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "Erro ao buscar meta mensal." });
  }
});

// Salvar meta mensal (gerente)
app.post("/api/meta-mensal", autenticar, somenteGerente, async (req, res) => {
  try {
    const { metaMensal } = req.body;

    await pool.query(`
      INSERT INTO metas_gerais (id, meta_mensal)
      VALUES (1, $1)
      ON CONFLICT (id) DO UPDATE SET meta_mensal=$1
    `, [metaMensal]);

    res.json({ mensagem: "Meta mensal atualizada." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "Erro ao salvar meta mensal." });
  }
});

// Meta diária calculada automaticamente
app.get("/api/meta-hoje-dinamica", autenticar, async (req, res) => {
  try {
    const hoje = new Date().toISOString().slice(0, 10);

    const [metaMensalR, vendasHojeR, vendasAteHojeR] = await Promise.all([
      pool.query("SELECT meta_mensal FROM metas_gerais WHERE id=1"),
      pool.query(
        "SELECT SUM(valor) FROM vendas WHERE data_venda::date = $1 AND vendedora_id=$2",
        [hoje, req.vendedoraId]
      ),
      pool.query(
        "SELECT SUM(valor) FROM vendas WHERE data_venda::date <= $1 AND vendedora_id=$2",
        [hoje, req.vendedoraId]
      ),
    ]);

    const metaMensal = Number(metaMensalR.rows[0]?.meta_mensal || 0);
    const vendidoHoje = Number(vendasHojeR.rows[0]?.sum || 0);
    const vendidoAteHoje = Number(vendasAteHojeR.rows[0]?.sum || 0);

    const metaDinamica = calcularMetaDinamica(metaMensal, vendidoAteHoje);

    res.json({
      metaMensal,
      vendidoHoje,
      vendidoAteHoje,
      metaDinamica: Number(metaDinamica.toFixed(2)),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "Erro ao calcular meta diária." });
  }
});

// =====================================================
// 8. ROTA DE SAÚDE
// =====================================================
app.get("/", (_, res) => res.send("API OK √"));

// =====================================================
// 9. SUBIR SERVIDOR
// =====================================================
app.listen(PORT, () => {
  console.log("🚀 Servidor rodando na porta " + PORT);
});
