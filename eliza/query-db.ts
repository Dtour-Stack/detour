#!/usr/bin/env bun

import { PGlite } from '@electric-sql/pglite';

const DB_URL = process.env.DATABASE_URL || 'pglite:///Users/home/eliza-db';

async function main() {
  console.log('🔌 Connecting to database...\n');
  console.log(`DATABASE_URL: ${DB_URL}\n`);
  
  const dataDir = DB_URL.replace('pglite://', '');
  const db = new PGlite(dataDir);
  await db.waitReady;
  
  console.log('✅ Connected!\n');
  
  // List all tables
  const tablesRes = await db.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    ORDER BY table_name
  `);
  
  console.log('📋 TABLES:\n');
  for (const row of tablesRes.rows) {
    const tableName = row.table_name;
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📁 ${tableName.toUpperCase()}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    // Get column info
    const colsRes = await db.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = '${tableName}'
      ORDER BY ordinal_position
    `);
    
    console.log('\n  Columns:');
    for (const col of colsRes.rows) {
      const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
      console.log(`    • ${col.column_name} (${col.data_type}) ${nullable}`);
    }
    
    // Get row count
    const countRes = await db.query(`SELECT COUNT(*) FROM "${tableName}"`);
    const count = countRes.rows[0].count;
    console.log(`\n  Row count: ${count}`);
    
    // Sample data (first 3 rows)
    if (count > 0) {
      const sampleRes = await db.query(`SELECT * FROM "${tableName}" LIMIT 3`);
      console.log(`\n  Sample data (up to 3 rows):`);
      for (let i = 0; i < sampleRes.rows.length; i++) {
        console.log(`\n    Row ${i + 1}:`);
        const row = sampleRes.rows[i];
        for (const [key, value] of Object.entries(row)) {
          const display = formatValue(value);
          console.log(`      ${key}: ${display}`);
        }
      }
    }
  }
  
  await db.close();
  console.log('\n\n✅ Done!');
}

function formatValue(val: unknown): string {
  if (val === null) return 'NULL';
  if (typeof val === 'object') return JSON.stringify(val).substring(0, 100);
  if (typeof val === 'string' && val.length > 100) return val.substring(0, 100) + '...';
  return String(val);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
