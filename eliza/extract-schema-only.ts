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
  
  // Get all tables
  const tablesRes = await db.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    ORDER BY table_name
  `);
  
  console.log('📋 DATABASE SCHEMA:\n');
  
  for (const row of tablesRes.rows) {
    const tableName = row.table_name;
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📁 ${tableName}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    // Get column info with more details
    const colsRes = await db.query(`
      SELECT 
        column_name, 
        data_type, 
        is_nullable,
        column_default,
        character_maximum_length,
        numeric_precision,
        numeric_scale
      FROM information_schema.columns
      WHERE table_name = '${tableName}'
      ORDER BY ordinal_position
    `);
    
    console.log('\nColumns:');
    for (const col of colsRes.rows) {
      const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
      let typeStr = col.data_type;
      
      if (col.character_maximum_length) {
        typeStr += `(${col.character_maximum_length})`;
      } else if (col.numeric_precision && col.numeric_scale) {
        typeStr += `(${col.numeric_precision},${col.numeric_scale})`;
      } else if (col.numeric_precision) {
        typeStr += `(${col.numeric_precision})`;
      }
      
      let colStr = `  • ${col.column_name} (${typeStr}) ${nullable}`;
      if (col.column_default) {
        colStr += ` DEFAULT ${col.column_default}`;
      }
      console.log(colStr);
    }
    
    // Get row count (try-catch to handle vector extension issues)
    try {
      const countRes = await db.query(`SELECT COUNT(*) FROM "${tableName}"`);
      const count = countRes.rows[0].count;
      console.log(`\nRow count: ${count}`);
    } catch (err) {
      console.log(`\nRow count: (error counting - likely vector extension issue)`);
    }
    
    console.log('');
  }
  
  await db.close();
  console.log('✅ Schema extraction complete!');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
