#!/usr/bin/env bun

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';

const KNOWLEDGE_DIR = '/Users/home/eliza-db/knowledge-exports';
const OUTPUT_DIR = '/Users/home/eliza-db/agent-knowledge';

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

interface KnowledgeDoc {
  id: string;
  content: string;
  metadata: Record<string, any>;
  source: string;
}

function parseJSONL(filePath: string): any[] {
  const content = readFileSync(filePath, 'utf-8');
  return content.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}

function formatEntity(entity: any): string {
  const names = Array.isArray(entity.names) ? entity.names.join(', ') : entity.names;
  let doc = `ENTITY: ${names}\n`;
  doc += `ID: ${entity.id}\n`;
  if (entity.metadata && Object.keys(entity.metadata).length > 0) {
    doc += `Details: ${JSON.stringify(entity.metadata, null, 2)}\n`;
  }
  return doc;
}

function formatMemory(memory: any): string {
  let doc = `MEMORY [${memory.type}]\n`;
  doc += `ID: ${memory.id}\n`;
  if (memory.content) {
    const contentStr = typeof memory.content === 'string' ? memory.content : JSON.stringify(memory.content);
    doc += `Content: ${contentStr}\n`;
  }
  if (memory.entity_id) doc += `Entity: ${memory.entity_id}\n`;
  if (memory.room_id) doc += `Room: ${memory.room_id}\n`;
  if (memory.created_at) doc += `Created: ${memory.created_at}\n`;
  return doc;
}

function formatRelationship(rel: any): string {
  let doc = `RELATIONSHIP\n`;
  doc += `From: ${rel.source_entity_id}\n`;
  doc += `To: ${rel.target_entity_id}\n`;
  if (rel.tags && rel.tags.length > 0) doc += `Tags: ${rel.tags.join(', ')}\n`;
  if (rel.metadata && Object.keys(rel.metadata).length > 0) {
    doc += `Details: ${JSON.stringify(rel.metadata, null, 2)}\n`;
  }
  return doc;
}

function formatTask(task: any): string {
  let doc = `TASK: ${task.name}\n`;
  if (task.description) doc += `Description: ${task.description}\n`;
  if (task.tags && task.tags.length > 0) doc += `Tags: ${task.tags.join(', ')}\n`;
  if (task.metadata && Object.keys(task.metadata).length > 0) {
    doc += `Details: ${JSON.stringify(task.metadata, null, 2)}\n`;
  }
  return doc;
}

function formatFactCandidate(fact: any): string {
  let doc = `FACT CANDIDATE\n`;
  doc += `Entity: ${fact.entity_id}\n`;
  doc += `Type: ${fact.kind}\n`;
  doc += `Proposed: ${fact.proposed_text}\n`;
  doc += `Confidence: ${fact.confidence}\n`;
  doc += `Status: ${fact.status}\n`;
  return doc;
}

function formatTrajectory(traj: any): string {
  let doc = `TRAJECTORY: ${traj.id}\n`;
  doc += `Status: ${traj.status}\n`;
  doc += `Steps: ${traj.step_count}\n`;
  doc += `LLM Calls: ${traj.llm_call_count}\n`;
  doc += `Tokens: ${traj.total_prompt_tokens} prompt, ${traj.total_completion_tokens} completion\n`;
  if (traj.duration_ms) doc += `Duration: ${traj.duration_ms}ms\n`;
  return doc;
}

function formatComponent(comp: any): string {
  let doc = `COMPONENT: ${comp.type}\n`;
  doc += `Entity: ${comp.entity_id}\n`;
  if (comp.data && Object.keys(comp.data).length > 0) {
    const dataStr = typeof comp.data === 'string' ? comp.data : JSON.stringify(comp.data, null, 2);
    doc += `Data: ${dataStr.substring(0, 500)}${dataStr.length > 500 ? '...' : ''}\n`;
  }
  return doc;
}

