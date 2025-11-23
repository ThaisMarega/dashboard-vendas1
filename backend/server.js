// ===================================
// CONFIG & TRATAMENTO DE ERROS GERAIS
// ===================================
require('dotenv').config();

process.on('unhandledRejection', err => {
  console.error('UNHANDLED REJECTION:', err);
});

process.on('uncaughtException', err => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

console.log('Iniciando server.js...');

// ===================================
// DEPENDÊNCIAS
// ===================================
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'troque-este-secret-em-producao';

// ===================================
// MIDDLEWARES BÁSICOS
// ===================================
app.use(
  cors({
    origin: process.env.FRONTEND_URL || '*',
  })
);
app.use(express.json());

// ROTA DE SAÚDE (teste rápido no navegador)
app.get('/', (_, res) => res.send('API OK'));

// ===================================
// CONEXÃO COM BANCO (Render usa DATABASE_URL)
// ===================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
});

// ===================================
// CRIAÇÃO DAS TABELAS AO SUBIR
// ===================================
const criarTabelas = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendedoras (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL UNIQUE,
        senha_hash VARCHAR(255) NOT NULL,
        email VARCHAR(100),
        meta_padrao NUMERIC(10,2) DEFAULT 15000,
        ativo BOOLEAN DEFAULT true,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
        valor_total NUMERIC(10,2) NOT NULL,
        cliente_nome VARCHAR(100) NOT NULL,
        observacao TEXT,
        data_registro TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS atendimentos (
        id SERIAL PRIMARY KEY,
        vendedora_id INTEGER REFERENCES vendedoras(id),
        quantidade INTEGER NOT NULL,
        data_registro DATE NOT NULL,
        UNIQUE (vendedora_id, data_registro)
      );

      CREATE TABLE IF NOT EXISTS metas (
        id SERIAL PRIMARY KEY,
        vendedora_id INTEGER REFERENCES vendedoras(id),
        valor_meta NUMERIC(10,2) NOT NULL,
        data_meta DATE NOT NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (vendedora_id, data_meta)
      );
    `);

    console.log('✅ Tabelas verificadas/criadas com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao criar tabelas:', error);
  }
};

// ===================================
// MIDDLEWARE DE AUTENTICAÇÃO (JWT)
// ===================================
const autenticar = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ erro: 'Token não fornecido' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    req.vendedoraId = decoded.id;
    next();
  } catch (error) {
    console.error('Erro no middleware de autenticação:', error);
    return res.status(401).json({ erro: 'Token inválido' });
  }
};

// ===================================
// ROTAS DE AUTENTICAÇÃO
// ===================================

// POST /api/login  { nome, senha }
app.post('/api/login', async (req, res) => {
  try {
    const { nome, senha } = req.body;

    if (!nome || !senha) {
      return res
        .status(400)
        .json({ erro: 'Informe nome e senha para fazer login.' });
    }

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
        metaPadrao: parseFloat(vendedora.meta_padrao),
      },
    });
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ erro: 'Erro no servidor ao fazer login.' });
  }
});

// (Opcional) Cadastrar vended
