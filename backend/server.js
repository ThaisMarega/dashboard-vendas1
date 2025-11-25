// ===============================================
// BACKEND - API Node.js + Express
// Arquivo: backend/server.js
// ===============================================

require('dotenv').config();

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
const JWT_SECRET = process.env.JWT_SECRET || 'mude-este-segredo-em-producao';

// -----------------------------------------------
// MIDDLEWARES BÁSICOS
// -----------------------------------------------
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// Health-check simples
app.get('/', (_, res) => res.send('API OK'));

// -----------------------------------------------
// CONFIG BANCO DE DADOS
// -----------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});
// -----------------------------------------------
// CRIAÇÃO / AJUSTE DE TABELAS
// -----------------------------------------------
async function criarTabelas() {
  try {
    await pool.query(`
      -- VENDEDORAS
      CREATE TABLE IF NOT EXISTS vendedoras (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL UNIQUE,
        senha_hash VARCHAR(255) NOT NULL,
        email VARCHAR(100),
        meta_padrao DECIMAL(10,2) DEFAULT 15000, -- meta diária padrão
        meta_mensal DECIMAL(10,2) DEFAULT 30000, -- meta mensal configurável
        is_gerente BOOLEAN DEFAULT false,        -- gerente ou não
        ativo BOOLEAN DEFAULT true,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- VENDAS
      CREATE TABLE IF NOT EXISTS vendas (
        id SERIAL PRIMARY KEY,
        vendedora_id INTEGER REFERENCES vendedoras(id),
        valor DECIMAL(10,2) NOT NULL,
        forma_pagamento VARCHAR(50) NOT NULL,
        quantidade_pecas INTEGER DEFAULT 1,
        cliente_nome VARCHAR(100),
        observacao TEXT,
        data_venda TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- CONDICIONAIS
      CREATE TABLE IF NOT EXISTS condicionais (
        id SERIAL PRIMARY KEY,
        vendedora_id INTEGER REFERENCES vendedoras(id),
        quantidade_pecas INTEGER NOT NULL,
        valor_total DECIMAL(10,2) NOT NULL,
        cliente_nome VARCHAR(100) NOT NULL,
        observacao TEXT,
        data_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- ATENDIMENTOS (1 por dia por vendedora)
      CREATE TABLE IF NOT EXISTS atendimentos (
        id SERIAL PRIMARY KEY,
        vendedora_id INTEGER REFERENCES vendedoras(id),
        quantidade INTEGER NOT NULL,
        data_registro DATE NOT NULL,
        UNIQUE(vendedora_id, data_registro)
      );

      -- METAS DIÁRIAS (override manual)
      CREATE TABLE IF NOT EXISTS metas (
        id SERIAL PRIMARY KEY,
        vendedora_id INTEGER REFERENCES vendedoras(id),
        valor_meta DECIMAL(10,2) NOT NULL,
        data_meta DATE NOT NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(vendedora_id, data_meta)
      );
    `);

    console.log('✅ Tabelas garantidas.');

    // garante que exista uma gerente padrão
    // usuário: gerente / senha: gerente2025
    const hashGerente = await bcrypt.hash('gerente2025', 10);

    await pool.query(
      `
      INSERT INTO vendedoras (nome, senha_hash, email, meta_padrao, meta_mensal, is_gerente, ativo)
      VALUES ($1,$2,$3,$4,$5,true,true)
      ON CONFLICT (nome) DO NOTHING;
    `,
      ['gerente', hashGerente, 'gerente@imagemmodas.com', 15000, 90000]
    );

    console.log('✅ Gerente padrão garantida (usuario: gerente)');
  } catch (err) {
    console.error('❌ Erro ao criar tabelas:', err);
  }
}
// -----------------------------------------------
// FUNÇÕES AUXILIARES DE DATA / META MENSAL
// -----------------------------------------------

