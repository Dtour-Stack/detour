#!/usr/bin/env bun

import { PGlite } from '@electric-sql/pglite';
import { writeFileSync, mkdirSync, existsSync } from 'fs';

const DB_URL = process.env.DATABASE_URL || 'pglite:///Users/home/eliza-db';

// Knowledge tables - for agent knowledge base
const KNOWLEDGE_TABLES = [
  'memories',
  'entities',
  'entity_identities',
  'relationships',
  'fact_candidates',
  'session_summaries',
  'trajectories',
  'tasks',
  'components',
  'long_term_memories'
];

// Tables to skip (too large or not useful)
const SKIP_TABLES = [
  'logs', // 45,611 rows - too large
  'trajectory_step_index' // 58,490 rows - too large
];

async function main() {
  console.log('🔌 Connecting to database...\n');
  
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
  
  const allTables = tablesRes.rows.map(row => row.table_name);
  console.log(`Found ${allTables.length} tables\n`);
  
  // Create output directories
  const knowledgeDir = './knowledge-exports';
  const jsonlDir = './jsonl-exports';
  
  if (!existsSync(knowledgeDir)) mkdirSync(knowledgeDir);
  if (!existsSync(jsonlDir)) mkdirSync(jsonlDir);
  
  const summary = {
    exported_at: new Date().toISOString(),
    database_url: DB_URL,
    knowledge_tables: {} as Record<string, any>,
    jsonl_tables: {} as Record<string, any>,
    skipped_tables: SKIP_TABLES
  };
  
  for (const tableName of allTables) {
    if (SKIP_TABLES.includes(tableName)) {
      console.log(`⏭️  Skipping ${tableName} (in skip list)`);
      continue;
    }
    
    const isKnowledge = KNOWLEDGE_TABLES.includes(tableName);
    const outputDir = isKnowledge ? knowledgeDir : jsonlDir;
    
    console.log(`📦 Exporting ${tableName}...`);
    
    try {
      const dataRes = await db.query(`SELECT * FROM "${tableName}"`);
      const jsonl = dataRes.rows.map(row => JSON.stringify(row)).join('\n');
      
      const filename = `${outputDir}/${tableName.toLowerCase()}-export.jsonl`;
      writeFileSync(filename, jsonl);
      
      if (isKnowledge) {
        summary.knowledge_tables[tableName] = {
          row_count: dataRes.rows.length,
          columns: dataRes.rows.length > 0 ? Object.keys(dataRes.rows[0] as Record<string, unknown>) : [],
          file: `${tableName.toLowerCase()}-export.jsonl`
        };
      } else {
        summary.jsonl_tables[tableName] = {
          row_count: dataRes.rows.length,
          columns: dataRes.rows.length > 0 ? Object.keys(dataRes.rows[0] as Record<string, unknown>) : [],
          file: `${tableName.toLowerCase()}-export.jsonl`
        };
      }
      
      console.log(`✅ ${tableName}: ${dataRes.rows.length} rows → ${isKnowledge ? 'knowledge' : 'jsonl'}`);
    } catch (err) {
      console.log(`⚠️  ${tableName}: Skipped (error: ${(err as Error).message})`);
      if (isKnowledge) {
        summary.knowledge_tables[tableName] = {
          error: (err as Error).message,
          skipped: true
        };
      } else {
        summary.jsonl_tables[tableName] = {
          error: (err as Error).message,
          skipped: true
        };
      }
    }
  }
  
  await db.close();
  
  // Write summary
  writeFileSync('./export-summary.json', JSON.stringify(summary, null, 2));
  
  console.log('\n\n✅ All exports complete!');
  console.log(`📚 Knowledge exports: ${Object.keys(summary.knowledge_tables).length} tables`);
  console.log(`📄 JSONL exports: ${Object.keys(summary.jsonl_tables).length} tables`);
  console.log(`⏭️  Skipped: ${SKIP_TABLES.length} tables`);
  console.log(`📄 Summary written to export-summary.json`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
