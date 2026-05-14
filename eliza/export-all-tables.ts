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
  
  // Get all tables
  const tablesRes = await db.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    ORDER BY table_name
  `);
  
  const tables = tablesRes.rows.map(row => row.table_name);
  console.log(`Found ${tables.length} tables\n`);
  
  const summary = {
    exported_at: new Date().toISOString(),
    database_url: DB_URL,
    tables: {} as Record<string, any>
  };
  
  for (const tableName of tables) {
    console.log(`📦 Exporting ${tableName}...`);
    
    try {
      const dataRes = await db.query(`SELECT * FROM "${tableName}"`);
      const jsonl = dataRes.rows.map(row => JSON.stringify(row)).join('\n');
      writeFileSync(`./${tableName.toLowerCase()}-export.jsonl`, jsonl);
      
      summary.tables[tableName] = {
        row_count: dataRes.rows.length,
        columns: dataRes.rows.length > 0 ? Object.keys(dataRes.rows[0] as Record<string, unknown>) : [],
        file: `${tableName.toLowerCase()}-export.jsonl`
      };
      
      console.log(`✅ ${tableName}: ${dataRes.rows.length} rows`);
    } catch (err) {
      console.log(`⚠️  ${tableName}: Skipped (error: ${(err as Error).message})`);
      summary.tables[tableName] = {
        error: (err as Error).message,
        skipped: true
      };
    }
  }
  
  await db.close();
  
  // Write summary
  writeFileSync('./export-summary.json', JSON.stringify(summary, null, 2));
  
  console.log('\n\n✅ All exports complete!');
  console.log(`📄 Summary written to export-summary.json`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