// conta dias úteis (segunda a sábado) entre duas datas (inclusive)
function contarDiasUteis(startDate, endDate) {
  let count = 0;
  let d = new Date(startDate);
  const end = new Date(endDate);
  while (d <= end) {
    const dia = d.getDay(); // 0 = dom, 1..6 = seg..sab
    if (dia !== 0) count++; // trabalha de seg a sábado
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// calcula meta do dia considerando meta mensal, vendas do mês etc.
async function calcularMetaDia(vendedoraId, dataISO) {
  // dataISO: "YYYY-MM-DD"
  const data = new Date(dataISO + 'T00:00:00');
  const ano = data.getFullYear();
  const mes = data.getMonth(); // 0-11

  const inicioMes = new Date(ano, mes, 1);
  const fimMes = new Date(ano, mes + 1, 0); // último dia do mês

  // dados da vendedora
  const rVend = await pool.query(
    'SELECT meta_mensal, meta_padrao FROM vendedoras WHERE id = $1',
    [vendedoraId]
  );
  if (rVend.rows.length === 0) {
    return { metaDia: 0, metaMensal: 0, vendidoNoMes: 0, faltaNoMes: 0 };
  }

  const metaMensal = Number(rVend.rows[0].meta_mensal || 0);
  const metaPadrao = Number(rVend.rows[0].meta_padrao || 0);

  // se não tiver meta mensal configurada, usa meta diária padrão fixa
  if (!metaMensal) {
    return {
      metaDia: metaPadrao,
      metaMensal: 0,
      vendidoNoMes: 0,
      faltaNoMes: 0,
    };
  }

  // vendas acumuladas no mês ATÉ a data informada (inclusive)
  const rVendas = await pool.query(
    `
      SELECT COALESCE(SUM(valor),0) AS total
      FROM vendas
      WHERE vendedora_id = $1
        AND data_venda >= $2
        AND data_venda < ($3::date + INTERVAL '1 day');
    `,
    [vendedoraId, inicioMes, dataISO]
  );
  const vendidoNoMes = Number(rVendas.rows[0].total || 0);

  let faltaNoMes = metaMensal - vendidoNoMes;
  if (faltaNoMes < 0) faltaNoMes = 0;

  // quantos dias úteis (seg a sáb) ainda restam no mês a partir da data
  const diasUteisRestantes = contarDiasUteis(
    dataISO,
    fimMes.toISOString().slice(0, 10)
  );

  let metaDia = 0;
  if (diasUteisRestantes > 0) {
    metaDia = faltaNoMes / diasUteisRestantes;
  }

  if (faltaNoMes === 0) {
    metaDia = 0;
  }

  return { metaDia, metaMensal, vendidoNoMes, faltaNoMes };
}

// -----------------------------------------------
// MIDDLEWARE DE AUTENTICAÇÃO
// -----------------------------------------------
async function autenticar(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(401).json({ erro: 'Token não enviado' });
    }

    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const r = await pool.query(
      'SELECT id, nome, is_gerente FROM vendedoras WHERE id = $1 AND ativo = true',
      [decoded.id]
    );

    if (r.rows.length === 0) {
      return res.status(401).json({ erro: 'Usuário não encontrado' });
    }

    req.vendedoraId = r.rows[0].id;
    req.vendedoraNome = r.rows[0].nome;
    req.isGerente = r.rows[0].is_gerente;

    next();
  } catch (err) {
    console.error('Erro no middleware de autenticação:', err);
    return res.status(401).json({ erro: 'Token inválido' });
  }
}

function exigirGerente(req, res, next) {
  if (!req.isGerente) {
    return res.status(403).json({ erro: 'Apenas gerente pode acessar aqui.' });
  }
  next();
}

// -----------------------------------------------
// ROTAS DE AUTENTICAÇÃO
// -----------------------------------------------

// Login (vendedora ou gerente)
app.post('/api/login', async (req, res) => {
  try {
    const { nome, senha } = req.body;

    const result = await pool.query(
      'SELECT * FROM vendedoras WHERE nome = $1 AND ativo = true',
      [nome]
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
        metaPadrao: parseFloat(vendedora.meta_padrao || 0),
        metaMensal: parseFloat(vendedora.meta_mensal || 0),
        isGerente: vendedora.is_gerente,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro no servidor de login' });
  }
});
// -----------------------------------------------
// ROTAS DE VENDEDORA (AUTENTICADAS)
// -----------------------------------------------

// ------------------------- VENDAS -------------------------

// Listar vendas da vendedora (com filtro por data)
app.get('/api/vendas', autenticar, async (req, res) => {
  try {
    const { dataInicio, dataFim } = req.query;
    let query = 'SELECT * FROM vendas WHERE vendedora_id = $1';
    const params = [req.vendedoraId];

    if (dataInicio && dataFim) {
      query += ' AND data_venda >= $2 AND data_venda < ($3::date + INTERVAL \'1 day\')';
      params.push(dataInicio, dataFim);
    }

    query += ' ORDER BY data_venda DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar vendas:', err);
    res.status(500).json({ erro: 'Erro ao buscar vendas' });
  }
});

