require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function run() {
  try {
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
    `);

    const vendedoras = [
      { nome: 'Allane', senha: 'allane2025', email: 'allane@imagemmodas.com.br', meta: 15000 },
      { nome: 'Ana',    senha: 'ana2025',    email: 'ana@imagemmodas.com.br',    meta: 15000 },
      { nome: 'Julia',  senha: 'julia2025',  email: 'julia@imagemmodas.com.br',  meta: 15000 }
    ];

    for (const v of vendedoras) {
      const hash = await bcrypt.hash(v.senha, 10);
      await pool.query(
        `INSERT INTO vendedoras (nome, senha_hash, email, meta_padrao, ativo)
         VALUES ($1,$2,$3,$4,true)
         ON CONFLICT (nome) DO NOTHING`,
        [v.nome, hash, v.email, v.meta]
      );
    }

    console.log('✅ Seed concluído.');
  } catch (e) {
    console.error('❌ Erro no seed:', e);
  } finally {
    await pool.end();
  }
}

run();
