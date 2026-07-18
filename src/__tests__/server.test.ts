import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INSTRUCTIONS } from "../server.js";

test("server exposes its instructions string to clients on initialize", async () => {
  const server = new McpServer(
    { name: "memory-mcp-server", version: "0.0.0" },
    { instructions: SERVER_INSTRUCTIONS }
  );
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
    assert.match(client.getInstructions() ?? "", /reasoning_start_session/);
  } finally {
    await client.close();
    await server.close();
  }
});
