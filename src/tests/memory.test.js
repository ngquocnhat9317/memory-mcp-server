import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { db } from '../db.js';
import { registerMemoryTools } from '../tools/memory.js';

class MockMcpServer {
  constructor() {
    this.tools = new Map();
  }
  registerTool(name, config, handler) {
    this.tools.set(name, { config, handler });
  }
  async callTool(name, params) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool ${name} not registered`);
    return await tool.handler(params);
  }
}

describe('Memory Tools Integration', () => {
  let server;

  beforeEach(() => {
    db.exec('DELETE FROM memories');
    db.exec('DELETE FROM memories_fts');
    server = new MockMcpServer();
    registerMemoryTools(server);
  });

  it('should save and retrieve a memory', async () => {
    const input = {
      content: 'User likes coffee',
      type: 'preference',
      tags: ['food', 'drink'],
      importance: 4
    };
    const result = await server.callTool('memory_save', input);
    assert.ok(result.content[0].text.includes('Memory saved with id mem_'));
    assert.strictEqual(result.structuredContent.content, input.content);
  });

  it('should search for memories using FTS', async () => {
    await server.callTool('memory_save', {
      content: 'The secret project is called Phoenix',
      type: 'fact'
    });

    const result = await server.callTool('memory_search', {
      query: 'Phoenix'
    });

    // Check if we got an error message instead of results
    if (result.isError) {
      assert.fail(`Tool returned error: ${result.content[0].text}`);
    }

    assert.ok(result.structuredContent && result.structuredContent.results, `Expected results in structuredContent, got: ${JSON.stringify(result.structuredContent)}`);
    assert.strictEqual(result.structuredContent.results.length, 1);
    assert.ok(result.structuredContent.results[0].content.includes('Phoenix'));
  });

  it('should list memories with filters', async () => {
    await server.callTool('memory_save', { content: 'Mem 1', importance: 5, tags: ['tag1'] });
    await server.callTool('memory_save', { content: 'Mem 2', importance: 2, tags: ['tag2'] });

    const result = await server.callTool('memory_list', {
      min_importance: 4
    });

    if (result.isError) {
      assert.fail(`Tool returned error: ${result.content[0].text}`);
    }

    assert.ok(result.structuredContent && result.structuredContent.results, `Expected results in structuredContent, got: ${JSON.stringify(result.structuredContent)}`);
    assert.strictEqual(result.structuredContent.results.length, 1);
    assert.strictEqual(result.structuredContent.results[0].content, 'Mem 1');
  });

  it('should update an existing memory', async () => {
    const saved = await server.callTool('memory_save', { content: 'Old content' });
    const id = saved.structuredContent.id;

    const updated = await server.callTool('memory_update', {
      id: id,
      content: 'New content'
    });

    assert.strictEqual(updated.structuredContent.content, 'New content');
  });

  it('should delete a memory', async () => {
    const saved = await server.callTool('memory_save', { content: 'To be deleted' });
    const id = saved.structuredContent.id;

    const result = await server.callTool('memory_delete', { id });
    assert.ok(result.content[0].text.includes('deleted'));

    const getResult = await server.callTool('memory_get', { id });
    assert.ok(getResult.content[0].text.includes('Error: Memory'));
  });
});
