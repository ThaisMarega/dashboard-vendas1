require('dotenv').config();              // carrega variáveis .env no local; no Render ignora sem problema
process.on('unhandledRejection', err => { console.error('UNHANDLED REJECTION:', err); });
process.on('uncaughtException',  err => { console.error('UNCAUGHT EXCEPTION:', err); });

console.log('Iniciando server.js...');
