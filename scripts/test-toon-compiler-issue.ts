#!/usr/bin/env bun
import { compileToToon } from "../src/bun/core/toon-compiler";

const fullInput = `thought: Latest actionable mention in Dtour asks whether the planner is fixed; answer honestly and briefly instead of claiming complete repair.
providers:
  - message_connector
actions[1]:
  name: send_message
  room: Dtour
text:
  code_text_start: b8e2e55d
  value: No — planner/tool-routing still needs work, but v0.4.0 shipped and I'm triaging the broken paths now.
  code_text_end: b8e2e55d
simple: true`;

const result = compileToToon(fullInput);
console.log(`source=${result.source} rewritten=${result.rewritten}`);
console.log(`inputLen=${fullInput.length} outputLen=${result.text.length}`);
console.log(`=== OUTPUT ===`);
console.log(result.text);
console.log(`=== END ===`);