// Criar venda
app.post('/api/vendas', autenticar, async (req, res) => {
  try {
    const {
      valor,
      formaPagamento,
      clienteNome,
      observacao,
      quantidadePecas,
    } = req.body;

    if (!valor || !formaPagamento) {
      return res.status(400).json({
        erro: 'Valor e forma de pagamento são obrigatórios.',
      });
    }

    const result = await pool.query(
      `
        INSERT INTO vendas
          (vendedora_id, valor, forma_pagamento, quantidade_pecas, cliente_nome, observacao)
        VALUES
          ($1,$2,$3,$4,$5,$6)
        RETURNING *;
      `,
      [
        req.vendedoraId,
        valor,
        formaPagamento,
        quantidadePecas || 1,
        clienteNome || null,
        observacao || null,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao adicionar venda:', err);
    res.status(500).json({ erro: 'Erro ao adicionar venda' });
  }
});

// Editar venda (valor / quantidade de peças)
app.put('/api/vendas/:id', autenticar, async (req, res) => {
  try {
    const { id } = req.params;
    const { valor, quantidadePecas } = req.body;

    const result = await pool.query(
      `
        UPDATE vendas
        SET valor = COALESCE($1, valor),
            quantidade_pecas = COALESCE($2, quantidade_pecas)
        WHERE id = $3 AND vendedora_id = $4
        RETURNING *;
      `,
      [valor, quantidadePecas, id, req.vendedoraId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Venda não encontrada' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao editar venda:', err);
    res.status(500).json({ erro: 'Erro ao editar venda' });
  }
});

// Excluir venda
app.delete('/api/vendas/:id', autenticar, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      'DELETE FROM vendas WHERE id = $1 AND vendedora_id = $2',
      [id, req.vendedoraId]
    );
    res.json({ mensagem: 'Venda deletada com sucesso' });
  } catch (err) {
    console.error('Erro ao deletar venda:', err);
    res.status(500).json({ erro: 'Erro ao deletar venda' });
  }
});

// ------------------------- CONDICIONAIS -------------------------

// Listar condicionais da vendedora
app.get('/api/condicionais', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT * FROM condicionais
        WHERE vendedora_id = $1
        ORDER BY data_registro DESC;
      `,
      [req.vendedoraId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar condicionais:', err);
    res.status(500).json({ erro: 'Erro ao buscar condicionais' });
  }
});

// Criar condicional
app.post('/api/condicionais', autenticar, async (req, res) => {
  try {
    const { quantidadePecas, valorTotal, clienteNome, observacao } = req.body;

    if (!quantidadePecas || !clienteNome) {
      return res.status(400).json({
        erro: 'Quantidade de peças e nome da cliente são obrigatórios.',
      });
    }

    const result = await pool.query(
      `
        INSERT INTO condicionais
          (vendedora_id, quantidade_pecas, valor_total, cliente_nome, observacao)
        VALUES
          ($1,$2,$3,$4,$5)
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

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao adicionar condicional:', err);
    res.status(500).json({ erro: 'Erro ao adicionar condicional' });
  }
});

// Editar condicional
app.put('/api/condicionais/:id', autenticar, async (req, res) => {
  try {
    const { id } = req.params;
    const { quantidadePecas, valorTotal } = req.body;

    const result = await pool.query(
      `
        UPDATE condicionais
        SET quantidade_pecas = COALESCE($1, quantidade_pecas),
            valor_total = COALESCE($2, valor_total)
        WHERE id = $3 AND vendedora_id = $4
        RETURNING *;
      `,
      [quantidadePecas, valorTotal, id, req.vendedoraId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Condicional não encontrado' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao editar condicional:', err);
    res.status(500).json({ erro: 'Erro ao editar condicional' });
  }
});

// Excluir condicional
app.delete('/api/condicionais/:id', autenticar, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      'DELETE FROM condicionais WHERE id = $1 AND vendedora_id = $2',
      [id, req.vendedoraId]
    );
    res.json({ mensagem: 'Condicional deletado com sucesso' });
  } catch (err) {
    console.error('Erro ao deletar condicional:', err);
    res.status(500).json({ erro: 'Erro ao deletar condicional' });
  }
});

