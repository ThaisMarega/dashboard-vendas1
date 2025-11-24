// ===================================
// BACKEND - API Node.js + Express
// ===================================
// Arquivo: backend/server.js

require('dotenv').config(); // carrega variáveis .env em local

process.on('unhandledRejection', err => {
  console.error('UNHANDLED REJECTION:', err);
});

process.on('uncaughtException', err => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

console.log('Iniciando server.js...');

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET =
  process.env.JWT_SECRET || 'seu-secret-key-aqui-mude-em-producao';

// Middlewares
app.use(
  cors({
    origin: process.env.FRONTEND_URL || '*',
  }),
);
app.use(express.json());

// Rota de saúde (teste rápido)
app.get('/', (_req, res) => {
  res.send('API OK');
});

// ===================================
// CONFIGURAÇÃO DO BANCO DE DADOS
// ===================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
});

// ===================================
// CRIAÇÃO/ATUALIZAÇÃO DAS TABELAS
// ===================================
const criarTabelas = async () => {
  try {
    // Cria tabelas se não existirem
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
        cliente_nome VARCHAR(100),
        observacao TEXT,
        data_venda TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS condicionais (
        id SERIAL PRIMARY KEY,
        vendedora_id INTEGER REFERENCES vendedoras(id),
        quantidade_pecas INTEGER NOT NULL,
        valor_total DECIMAL(10,2) NOT NULL,
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

      CREATE TABLE IF NOT EXISTS metas (
        id SERIAL PRIMARY KEY,
        vendedora_id INTEGER REFERENCES vendedoras(id),
        valor_meta DECIMAL(10,2) NOT NULL,
        data_meta DATE NOT NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(vendedora_id, data_meta)
      );
    `);

    // 🔧 Garante coluna quantidade_pecas em vendas
    await pool.query(`
      ALTER TABLE vendas
      ADD COLUMN IF NOT EXISTS quantidade_pecas INTEGER DEFAULT 0;
    `);

    // 🔧 Garante coluna is_gerente em vendedoras
    await pool.query(`
      ALTER TABLE vendedoras
      ADD COLUMN IF NOT EXISTS is_gerente BOOLEAN DEFAULT false;
    `);

    // 👩‍💼 Cria usuária gerente padrão, se ainda não existir
    const senhaGerenteHash = await bcrypt.hash('gerente2025', 10);
    await pool.query(
      `
      INSERT INTO vendedoras (nome, senha_hash, email, meta_padrao, ativo, is_gerente)
      VALUES ('gerente', $1, 'gerente@imagemmodas.com.br', 15000, true, true)
      ON CONFLICT (nome) DO NOTHING;
    `,
      [senhaGerenteHash],
    );

    console.log('✅ Tabelas criadas/atualizadas com sucesso e gerente configurada!');
  } catch (error) {
    console.error('❌ Erro ao criar/atualizar tabelas:', error);
  }
};

// ===================================
// MIDDLEWARE DE AUTENTICAÇÃO
// ===================================
const autenticar = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ erro: 'Token não fornecido' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    req.vendedoraId = decoded.id;
    next();
  } catch (error) {
    console.error('Erro na autenticação:', error.message);
    return res.status(401).json({ erro: 'Token inválido' });
  }
};

const autenticarGerente = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ erro: 'Token não fornecido' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query(
      'SELECT is_gerente FROM vendedoras WHERE id = $1',
      [decoded.id],
    );

    if (result.rows.length === 0 || !result.rows[0].is_gerente) {
      return res.status(403).json({ erro: 'Acesso restrito à gerente' });
    }

    req.vendedoraId = decoded.id;
    req.eGerente = true;
    next();
  } catch (error) {
    console.error('Erro na autenticação de gerente:', error.message);
    return res.status(401).json({ erro: 'Token inválido' });
  }
};

// ===================================
// ROTAS DE AUTENTICAÇÃO
// ===================================

// Login (vendedora ou gerente)
app.post('/api/login', async (req, res) => {
  try {
    const { nome, senha } = req.body;

    const result = await pool.query(
      'SELECT * FROM vendedoras WHERE nome = $1 AND ativo = true',
      [nome],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ erro: 'Credenciais inválidas' });
    }

    const vendedora = result.rows[0];
    const senhaValida = await bcrypt.compare(senha, vendedora.senha_hash);

    if (!senhaValida) {
      return res.status(401).json({ erro: 'Credenciais inválidas' });
    }

    const token = jwt.sign({ id: vendedora.id }, JWT_SECRET, {
      expiresIn: '24h',
    });

    res.json({
      token,
      vendedora: {
        id: vendedora.id,
        nome: vendedora.nome,
        email: vendedora.email,
        metaPadrao: parseFloat(vendedora.meta_padrao),
        isGerente: !!vendedora.is_gerente,
      },
    });
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ erro: 'Erro no servidor' });
  }
});

// Cadastrar vendedora (rota antiga simples – ainda pode ser usada se quiser)
app.post('/api/vendedoras', async (req, res) => {
  try {
    const { nome, senha, email, metaPadrao } = req.body;

    const senhaHash = await bcrypt.hash(senha, 10);

    const result = await pool.query(
      'INSERT INTO vendedoras (nome, senha_hash, email, meta_padrao, ativo, is_gerente) VALUES ($1, $2, $3, $4, true, false) RETURNING id, nome, email, meta_padrao',
      [nome, senhaHash, email, metaPadrao || 15000],
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ erro: 'Vendedora já cadastrada' });
    }
    console.error('Erro ao cadastrar vendedora:', error);
    res.status(500).json({ erro: 'Erro no servidor' });
  }
});

// ===================================
// ROTAS DE VENDAS (Vendedora)
// ===================================

// Listar vendas (por período, da vendedora logada)
app.get('/api/vendas', autenticar, async (req, res) => {
  try {
    const { dataInicio, dataFim } = req.query;

    let query = 'SELECT * FROM vendas WHERE vendedora_id = $1';
    const params = [req.vendedoraId];

    if (dataInicio && dataFim) {
      query += ' AND data_venda::date BETWEEN $2 AND $3';
      params.push(dataInicio, dataFim);
    }

    query += ' ORDER BY data_venda DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar vendas:', error);
    res.status(500).json({ erro: 'Erro ao buscar vendas' });
  }
});

// Adicionar venda
app.post('/api/vendas', autenticar, async (req, res) => {
  try {
    const {
      valor,
      formaPagamento,
      clienteNome,
      observacao,
      quantidadePecas,
    } = req.body;

    const valorNumero = Number(valor || 0);
    if (!valorNumero || !formaPagamento) {
      return res.status(400).json({
        erro: 'Valor e forma de pagamento são obrigatórios',
      });
    }

    const qtdPecasNumero = Number(quantidadePecas || 0);

    const result = await pool.query(
      `INSERT INTO vendas (
        vendedora_id,
        valor,
        forma_pagamento,
        cliente_nome,
        observacao,
        quantidade_pecas
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        req.vendedoraId,
        valorNumero,
        formaPagamento,
        clienteNome || null,
        observacao || null,
        qtdPecasNumero,
      ],
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao adicionar venda:', error);
    res.status(500).json({ erro: 'Erro ao adicionar venda' });
  }
});

