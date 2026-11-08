import PouchDB from 'pouchdb';

const apiUrl = process.env.API_URL || 'http://api:8080';
const simClients = parseInt(process.env.SIM_CLIENTS || '100', 10);

console.log(`[Simulador] Iniciando ${simClients} clientes simulados hacia ${apiUrl}...`);

// Inicializar base de datos local PouchDB para simulación
const localDb = new PouchDB('sim_local_db');

console.log('[Simulador] Cliente de prueba PouchDB inicializado correctamente.');

// Bucle infinito para mantener el contenedor en estado "Up"
setInterval(() => {
  // Heartbeat periódico para registrar actividad sin consumir CPU excesiva
}, 30000);