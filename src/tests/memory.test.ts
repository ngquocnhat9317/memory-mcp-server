import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db.js';
import { registerMemoryTools } from '../tools/memory.js';

const mockServer = {
  registerTool: vi.fn(),
};

describe('Memory Tools', () => {
  beforeEach(() => {
    db.exec('DELETE FROM memories');
    db.exec('DELETE FROM memories_fts');
  });

  it('should save and retrieve a memory', async () => {
    registerMemoryTools(mockServer as any);
    const saveCall = mockServer.registerTool.mock.calls.find(c => c[0] === 'memory_save');
    const actualSaveHandler = saveCall[2];

    const input = {
      content: 'User likes coffee',
      type: 'preference',
      tags: ['food', 'drink'],
      importance: 4
    };

    const result = await actualSaveHandler(input);
    
    expect(result.content[0].text).toContain('Memory saved with id mem_');
    const record = result.structuredContent;
    expect(record.content).toBe(input.content);
    expect(record.type).toBe(input.type);
    expect(record.importance).toBe(input.importance);
  });

  it('should search for memories using FTS', async () => {
    registerMemoryTools(mockServer as any);
    const saveHandler = mockServer.registerTool.mock.calls.find(c => c[0] === 'memory_save')[2];
    const searchHandler = mockServer.registerTool.mock.calls.find(c => c[0] === 'memory_search')[2];

    await saveHandler({
      content: 'The secret project is called Phoenix',
      type: 'fact'
    });

    const result = await searchHandler({
      query: 'Phoenix'
    });

    expect(result.structuredContent.results.length).toBe(1);
    expect(result.structuredContent.results[0].content).toContain('Phoenix');
  });

  it('should list memories with filters', async () => {
    registerMemoryTools(mockServer as any);
    const saveHandler = mockServer.registerTool.mock.calls.find(c => c[0] === 'memory_save')[2];
    const listHandler = mockServer.registerTool.mock.calls.find(c => c[0] === 'memory_list')[2];

    await saveHandler({ content: 'Mem 1', importance: 5, tags: ['tag1'] });
    await saveHandler({ content: 'Mem 2', importance: 2, tags: ['tag2'] });

    const result = await listHandler({
      min_importance: 4
    });

    expect(result.structuredContent.results.length).toBe(1);
    expect(result.structuredContent.results[0].content).toBe('Mem 1');
  });

  it('should update an existing memory', async () => {
    registerMemoryTools(mockServer as any);
    const saveHandler = mockServer.registerTool.mock.calls.find(c => c[0] === 'memory_save')[2];
    const updateHandler = mockServer.registerTool.mock.calls.find(c => c[0] === 'memory_update')[2];

    const saved = await saveHandler({ content: 'Old content' });
    const id = saved.structuredContent.id;

    const updated = await updateHandler({
      id: id,
      content: 'New content'
    });

    expect(updated.structuredContent.content).toBe('New content');
  });

  it('should delete a memory', async () => {
    registerMemoryTools(mockServer as any);
    const saveHandler = mockServer.registerTool.mock.calls.find(c => c[0] === 'memory_save')[2];
    const deleteHandler = mockServer.registerTool.mock.calls.find(c => c[0] === 'memory_delete')[2];

    const saved = await saveHandler({ content: 'To be deleted' });
    const id = saved.structuredContent.id;

    const result = await deleteHandler({ id });
    expect(result.content[0].text).toContain('deleted');

    const getHandler = mockServer.registerTool.mock.calls.find(c => c[0] === 'memory_get')[2];
    const getResult = await getHandler({ id });
    expect(getResult.content[0].text).toContain('Error: Memory');
  });
});