// Deletar venda
app.delete('/api/vendas/:id', autenticar, async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      'DELETE FROM vendas WHERE id = $1 AND vendedora_id = $2',
      [id, req.vendedoraId],
    );

    res.json({ mensagem: 'Venda deletada com sucesso' });
  } catch (error) {
    console.error('Erro ao deletar venda:', error);
    res.status(500).json({ erro: 'Erro ao deletar venda' });
  }
});

// ===================================
// ROTAS DE CONDICIONAIS
// ===================================

// Listar condicionais
app.get('/api/condicionais', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM condicionais WHERE vendedora_id = $1 ORDER BY data_registro DESC',
      [req.vendedoraId],
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar condicionais:', error);
    res.status(500).json({ erro: 'Erro ao buscar condicionais' });
  }
});

// Adicionar condicional
app.post('/api/condicionais', autenticar, async (req, res) => {
  try {
    const { quantidadePecas, valorTotal, clienteNome, observacao } = req.body;

    const qtd = Number(quantidadePecas || 0);
    const valor = Number(valorTotal || 0);

    if (!qtd || !clienteNome) {
      return res.status(400).json({
        erro: 'Quantidade de peças e nome da cliente são obrigatórios',
      });
    }

    const result = await pool.query(
      `INSERT INTO condicionais (
        vendedora_id,
        quantidade_pecas,
        valor_total,
        cliente_nome,
        observacao
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *`,
      [req.vendedoraId, qtd, valor, clienteNome, observacao || null],
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao adicionar condicional:', error);
    res.status(500).json({ erro: 'Erro ao adicionar condicional' });
  }
});

// Deletar condicional
app.delete('/api/condicionais/:id', autenticar, async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      'DELETE FROM condicionais WHERE id = $1 AND vendedora_id = $2',
      [id, req.vendedoraId],
    );

    res.json({ mensagem: 'Condicional deletado com sucesso' });
  } catch (error) {
    console.error('Erro ao deletar condicional:', error);
    res.status(500).json({ erro: 'Erro ao deletar condicional' });
  }
});