async function main() {
  console.log('📚 Organizing knowledge for agent...\n');
  
  const summary = {
    organized_at: new Date().toISOString(),
    knowledge_docs: [] as any[]
  };
  
  // Process entities
  console.log('📝 Processing entities...');
  const entities = parseJSONL(`${KNOWLEDGE_DIR}/entities-export.jsonl`);
  const entityDocs = entities.map(e => ({
    id: e.id,
    content: formatEntity(e),
    metadata: { type: 'entity', ...e },
    source: 'entities'
  }));
  writeFileSync(`${OUTPUT_DIR}/entities.txt`, entityDocs.map(d => d.content).join('\n---\n\n'));
  summary.knowledge_docs.push({ type: 'entities', count: entityDocs.length });
  console.log(`✅ Entities: ${entityDocs.length} docs`);
  
  // Process entity identities
  console.log('📝 Processing entity identities...');
  const identities = parseJSONL(`${KNOWLEDGE_DIR}/entity_identities-export.jsonl`);
  const identityDocs = identities.map(i => ({
    id: i.id,
    content: `ENTITY IDENTITY: ${i.handle} on ${i.platform}\nEntity: ${i.entity_id}\nVerified: ${i.verified}\nConfidence: ${i.confidence}`,
    metadata: { type: 'entity_identity', ...i },
    source: 'entity_identities'
  }));
  writeFileSync(`${OUTPUT_DIR}/entity_identities.txt`, identityDocs.map(d => d.content).join('\n---\n\n'));
  summary.knowledge_docs.push({ type: 'entity_identities', count: identityDocs.length });
  console.log(`✅ Entity Identities: ${identityDocs.length} docs`);
  
  // Process relationships
  console.log('📝 Processing relationships...');
  const relationships = parseJSONL(`${KNOWLEDGE_DIR}/relationships-export.jsonl`);
  const relationshipDocs = relationships.map(r => ({
    id: r.id,
    content: formatRelationship(r),
    metadata: { type: 'relationship', ...r },
    source: 'relationships'
  }));
  writeFileSync(`${OUTPUT_DIR}/relationships.txt`, relationshipDocs.map(d => d.content).join('\n---\n\n'));
  summary.knowledge_docs.push({ type: 'relationships', count: relationshipDocs.length });
  console.log(`✅ Relationships: ${relationshipDocs.length} docs`);
  
  // Process tasks
  console.log('📝 Processing tasks...');
  const tasks = parseJSONL(`${KNOWLEDGE_DIR}/tasks-export.jsonl`);
  const taskDocs = tasks.map(t => ({
    id: t.id,
    content: formatTask(t),
    metadata: { type: 'task', ...t },
    source: 'tasks'
  }));
  writeFileSync(`${OUTPUT_DIR}/tasks.txt`, taskDocs.map(d => d.content).join('\n---\n\n'));
  summary.knowledge_docs.push({ type: 'tasks', count: taskDocs.length });
  console.log(`✅ Tasks: ${taskDocs.length} docs`);
  
  // Process fact candidates
  console.log('📝 Processing fact candidates...');
  const facts = parseJSONL(`${KNOWLEDGE_DIR}/fact_candidates-export.jsonl`);
  const factDocs = facts.map(f => ({
    id: f.id,
    content: formatFactCandidate(f),
    metadata: { type: 'fact_candidate', ...f },
    source: 'fact_candidates'
  }));
  writeFileSync(`${OUTPUT_DIR}/fact_candidates.txt`, factDocs.map(d => d.content).join('\n---\n\n'));
  summary.knowledge_docs.push({ type: 'fact_candidates', count: factDocs.length });
  console.log(`✅ Fact Candidates: ${factDocs.length} docs`);
  
  // Process trajectories (summary only due to size)
  console.log('📝 Processing trajectories...');
  const trajectories = parseJSONL(`${KNOWLEDGE_DIR}/trajectories-export.jsonl`);
  const trajectoryDocs = trajectories.map(t => ({
    id: t.id,
    content: formatTrajectory(t),
    metadata: { type: 'trajectory', ...t },
    source: 'trajectories'
  }));
  writeFileSync(`${OUTPUT_DIR}/trajectories.txt`, trajectoryDocs.map(d => d.content).join('\n---\n\n'));
  summary.knowledge_docs.push({ type: 'trajectories', count: trajectoryDocs.length });
  console.log(`✅ Trajectories: ${trajectoryDocs.length} docs`);
  
  // Process components (summary only due to size)
  console.log('📝 Processing components...');
  const components = parseJSONL(`${KNOWLEDGE_DIR}/components-export.jsonl`);
  const componentDocs = components.map(c => ({
    id: c.id,
    content: formatComponent(c),
    metadata: { type: 'component', ...c },
    source: 'components'
  }));
  writeFileSync(`${OUTPUT_DIR}/components.txt`, componentDocs.map(d => d.content).join('\n---\n\n'));
  summary.knowledge_docs.push({ type: 'components', count: componentDocs.length });
  console.log(`✅ Components: ${componentDocs.length} docs`);
  
  // Memories are too large for text format - keep as JSONL but note it
  console.log('📝 Memories (kept as JSONL due to size)...');
  summary.knowledge_docs.push({ type: 'memories', count: 16562, format: 'jsonl', file: 'memories-export.jsonl' });
  
  // Write summary
  writeFileSync(`${OUTPUT_DIR}/knowledge-summary.json`, JSON.stringify(summary, null, 2));
  
  console.log('\n✅ Knowledge organization complete!');
  console.log(`📁 Output directory: ${OUTPUT_DIR}`);
  console.log(`📚 Total knowledge types: ${summary.knowledge_docs.length}`);
  console.log('\n📄 Knowledge files:');
  console.log('  - entities.txt');
  console.log('  - entity_identities.txt');
  console.log('  - relationships.txt');
  console.log('  - tasks.txt');
  console.log('  - fact_candidates.txt');
  console.log('  - trajectories.txt');
  console.log('  - components.txt');
  console.log('  - memories-export.jsonl (original JSONL - too large for text)');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
