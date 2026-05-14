#!/usr/bin/env bun

import { PGlite } from '@electric-sql/pglite';
import { writeFileSync } from 'fs';

const DB_URL = process.env.DATABASE_URL || 'pglite:///Users/home/eliza-db';

async function main() {
  console.log('🔌 Connecting to database...\n');
  console.log(`DATABASE_URL: ${DB_URL}\n`);
  
  const dataDir = DB_URL.replace('pglite://', '');
  const db = new PGlite(dataDir);
  await db.waitReady;
  
  console.log('✅ Connected!\n');
  
  // Export CACHE table
  console.log('📦 Exporting CACHE table...');
  const cacheRes = await db.query(`SELECT * FROM cache`);
  const cacheJsonl = cacheRes.rows.map(row => JSON.stringify(row)).join('\n');
  writeFileSync('./cache-export.jsonl', cacheJsonl);
  console.log(`✅ CACHE: ${cacheRes.rows.length} rows exported to cache-export.jsonl`);
  
  // Export COMPONENTS table
  console.log('\n📦 Exporting COMPONENTS table...');
  const componentsRes = await db.query(`SELECT * FROM components`);
  const componentsJsonl = componentsRes.rows.map(row => JSON.stringify(row)).join('\n');
  writeFileSync('./components-export.jsonl', componentsJsonl);
  console.log(`✅ COMPONENTS: ${componentsRes.rows.length} rows exported to components-export.jsonl`);
  
  // Export EMBEDDINGS table (skip vector columns to avoid extension error)
  console.log('\n📦 Exporting EMBEDDINGS table...');
  const embeddingsRes = await db.query(`
    SELECT id, memory_id, created_at 
    FROM embeddings
  `);
  const embeddingsJsonl = embeddingsRes.rows.map(row => JSON.stringify(row)).join('\n');
  writeFileSync('./embeddings-export.jsonl', embeddingsJsonl);
  console.log(`✅ EMBEDDINGS: ${embeddingsRes.rows.length} rows exported to embeddings-export.jsonl (vector columns excluded)`);
  
  await db.close();
  console.log('\n\n✅ All exports complete!');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