// ------------------------- ATENDIMENTOS -------------------------

// Salvar / atualizar atendimentos do dia
app.post('/api/atendimentos', autenticar, async (req, res) => {
  try {
    const { quantidade, data } = req.body;

    const result = await pool.query(
      `
        INSERT INTO atendimentos (vendedora_id, quantidade, data_registro)
        VALUES ($1,$2,$3)
        ON CONFLICT (vendedora_id, data_registro)
        DO UPDATE SET quantidade = EXCLUDED.quantidade
        RETURNING *;
      `,
      [req.vendedoraId, quantidade, data]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao salvar atendimentos:', err);
    res.status(500).json({ erro: 'Erro ao salvar atendimentos' });
  }
});

// Buscar atendimentos de um dia
app.get('/api/atendimentos/:data', autenticar, async (req, res) => {
  try {
    const { data } = req.params;
    const result = await pool.query(
      `
        SELECT * FROM atendimentos
        WHERE vendedora_id = $1 AND data_registro = $2;
      `,
      [req.vendedoraId, data]
    );

    res.json(result.rows[0] || { quantidade: 0 });
  } catch (err) {
    console.error('Erro ao buscar atendimentos:', err);
    res.status(500).json({ erro: 'Erro ao buscar atendimentos' });
  }
});

// ------------------------- METAS DIÁRIAS / MENSAL -------------------------

// Retorna meta do dia + meta mensal + vendido no mês + falta
app.get('/api/metas/:data', autenticar, async (req, res) => {
  try {
    const { data } = req.params;

    // meta calculada dinamicamente
    const calc = await calcularMetaDia(req.vendedoraId, data);

    // verifica se há override manual para este dia
    const rMeta = await pool.query(
      `
        SELECT valor_meta
        FROM metas
        WHERE vendedora_id = $1 AND data_meta = $2;
      `,
      [req.vendedoraId, data]
    );

    let valorMetaDia = calc.metaDia;
    if (rMeta.rows.length > 0) {
      valorMetaDia = Number(rMeta.rows[0].valor_meta || 0);
    }

    res.json({
      valor_meta: valorMetaDia,
      meta_mensal: calc.metaMensal,
      vendido_no_mes: calc.vendidoNoMes,
      falta_no_mes: calc.faltaNoMes,
    });
  } catch (err) {
    console.error('Erro ao buscar meta:', err);
    res.status(500).json({ erro: 'Erro ao buscar meta' });
  }
});

// Salvar/ajustar meta manual de um dia (override)
app.post('/api/metas', autenticar, async (req, res) => {
  try {
    const { valorMeta, data } = req.body;

    const result = await pool.query(
      `
        INSERT INTO metas (vendedora_id, valor_meta, data_meta)
        VALUES ($1,$2,$3)
        ON CONFLICT (vendedora_id, data_meta)
        DO UPDATE SET valor_meta = EXCLUDED.valor_meta
        RETURNING *;
      `,
      [req.vendedoraId, valorMeta, data]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao salvar meta:', err);
    res.status(500).json({ erro: 'Erro ao salvar meta' });
  }
});

// -----------------------------------------------
// ROTAS DA GERENTE (ADMIN)
// -----------------------------------------------

// Cadastrar nova vendedora
app.post('/api/admin/vendedoras', autenticar, exigirGerente, async (req, res) => {
  try {
    const {
      nome,
      email,
      senha,
      metaPadrao,
      metaMensal,
      isGerente,
    } = req.body;

    const hash = await bcrypt.hash(senha, 10);

    const result = await pool.query(
      `
        INSERT INTO vendedoras
          (nome, senha_hash, email, meta_padrao, meta_mensal, is_gerente, ativo)
        VALUES
          ($1,$2,$3,$4,$5,$6,true)
        RETURNING id, nome, email, meta_padrao, meta_mensal, is_gerente;
      `,
      [
        nome,
        hash,
        email || null,
        metaPadrao || 15000,
        metaMensal || 30000,
        !!isGerente,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao cadastrar vendedora:', err);
    if (err.code === '23505') {
      return res
        .status(400)
        .json({ erro: 'Já existe vendedora com esse nome.' });
    }
    res.status(500).json({ erro: 'Erro ao cadastrar vendedora' });
  }
});

// Atualizar meta mensal de uma vendedora (para gerente ajustar quando quiser)
app.put('/api/admin/vendedoras/:id/meta-mensal', autenticar, exigirGerente, async (req, res) => {
  try {
    const { id } = req.params;
    const { metaMensal } = req.body;

    const result = await pool.query(
      `
        UPDATE vendedoras
        SET meta_mensal = $1
        WHERE id = $2
        RETURNING id, nome, email, meta_padrao, meta_mensal, is_gerente;
      `,
      [metaMensal, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Vendedora não encontrada' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao atualizar meta mensal:', err);
    res.status(500).json({ erro: 'Erro ao atualizar meta mensal' });
  }
});

// Resumo geral do dia (para gerente)
app.get('/api/admin/resumo', autenticar, exigirGerente, async (req, res) => {
  try {
    const hojeISO = new Date().toISOString().slice(0, 10);

    const rVendas = await pool.query(
      `
        SELECT COUNT(*) AS qtd, COALESCE(SUM(valor),0) AS total
        FROM vendas
        WHERE data_venda >= $1
          AND data_venda < ($1::date + INTERVAL '1 day');
      `,
      [hojeISO]
    );

    const rAtend = await pool.query(
      `
        SELECT COALESCE(SUM(quantidade),0) AS total
        FROM atendimentos
        WHERE data_registro = $1;
      `,
      [hojeISO]
    );

    res.json({
      vendasHoje: Number(rVendas.rows[0].qtd || 0),
      totalHoje: Number(rVendas.rows[0].total || 0),
      atendimentosHoje: Number(rAtend.rows[0].total || 0),
    });
  } catch (err) {
    console.error('Erro ao buscar resumo admin:', err);
    res.status(500).json({ erro: 'Erro ao buscar resumo' });
  }
});

// Todas as vendas (para tabela da gerente)
app.get('/api/admin/vendas', autenticar, exigirGerente, async (req, res) => {
  try {
    const r = await pool.query(
      `
        SELECT v.id,
               v.data_venda,
               v.valor,
               v.forma_pagamento,
               v.cliente_nome,
               v.quantidade_pecas,
               vd.nome AS vendedora
        FROM vendas v
        JOIN vendedoras vd ON vd.id = v.vendedora_id
        ORDER BY v.data_venda DESC
        LIMIT 1000;
      `
    );
    res.json(r.rows);
  } catch (err) {
    console.error('Erro ao buscar vendas (admin):', err);
    res.status(500).json({ erro: 'Erro ao buscar vendas (admin)' });
  }
});

// Atendimentos (admin)
app.get('/api/admin/atendimentos', autenticar, exigirGerente, async (req, res) => {
  try {
    const r = await pool.query(
      `
        SELECT a.data_registro,
               a.quantidade,
               v.nome AS vendedora
        FROM atendimentos a
        JOIN vendedoras v ON v.id = a.vendedora_id
        ORDER BY a.data_registro DESC;
      `
    );
    res.json(r.rows);
  } catch (err) {
    console.error('Erro ao buscar atendimentos (admin):', err);
    res.status(500).json({ erro: 'Erro ao buscar atendimentos (admin)' });
  }
});

// Metas diárias cadastradas manualmente (admin)
app.get('/api/admin/metas', autenticar, exigirGerente, async (req, res) => {
  try {
    const r = await pool.query(
      `
        SELECT m.data_meta,
               m.valor_meta,
               v.nome AS vendedora
        FROM metas m
        JOIN vendedoras v ON v.id = m.vendedora_id
        ORDER BY m.data_meta DESC;
      `
    );
    res.json(r.rows);
  } catch (err) {
    console.error('Erro ao buscar metas (admin):', err);
    res.status(500).json({ erro: 'Erro ao buscar metas (admin)' });
  }
});

// -----------------------------------------------
// INÍCIO DO SERVIDOR
// -----------------------------------------------
app.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  await criarTabelas();
});

module.exports = app;