// ===================================
// ROTAS DE ATENDIMENTOS
// ===================================

// Salvar atendimentos do dia
app.post('/api/atendimentos', autenticar, async (req, res) => {
  try {
    const { quantidade, data } = req.body;

    const qtd = Number(quantidade || 0);
    if (!data) {
      return res.status(400).json({ erro: 'Data é obrigatória' });
    }

    const result = await pool.query(
      `INSERT INTO atendimentos (vendedora_id, quantidade, data_registro)
       VALUES ($1, $2, $3)
       ON CONFLICT (vendedora_id, data_registro)
       DO UPDATE SET quantidade = $2
       RETURNING *`,
      [req.vendedoraId, qtd, data],
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao salvar atendimentos:', error);
    res.status(500).json({ erro: 'Erro ao salvar atendimentos' });
  }
});

// Buscar atendimentos do dia
app.get('/api/atendimentos/:data', autenticar, async (req, res) => {
  try {
    const { data } = req.params;

    const result = await pool.query(
      'SELECT * FROM atendimentos WHERE vendedora_id = $1 AND data_registro = $2',
      [req.vendedoraId, data],
    );

    res.json(result.rows[0] || { quantidade: 0 });
  } catch (error) {
    console.error('Erro ao buscar atendimentos:', error);
    res.status(500).json({ erro: 'Erro ao buscar atendimentos' });
  }
});

// ===================================
// ROTAS DE METAS
// ===================================

// Salvar meta do dia
app.post('/api/metas', autenticar, async (req, res) => {
  try {
    const { valorMeta, data } = req.body;

    const valor = Number(valorMeta || 0);
    if (!data) {
      return res.status(400).json({ erro: 'Data é obrigatória' });
    }

    const result = await pool.query(
      `INSERT INTO metas (vendedora_id, valor_meta, data_meta)
       VALUES ($1, $2, $3)
       ON CONFLICT (vendedora_id, data_meta)
       DO UPDATE SET valor_meta = $2
       RETURNING *`,
      [req.vendedoraId, valor, data],
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao salvar meta:', error);
    res.status(500).json({ erro: 'Erro ao salvar meta' });
  }
});

// Buscar meta do dia
app.get('/api/metas/:data', autenticar, async (req, res) => {
  try {
    const { data } = req.params;

    const result = await pool.query(
      'SELECT * FROM metas WHERE vendedora_id = $1 AND data_meta = $2',
      [req.vendedoraId, data],
    );

    if (result.rows.length === 0) {
      const vendedora = await pool.query(
        'SELECT meta_padrao FROM vendedoras WHERE id = $1',
        [req.vendedoraId],
      );
      return res.json({
        valor_meta: vendedora.rows[0]?.meta_padrao ?? 15000,
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao buscar meta:', error);
    res.status(500).json({ erro: 'Erro ao buscar meta' });
  }
});

// ===================================
// ROTAS ADMIN (GERENTE)
// ===================================

// Cadastrar nova vendedora (pela gerente)
app.post('/api/admin/vendedoras', autenticarGerente, async (req, res) => {
  try {
    const { nome, email, senha, metaPadrao } = req.body;

    const senhaHash = await bcrypt.hash(senha, 10);

    const result = await pool.query(
      `INSERT INTO vendedoras (nome, senha_hash, email, meta_padrao, ativo, is_gerente)
       VALUES ($1, $2, $3, $4, true, false)
       RETURNING id, nome, email, meta_padrao`,
      [nome, senhaHash, email || null, metaPadrao || 15000],
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ erro: 'Vendedora já cadastrada' });
    }
    console.error('Erro admin ao cadastrar vendedora:', error);
    res.status(500).json({ erro: 'Erro no servidor' });
  }
});

// Resumo geral do dia
app.get('/api/admin/resumo', autenticarGerente, async (_req, res) => {
  try {
    const vendasHoje = await pool.query(
      `
      SELECT
        COUNT(*)::int AS vendas_hoje,
        COALESCE(SUM(valor),0)::numeric AS total_hoje
      FROM vendas
      WHERE data_venda::date = CURRENT_DATE;
    `,
    );

    const atendHoje = await pool.query(
      `
      SELECT
        COALESCE(SUM(quantidade),0)::int AS atendimentos_hoje
      FROM atendimentos
      WHERE data_registro = CURRENT_DATE;
    `,
    );

    res.json({
      vendasHoje: vendasHoje.rows[0].vendas_hoje,
      totalHoje: parseFloat(vendasHoje.rows[0].total_hoje),
      atendimentosHoje: atendHoje.rows[0].atendimentos_hoje,
    });
  } catch (error) {
    console.error('Erro admin/resumo:', error);
    res.status(500).json({ erro: 'Erro ao buscar resumo' });
  }
});

// Todas as vendas (últimas 200)
app.get('/api/admin/vendas', autenticarGerente, async (_req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        v.id,
        v.data_venda,
        v.valor,
        v.forma_pagamento,
        v.cliente_nome,
        v.quantidade_pecas,
        vd.nome AS vendedora
      FROM vendas v
      JOIN vendedoras vd ON vd.id = v.vendedora_id
      ORDER BY v.data_venda DESC
      LIMIT 200;
    `,
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Erro admin/vendas:', error);
    res.status(500).json({ erro: 'Erro ao buscar vendas' });
  }
});

// Todos os atendimentos
app.get('/api/admin/atendimentos', autenticarGerente, async (_req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        a.id,
        a.data_registro,
        a.quantidade,
        vd.nome AS vendedora
      FROM atendimentos a
      JOIN vendedoras vd ON vd.id = a.vendedora_id
      ORDER BY a.data_registro DESC, vd.nome;
    `,
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Erro admin/atendimentos:', error);
    res.status(500).json({ erro: 'Erro ao buscar atendimentos' });
  }
});

// Todas as metas
app.get('/api/admin/metas', autenticarGerente, async (_req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        m.id,
        m.data_meta,
        m.valor_meta,
        vd.nome AS vendedora
      FROM metas m
      JOIN vendedoras vd ON vd.id = m.vendedora_id
      ORDER BY m.data_meta DESC, vd.nome;
    `,
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Erro admin/metas:', error);
    res.status(500).json({ erro: 'Erro ao buscar metas' });
  }
});

// ===================================
// INICIALIZAÇÃO DO SERVIDOR
// ===================================
app.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  await criarTabelas();
});

// Exportar para testes (se precisar)
module.exports = app;
