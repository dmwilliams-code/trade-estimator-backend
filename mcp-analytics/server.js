// Separate Render web service from the main backend -- must never share a
// URL or a process with the public estimateEngine MCP server (that one is
// intended for the ChatGPT app / Anthropic directory; this one is not
// public). See CLAUDE.md for the deployed URL once live.

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { authMiddleware } = require('./auth');
const { registerTools } = require('./tools');

const PORT = process.env.PORT || 3002;

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    console.log('Server running without database -- all tool calls will fail until this reconnects.');
  }
}
connectDB();

const app = express();
app.use(helmet());
app.use(express.json());

const mcpRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// Unauthenticated, no data -- just connectivity status.
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mongoConnected: mongoose.connection.readyState === 1,
  });
});

function buildMcpServer() {
  const server = new McpServer({ name: 'estimateai-analytics', version: '1.0.0' });
  registerTools(server);
  return server;
}

// Stateless mode (spec section 10.1): every tool call is independent, no
// session state is required, so a fresh server + transport is created per
// request rather than tracked across calls.
async function handleMcpRequest(req, res) {
  const server = buildMcpServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] MCP request error:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}

app.post('/mcp', mcpRateLimiter, authMiddleware, handleMcpRequest);
app.post('/mcp/:token', mcpRateLimiter, authMiddleware, handleMcpRequest);

function methodNotAllowed(req, res) {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
}
app.get('/mcp', methodNotAllowed);
app.get('/mcp/:token', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);
app.delete('/mcp/:token', methodNotAllowed);

app.listen(PORT, () => {
  console.log(`estimateai-mcp-analytics listening on port ${PORT}`);
});
